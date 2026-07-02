import { spawn } from 'node:child_process';

// Bambu H2/X1-class live-view camera hub.
//
// Bambu cameras (the LIVE555 RTSP-over-TLS server on port 322) only tolerate a
// couple of concurrent connections, so opening one ffmpeg per browser tab — and
// another per snapshot poll — quickly exhausts the camera and makes the feed
// flaky. This module follows the go2rtc/Bambuddy model instead: hold ONE
// persistent ffmpeg (one camera connection) per printer, fan its frames out to
// every live viewer, serve still snapshots from the same frames, and run a
// health-check supervisor that restarts the transcode when it stalls or dies.

const RTSP_PORT = 322;

// Supervisor / health-check tuning.
const SUPERVISOR_INTERVAL_MS = 4000;
const FRAME_STALL_MS = 12000; // no frame for this long while running → restart
const ONLINE_FRESH_MS = 10000; // a frame newer than this means the feed is "online"
const IDLE_SHUTDOWN_MS = 30000; // no viewers and no snapshot demand → stop ffmpeg
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 15000;
const SNAPSHOT_WAIT_MS = 12000;
const SNAPSHOT_FRESH_MS = 1500; // reuse the latest frame for a snapshot if this fresh
const MAX_FRAME_BYTES = 25 * 1024 * 1024; // sanity cap while parsing mpjpeg
const VIEWER_BOUNDARY = 'frame';

function buildRtspUrl(host, accessCode) {
  return `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:${RTSP_PORT}/streaming/live/1`;
}

// Low-latency ffmpeg: the codec params arrive in the RTSP SDP, so skip input
// buffering/analysis (otherwise the feed sits seconds behind and the lag grows),
// transcode H264 → MJPEG, and emit each frame as soon as it's decoded.
function ffmpegArgs(url) {
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-avioflags', 'direct',
    '-analyzeduration', '0',
    '-probesize', '32768',
    '-rtsp_transport', 'tcp',
    '-i', url,
    '-an',
    '-vsync', 'drop',
    // Cap output to 8 fps: a monitoring feed doesn't need the camera's native
    // frame rate, and halving/thirding it cuts the stream's steady-state
    // bandwidth proportionally for every viewer (and every snapshot poller
    // that keeps the transcode warm) with no visible loss for watching a print.
    '-vf', 'fps=8,scale=1280:-2',
    '-q:v', '6',
    '-f', 'mpjpeg',
    'pipe:1',
  ];
}

class CameraStream {
  constructor(printer) {
    this.id = printer.id;
    this.applyPrinter(printer);

    this.proc = null;
    this.status = 'idle'; // idle | starting | running | error
    this.lastError = null;
    this.startedAt = 0;
    this.lastFrameAt = 0;
    this.frames = 0;
    this.restarts = 0;

    this.lastFrame = null; // latest JPEG Buffer, reused for snapshots
    this.lastSnapshotAt = 0; // when a snapshot was last requested (keeps the feed warm)
    this.viewers = new Set(); // { res, busy }
    this.frameWaiters = []; // resolvers awaiting the next frame (snapshots)

    // mpjpeg parse state.
    this.parseBuf = Buffer.alloc(0);
    this.expecting = 'header';
    this.contentLength = 0;

    this.restartDelay = RESTART_BASE_MS;
    this.restartTimer = null;
    this.stderrTail = '';
    this.stopped = false;
  }

  applyPrinter(printer) {
    this.name = printer.name;
    this.host = printer.ipAddress;
    this.accessCode = (printer.apiKeyHeader || '').trim();
  }

  isDemanded() {
    return this.viewers.size > 0 || Date.now() - this.lastSnapshotAt < IDLE_SHUTDOWN_MS;
  }

  ensureRunning() {
    this.stopped = false;
    if (!this.proc && !this.restartTimer) {
      this.start();
    }
  }

  start() {
    if (this.proc) return;
    this.status = 'starting';
    this.parseBuf = Buffer.alloc(0);
    this.expecting = 'header';
    this.startedAt = Date.now();

    const proc = spawn('ffmpeg', ffmpegArgs(buildRtspUrl(this.host, this.accessCode)), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.on('data', (chunk) => this.ingest(chunk));
    proc.stdout.on('error', () => {});
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-500);
    });
    proc.on('error', (error) => {
      this.lastError = `ffmpeg failed to start: ${error.message}`;
      this.status = 'error';
    });
    proc.on('close', (code) => this.onClose(code));
  }

  onClose(code) {
    this.proc = null;
    if (code && code !== 255) {
      const detail = this.stderrTail.trim().split('\n').pop() || '';
      this.lastError = `ffmpeg exited ${code}${detail ? `: ${detail}` : ''}`;
    }
    if (this.stopped) {
      this.status = 'idle';
      return;
    }
    // Unexpected exit while still wanted — let the supervisor-style backoff
    // bring it back; if nothing wants it any more, go idle.
    this.status = 'error';
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.restartTimer || this.stopped) return;
    if (!this.isDemanded()) {
      this.status = 'idle';
      return;
    }
    this.restarts += 1;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped || !this.isDemanded()) {
        this.status = 'idle';
        return;
      }
      this.start();
    }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGKILL');
    }
    this.status = 'idle';
  }

  // Restart with fresh credentials/host (e.g. the access code changed). The
  // close handler reconnects using the already-updated host/accessCode.
  restartForConfigChange() {
    if (this.proc) {
      this.proc.kill('SIGKILL');
    }
  }

  // Incrementally parse ffmpeg's mpjpeg output (--frame / Content-length / body)
  // into discrete JPEG frames.
  ingest(chunk) {
    this.parseBuf = this.parseBuf.length ? Buffer.concat([this.parseBuf, chunk]) : chunk;

    for (;;) {
      if (this.expecting === 'header') {
        const idx = this.parseBuf.indexOf('\r\n\r\n');
        if (idx === -1) {
          // Don't let a malformed/garbage header grow the buffer without bound.
          if (this.parseBuf.length > 65536) {
            this.parseBuf = this.parseBuf.subarray(-4);
          }
          break;
        }
        const header = this.parseBuf.subarray(0, idx).toString('latin1');
        const match = /content-length:\s*(\d+)/i.exec(header);
        this.contentLength = match ? Number.parseInt(match[1], 10) : 0;
        this.parseBuf = this.parseBuf.subarray(idx + 4);
        this.expecting = 'body';
        if (!this.contentLength || this.contentLength > MAX_FRAME_BYTES) {
          // Implausible frame — resync rather than emit garbage.
          this.expecting = 'header';
          continue;
        }
      }

      if (this.expecting === 'body') {
        if (this.parseBuf.length < this.contentLength) break;
        const frame = Buffer.from(this.parseBuf.subarray(0, this.contentLength));
        this.parseBuf = this.parseBuf.subarray(this.contentLength);
        this.expecting = 'header';
        this.onFrame(frame);
      }
    }
  }

  onFrame(frame) {
    this.frames += 1;
    this.lastFrameAt = Date.now();
    this.lastFrame = frame;
    this.status = 'running';
    this.lastError = null;
    this.restartDelay = RESTART_BASE_MS; // healthy again — reset backoff

    if (this.frameWaiters.length) {
      const waiters = this.frameWaiters;
      this.frameWaiters = [];
      for (const resolve of waiters) resolve(frame);
    }

    if (this.viewers.size) {
      const head = Buffer.from(
        `--${VIEWER_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      );
      const tail = Buffer.from('\r\n');
      for (const viewer of this.viewers) {
        // Skip frames for a backed-up client so one slow viewer can't stall the
        // others or build up latency — it just gets the next frame it can take.
        if (viewer.busy) continue;
        viewer.res.write(head);
        viewer.res.write(frame);
        const ok = viewer.res.write(tail);
        if (!ok) {
          viewer.busy = true;
          viewer.res.once('drain', () => {
            viewer.busy = false;
          });
        }
      }
    }
  }

  addViewer(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${VIEWER_BOUNDARY}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    // Allow the stream to load inside a cross-origin (e.g. sandboxed Grafana)
    // <iframe>; the global Cross-Origin-Resource-Policy: same-origin would block it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const viewer = { res, busy: false };
    this.viewers.add(viewer);

    const remove = () => {
      this.viewers.delete(viewer);
    };
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);

    // Paint the most recent frame immediately so the viewer isn't staring at a
    // blank box until the next camera frame arrives.
    if (this.lastFrame) {
      res.write(
        `--${VIEWER_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.lastFrame.length}\r\n\r\n`,
      );
      res.write(this.lastFrame);
      res.write('\r\n');
    }

    this.ensureRunning();
  }

  getSnapshot() {
    this.lastSnapshotAt = Date.now();
    this.ensureRunning();

    if (this.lastFrame && Date.now() - this.lastFrameAt < SNAPSHOT_FRESH_MS) {
      return Promise.resolve(this.lastFrame);
    }

    return new Promise((resolve, reject) => {
      const onFrame = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((waiter) => waiter !== onFrame);
        reject(
          new Error(
            `camera produced no frame within ${SNAPSHOT_WAIT_MS}ms (${this.lastError || this.status}) — check LAN Mode Liveview`,
          ),
        );
      }, SNAPSHOT_WAIT_MS);
      if (timer.unref) timer.unref();
      this.frameWaiters.push(onFrame);
    });
  }

  // Periodic health check: restart a stalled feed, shut an idle one down.
  supervise() {
    const now = Date.now();
    if (this.proc && this.status === 'running' && now - this.lastFrameAt > FRAME_STALL_MS) {
      this.lastError = 'frame stall — restarting';
      this.proc.kill('SIGKILL'); // onClose() schedules the restart
      return;
    }
    if (this.proc && !this.isDemanded()) {
      this.stop();
    }
  }

  health() {
    const now = Date.now();
    return {
      printerId: this.id,
      name: this.name,
      status: this.status,
      online:
        this.status === 'running' && !!this.lastFrame && now - this.lastFrameAt < ONLINE_FRESH_MS,
      viewers: this.viewers.size,
      lastFrameAgeMs: this.lastFrameAt ? now - this.lastFrameAt : null,
      frames: this.frames,
      restarts: this.restarts,
      uptimeMs: this.proc && this.startedAt ? now - this.startedAt : 0,
      lastError: this.lastError,
    };
  }
}

const streams = new Map();
let supervisorTimer = null;

function ensureSupervisor() {
  if (supervisorTimer) return;
  supervisorTimer = setInterval(() => {
    for (const stream of streams.values()) {
      stream.supervise();
    }
  }, SUPERVISOR_INTERVAL_MS);
  if (supervisorTimer.unref) supervisorTimer.unref();
}

function getStream(printer) {
  let stream = streams.get(printer.id);
  if (!stream) {
    stream = new CameraStream(printer);
    streams.set(printer.id, stream);
  } else {
    const changed =
      stream.host !== printer.ipAddress ||
      stream.accessCode !== (printer.apiKeyHeader || '').trim();
    stream.applyPrinter(printer);
    if (changed && stream.proc) {
      stream.restartForConfigChange();
    }
  }
  ensureSupervisor();
  return stream;
}

export function addCameraViewer(printer, req, res) {
  getStream(printer).addViewer(req, res);
}

export function getCameraSnapshot(printer) {
  return getStream(printer).getSnapshot();
}

// Health snapshot for one printer's camera. Reports without starting a feed, so
// it's safe to poll from a status badge.
export function getCameraHealth(printerId) {
  const stream = streams.get(printerId);
  if (stream) return stream.health();
  return {
    printerId,
    status: 'idle',
    online: false,
    viewers: 0,
    lastFrameAgeMs: null,
    frames: 0,
    restarts: 0,
    uptimeMs: 0,
    lastError: null,
  };
}

export function getAllCameraHealth() {
  return Array.from(streams.values(), (stream) => stream.health());
}
