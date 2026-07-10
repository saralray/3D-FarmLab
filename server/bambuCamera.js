import { spawn } from 'node:child_process';
import { logger } from './logger.js';

// Printer live-view camera hub — AV1.
//
// Bambu H2/X1-class cameras (LIVE555 RTSP-over-TLS server on port 322) only
// tolerate a couple of concurrent connections, so opening one ffmpeg per
// browser tab quickly exhausts the camera and makes the feed flaky. This
// module follows the go2rtc/Bambuddy model: hold ONE persistent ffmpeg (one
// camera connection) per printer, encode to AV1 (fragmented MP4, playable via
// MediaSource Extensions), fan the fragments out to every live viewer, and run
// a health-check supervisor that restarts the transcode when it stalls or
// dies. Still snapshots are captured over a separate, short-lived ffmpeg
// invocation rather than piggybacking on the AV1 encode (decoding a JPEG back
// out of an AV1 bitstream server-side would be needless complexity).
//
// The Snapmaker U1 shares this hub too, but on a best-effort basis: we have no
// visibility into its native webcam protocol from this codebase (today it's a
// plain reverse proxy to the printer's own player), so this module *probes* a
// conventional mjpg-streamer/crowsnest-style MJPEG endpoint as ffmpeg's input.
// If that assumption is wrong for a given printer, the stream commits to
// `mode: 'native'` and stops trying — the caller (server/app.js) falls back to
// the existing native-proxy webcam path, and the frontend independently
// detects a failed AV1 fetch and does the same, so nothing regresses.

const RTSP_PORT = 322;

// AV1 encode tuning — env-tunable because real-time AV1 CPU cost across
// several concurrent printer feeds has no safe universal default; an operator
// can trade quality/CPU without a code change.
const AV1_PRESET = process.env.CAMERA_AV1_PRESET || '10';
const AV1_THREADS = process.env.CAMERA_AV1_THREADS || '2';
const AV1_CRF = process.env.CAMERA_AV1_CRF || '35';
const AV1_GOP = 8; // ~1s at the 8fps output below — bounds join/reconnect latency

// Supervisor / health-check tuning.
const SUPERVISOR_INTERVAL_MS = 4000;
const FRAGMENT_STALL_MS = 12000; // no fragment for this long while running → restart
const ONLINE_FRESH_MS = 10000; // a fragment newer than this means the feed is "online"
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 10000;
const SNAPSHOT_FRESH_MS = 1500; // reuse the latest snapshot capture if this fresh
const MAX_FRAGMENT_BYTES = 25 * 1024 * 1024; // sanity cap while parsing ISO-BMFF boxes
// Bound how much unsent AV1 data we'll hold for one slow viewer. Unlike MJPEG
// (where a whole frame can be safely dropped), fragmented-MP4 bytes must stay
// in order or the viewer's MSE SourceBuffer breaks — so instead of dropping
// bytes, disconnect a viewer whose backlog grows past this cap and let it
// reconnect fresh (new init segment).
const MAX_VIEWER_QUEUE_BYTES = 8 * 1024 * 1024;

// Snapmaker U1 AV1 probe tuning. We don't know the printer's native webcam
// protocol, so treat the assumed MJPEG endpoint as a probe: give it a few
// seconds to prove itself, and require a couple of consecutive failures
// (avoids flapping on one transient hiccup) before giving up for good.
const U1_PROBE_WINDOW_MS = 7000;
const U1_PROBE_MAX_FAILURES = 3;

function resolveKind(profile) {
  if (profile === 'bambulab_h2s' || profile === 'bambulab_h2d' || profile === 'bambulab_h2c') {
    return 'bambu';
  }
  if (profile === 'snapmaker_u1') {
    return 'u1';
  }
  throw new Error(`Unsupported camera-hub profile: ${profile}`);
}

function buildRtspUrl(host, accessCode) {
  return `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:${RTSP_PORT}/streaming/live/1`;
}

// The existing dashboard already assumes the U1 firmware serves a plain MJPEG
// multipart stream at this path — it's what the documented, unauthenticated
// camera/stream and /webcam/:id routes proxy straight through to today (see
// LIVE_MJPEG_PROFILES in server/app.js). Reuse that same endpoint as ffmpeg's
// probe input rather than guessing a different one; it's still an assumption
// (we can't confirm it from this codebase), but it's the best-grounded one
// available, since it's already relied on elsewhere.
function buildU1MjpegProbeUrl(url) {
  const base = (url || '').replace(/\/+$/, '');
  return `${base}/webcam/stream.mjpg`;
}

// Best-effort auth header for the probed U1 endpoint, mirroring
// server/app.js's parseHeaderString convention ("Name: value", or a bare
// value treated as X-Api-Key).
function ffmpegAuthHeaderArgs(apiKeyHeader) {
  const trimmed = (apiKeyHeader || '').trim();
  if (!trimmed) return [];
  const separatorIndex = trimmed.indexOf(':');
  const name = separatorIndex === -1 ? 'X-Api-Key' : trimmed.slice(0, separatorIndex).trim();
  const value = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1).trim();
  if (!name || !value) return [];
  return ['-headers', `${name}: ${value}\r\n`];
}

// Shared AV1 output: fragmented MP4 (CMAF-style) so any cached fragment is
// immediately usable by a newly-joining viewer (frag_keyframe ties each
// fragment to a keyframe) and MediaSource can append it directly
// (default_base_moof keeps fragments self-contained). libsvtav1 is used
// rather than libaom-av1 (too slow for real-time at any reasonable quality)
// or librav1e (less mature) — it's the encoder real-time AV1 deployments
// actually use. Verified present in the Dockerfile.web build (see its
// build-time libsvtav1 assertion).
function av1EncodeArgs() {
  return [
    '-an',
    '-vsync', 'drop',
    // Cap output to 8 fps/1280px wide: a monitoring feed doesn't need the
    // camera's native frame rate, and this keeps AV1 encode cost bounded
    // across multiple concurrent printer feeds.
    '-vf', 'fps=8,scale=1280:-2',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libsvtav1',
    '-preset', AV1_PRESET,
    '-svtav1-params', `lp=${AV1_THREADS}`,
    '-crf', AV1_CRF,
    '-g', String(AV1_GOP),
    '-keyint_min', String(AV1_GOP),
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    'pipe:1',
  ];
}

// Low-latency ffmpeg: the codec params arrive in the RTSP SDP, so skip input
// buffering/analysis (otherwise the feed sits seconds behind and the lag
// grows).
function bambuFfmpegArgs(url) {
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
    ...av1EncodeArgs(),
  ];
}

function u1FfmpegArgs(url, apiKeyHeader) {
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    ...ffmpegAuthHeaderArgs(apiKeyHeader),
    '-f', 'mjpeg',
    '-i', url,
    ...av1EncodeArgs(),
  ];
}

// Legacy MJPEG args, unchanged from the pre-AV1 hub. Kept only for the
// documented, still-supported camera/stream / /webcam/:id MJPEG contract (see
// streamLegacyMjpeg below) — the in-app live player uses AV1 exclusively.
function legacyMjpegFfmpegArgs(url) {
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
    '-vf', 'fps=8,scale=1280:-2',
    '-q:v', '6',
    '-f', 'mpjpeg',
    'pipe:1',
  ];
}

const LEGACY_MJPEG_BOUNDARY = 'frame';

// Serves the documented, `<img>`-embeddable MJPEG contract (camera/stream,
// /webcam/:id) for Bambu H2-series printers. The in-app player no longer uses
// this — it's AV1-only — so rather than multiplex a second encoder output off
// the persistent AV1 hub's single ffmpeg process, this spins up its own
// short-lived ffmpeg per connected legacy viewer (simplest correct option;
// revisit only if this path turns out to still be heavily used). One legacy
// viewer's slowness only ever affects its own connection.
export function streamLegacyMjpeg(printer, req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${LEGACY_MJPEG_BOUNDARY}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const proc = spawn(
    'ffmpeg',
    legacyMjpegFfmpegArgs(buildRtspUrl(printer.ipAddress, (printer.apiKeyHeader || '').trim())),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let parseBuf = Buffer.alloc(0);
  let expecting = 'header';
  let contentLength = 0;
  let busy = false;
  let stderrTail = '';
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-500);
  });
  proc.on('error', () => {
    if (!res.headersSent) sendJsonNotAvailable(res, 'ffmpeg failed to start');
  });
  proc.on('close', (code) => {
    if (!closed && code && code !== 255 && !res.writableEnded) {
      const detail = stderrTail.trim().split('\n').pop() || '';
      logger.error('legacy mjpeg capture failed', { printer: printer.name, code, detail });
    }
    res.end();
  });

  proc.stdout.on('data', (chunk) => {
    parseBuf = parseBuf.length ? Buffer.concat([parseBuf, chunk]) : chunk;
    for (;;) {
      if (expecting === 'header') {
        const idx = parseBuf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (parseBuf.length > 65536) parseBuf = parseBuf.subarray(-4);
          break;
        }
        const header = parseBuf.subarray(0, idx).toString('latin1');
        const match = /content-length:\s*(\d+)/i.exec(header);
        contentLength = match ? Number.parseInt(match[1], 10) : 0;
        parseBuf = parseBuf.subarray(idx + 4);
        expecting = 'body';
        if (!contentLength || contentLength > MAX_FRAGMENT_BYTES) {
          expecting = 'header';
          continue;
        }
      }
      if (expecting === 'body') {
        if (parseBuf.length < contentLength) break;
        const frame = Buffer.from(parseBuf.subarray(0, contentLength));
        parseBuf = parseBuf.subarray(contentLength);
        expecting = 'header';
        if (!busy) {
          res.write(`--${LEGACY_MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
          res.write(frame);
          const ok = res.write('\r\n');
          if (!ok) {
            busy = true;
            res.once('drain', () => {
              busy = false;
            });
          }
        }
      }
    }
  });
}

function sendJsonNotAvailable(res, message) {
  res.statusCode = 502;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

// Decoupled still-snapshot capture (Bambu H2 only — see getCameraSnapshot).
// Reuses the same RTSP input as the live AV1 encode but as its own short-lived
// process, so the live path never needs to decode AV1 back into a JPEG.
function captureJpegSnapshot(host, accessCode) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-analyzeduration', '0',
      '-probesize', '32768',
      '-rtsp_transport', 'tcp',
      '-i', buildRtspUrl(host, accessCode),
      '-frames:v', '1',
      '-q:v', '6',
      '-f', 'mjpeg',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    let stderrTail = '';
    let settled = false;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(
      () => finish(new Error(`camera produced no snapshot within ${SNAPSHOT_TIMEOUT_MS}ms — check LAN Mode Liveview`)),
      SNAPSHOT_TIMEOUT_MS,
    );
    if (timer.unref) timer.unref();

    proc.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk]);
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });
    proc.on('error', (error) => finish(new Error(`ffmpeg failed to start: ${error.message}`)));
    proc.on('close', (code) => {
      if (settled) return;
      if (out.length >= 3 && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff) {
        finish(null, out);
        return;
      }
      const detail = stderrTail.trim().split('\n').pop() || '';
      finish(new Error(detail ? `camera snapshot failed: ${detail}` : `camera snapshot failed (ffmpeg exited ${code})`));
    });
  });
}

class CameraStream {
  constructor(printer) {
    this.id = printer.id;
    this.kind = resolveKind(printer.profile);
    this.applyPrinter(printer);

    this.proc = null;
    this.status = 'idle'; // idle | starting | running | error
    this.lastError = null;
    this.startedAt = 0;
    this.lastFragmentAt = 0;
    this.fragments = 0;
    this.restarts = 0;

    // ISO-BMFF box parse state.
    this.buf = Buffer.alloc(0);
    this.initSegment = null; // cached ftyp+moov, sent once to every joining viewer
    this.initBuf = null;
    this.fragBuf = null; // accumulates one moof(+extra)+mdat fragment
    this.lastFragment = null; // most recent complete fragment, replayed to joiners

    this.viewers = new Set(); // { res, queue, queuedBytes, draining }

    // Snapmaker U1 only: probing | av1 | native. Bambu streams start (and
    // stay) at 'av1' — the RTSP input is already known-good, no probe needed.
    this.mode = this.kind === 'u1' ? 'probing' : 'av1';
    this.probeResolved = false;
    this.consecutiveProbeFailures = 0;
    this.fallbackReason = null;
    this.probeTimer = null;

    // Decoupled snapshot state (Bambu only).
    this.snapshotCache = null;
    this.snapshotInFlight = null;

    this.restartDelay = RESTART_BASE_MS;
    this.restartTimer = null;
    this.stderrTail = '';
    this.stopped = false;
  }

  applyPrinter(printer) {
    this.name = printer.name;
    this.host = printer.ipAddress;
    this.accessCode = (printer.apiKeyHeader || '').trim();
    this.url = printer.url || '';
    this.apiKeyHeader = printer.apiKeyHeader || '';
  }

  isDemanded() {
    return this.viewers.size > 0;
  }

  ensureRunning() {
    if (this.mode === 'native') return;
    this.stopped = false;
    if (!this.proc && !this.restartTimer) {
      this.start();
    }
  }

  start() {
    if (this.proc) return;
    this.status = 'starting';
    this.buf = Buffer.alloc(0);
    this.initSegment = null;
    this.initBuf = null;
    this.fragBuf = null;
    // A stale fragment from a previous ffmpeg session is meaningless without
    // its matching init segment (also just cleared) — drop it so a viewer
    // joining before the next fragment arrives doesn't get handed an
    // orphaned fragment with nothing to initialize its SourceBuffer.
    this.lastFragment = null;
    this.startedAt = Date.now();

    const args =
      this.kind === 'bambu'
        ? bambuFfmpegArgs(buildRtspUrl(this.host, this.accessCode))
        : u1FfmpegArgs(buildU1MjpegProbeUrl(this.url), this.apiKeyHeader);

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

    if (this.kind === 'u1' && this.mode === 'probing') {
      this.probeResolved = false;
      this.clearProbeTimer();
      this.probeTimer = setTimeout(
        () =>
          this.handleProbeResult(
            false,
            `no fragment produced within ${U1_PROBE_WINDOW_MS}ms — the assumed webcam endpoint may not exist on this printer`,
          ),
        U1_PROBE_WINDOW_MS,
      );
      if (this.probeTimer.unref) this.probeTimer.unref();
    }
  }

  clearProbeTimer() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  // Resolve one probe attempt. Safe to call from either the probe timeout or
  // a natural ffmpeg exit — `probeResolved` guards against double-counting
  // the same attempt from both paths.
  handleProbeResult(success, reason) {
    if (this.mode !== 'probing' || this.probeResolved) return;
    this.probeResolved = true;
    this.clearProbeTimer();

    if (success) {
      this.mode = 'av1';
      this.consecutiveProbeFailures = 0;
      this.fallbackReason = null;
      return;
    }

    this.consecutiveProbeFailures += 1;
    this.fallbackReason = reason;
    if (this.consecutiveProbeFailures >= U1_PROBE_MAX_FAILURES) {
      this.mode = 'native';
      this.disconnectViewers();
    }
    if (this.proc) this.proc.kill('SIGKILL');
  }

  // Disconnect any attached viewers so their fetch() reader errors and the
  // client reconnects (or, for a Snapmaker U1 that just gave up on AV1, falls
  // back to the native player) — rather than leaving them stuck on a
  // connection whose codec session is going away. Needed both when the AV1
  // assumption fails for good (U1 → native) and on any ordinary ffmpeg
  // restart: a fresh ffmpeg process produces a fresh init segment/codec
  // session that an already-attached viewer's MediaSource buffer can't
  // splice into.
  disconnectViewers() {
    for (const viewer of this.viewers) {
      viewer.res.destroy();
    }
    this.viewers.clear();
  }

  onClose(code) {
    this.proc = null;
    this.fragBuf = null;

    if (this.mode === 'native') {
      this.status = 'idle';
      return;
    }

    if (code && code !== 255) {
      const detail = this.stderrTail.trim().split('\n').pop() || '';
      this.lastError = `ffmpeg exited ${code}${detail ? `: ${detail}` : ''}`;
    }

    if (this.kind === 'u1' && this.mode === 'probing' && !this.probeResolved) {
      // ffmpeg exited on its own before we decided anything — that's a failure.
      this.handleProbeResult(false, this.lastError || `ffmpeg exited ${code} before the first fragment`);
      if (this.mode === 'native') {
        this.status = 'idle';
        return;
      }
    }

    if (this.stopped) {
      this.status = 'idle';
      return;
    }
    // Capture demand *before* disconnecting — disconnectViewers() empties
    // this.viewers, and a disconnected client is expected to reconnect
    // shortly (its fetch just aborted), so "no one wants this any more" must
    // be judged from who was watching a moment ago, not from the now-empty
    // set left behind by the disconnect that same tick.
    const hadViewers = this.isDemanded();
    // Unexpected exit while still wanted — disconnect any viewers (the next
    // attempt's init segment/codec session won't match what they already
    // have) and let the supervisor-style backoff bring the feed back; if
    // nothing wants it any more, go idle.
    this.disconnectViewers();
    this.status = 'error';
    this.scheduleRestart(hadViewers);
  }

  scheduleRestart(forceDemand = false) {
    if (this.restartTimer || this.stopped) return;
    if (this.mode === 'native' || (!forceDemand && !this.isDemanded())) {
      this.status = 'idle';
      return;
    }
    this.restarts += 1;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // By the time the backoff fires, judge by *live* demand: a
      // disconnected client is expected to have reconnected (a new viewer)
      // within the backoff window if it's still watching; if not, don't spin
      // ffmpeg back up for an abandoned tab.
      if (this.stopped || this.mode === 'native' || !this.isDemanded()) {
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
    this.clearProbeTimer();
    if (this.proc) {
      this.proc.kill('SIGKILL');
    }
    this.status = 'idle';
  }

  // Restart with fresh credentials/host (e.g. the access code changed). The
  // close handler reconnects using the already-updated host/accessCode/url.
  restartForConfigChange() {
    if (this.proc) {
      this.proc.kill('SIGKILL');
    }
  }

  // Incrementally parse ffmpeg's fragmented-MP4 stdout as a sequence of
  // ISO-BMFF boxes (4-byte size + 4-byte fourcc, with the 64-bit
  // extended-size case for size === 1).
  ingest(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    for (;;) {
      if (this.buf.length < 8) break;
      let size = this.buf.readUInt32BE(0);
      const type = this.buf.toString('latin1', 4, 8);
      let headerLen = 8;
      if (size === 1) {
        if (this.buf.length < 16) break;
        size = Number(this.buf.readBigUInt64BE(8));
        headerLen = 16;
      } else if (size === 0) {
        // A box with size 0 extends to end-of-file — not valid in a live
        // pipe. Treat as corruption and force a resync via restart.
        this.lastError = 'camera hub received an unsized ISO-BMFF box — restarting';
        if (this.proc) this.proc.kill('SIGKILL');
        return;
      }

      if (size < headerLen || size > MAX_FRAGMENT_BYTES) {
        this.lastError = `camera hub received an implausible box size (${size}) — restarting`;
        if (this.proc) this.proc.kill('SIGKILL');
        return;
      }
      if (this.buf.length < size) break;

      const box = Buffer.from(this.buf.subarray(0, size));
      this.buf = this.buf.subarray(size);
      this.onBox(type, box);
    }
  }

  onBox(type, box) {
    if (!this.initSegment) {
      // Still collecting the init segment (ftyp + moov, no samples thanks to
      // empty_moov) — cache it once and hand it to every joining viewer.
      this.initBuf = this.initBuf ? Buffer.concat([this.initBuf, box]) : box;
      if (type === 'moov') {
        this.initSegment = this.initBuf;
        this.initBuf = null;
      }
      return;
    }

    // Every subsequent top-level box belongs to the current fragment
    // (moof [+ any extra boxes] + mdat), one keyframe-aligned GOP at a time.
    this.fragBuf = this.fragBuf ? Buffer.concat([this.fragBuf, box]) : box;
    if (type === 'mdat') {
      const fragment = this.fragBuf;
      this.fragBuf = null;
      this.onFragment(fragment);
    }
  }

  onFragment(fragment) {
    this.fragments += 1;
    this.lastFragmentAt = Date.now();
    this.lastFragment = fragment;
    this.status = 'running';
    this.lastError = null;
    this.restartDelay = RESTART_BASE_MS; // healthy again — reset backoff

    if (this.kind === 'u1' && this.mode === 'probing' && !this.probeResolved) {
      this.handleProbeResult(true);
    }

    for (const viewer of this.viewers) {
      this.writeToViewer(viewer, fragment);
    }
  }

  addViewer(req, res) {
    if (this.mode === 'native') {
      // The AV1 assumption didn't pan out for this printer — fail fast so the
      // frontend can fall back to the native player with no added latency.
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: this.fallbackReason || 'AV1 stream not available for this printer' }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    // Allow the stream to load inside a cross-origin (e.g. sandboxed Grafana)
    // <iframe>, matching the rest of the webcam surface.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const viewer = { res, queue: [], queuedBytes: 0, draining: false };
    this.viewers.add(viewer);

    const remove = () => {
      this.viewers.delete(viewer);
    };
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);

    // Paint the init segment + most recent fragment immediately so the viewer
    // isn't staring at a blank box until the next GOP arrives.
    if (this.initSegment) res.write(this.initSegment);
    if (this.lastFragment) res.write(this.lastFragment);

    this.ensureRunning();
  }

  // Write in order; a slow viewer gets its bytes queued (never dropped —
  // dropping would corrupt its MSE buffer) up to a bounded backlog, past
  // which we disconnect it instead of letting the queue grow unbounded.
  writeToViewer(viewer, payload) {
    if (viewer.draining) {
      this.enqueueForViewer(viewer, payload);
      return;
    }
    const ok = viewer.res.write(payload);
    if (!ok) {
      viewer.draining = true;
      viewer.res.once('drain', () => this.flushViewerQueue(viewer));
    }
  }

  enqueueForViewer(viewer, payload) {
    viewer.queue.push(payload);
    viewer.queuedBytes += payload.length;
    if (viewer.queuedBytes > MAX_VIEWER_QUEUE_BYTES) {
      viewer.res.destroy();
      this.viewers.delete(viewer);
    }
  }

  flushViewerQueue(viewer) {
    viewer.draining = false;
    while (viewer.queue.length && !viewer.draining) {
      const next = viewer.queue[0];
      const ok = viewer.res.write(next);
      viewer.queue.shift();
      viewer.queuedBytes -= next.length;
      if (!ok) {
        viewer.draining = true;
        viewer.res.once('drain', () => this.flushViewerQueue(viewer));
      }
    }
  }

  // Decoupled still-snapshot capture (Bambu H2 only). A short-lived ffmpeg
  // invocation independent of the persistent AV1 encode — see the module
  // comment for why.
  getSnapshot() {
    if (this.kind !== 'bambu') {
      return Promise.reject(new Error('Snapshot capture is not supported for this camera'));
    }

    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_FRESH_MS) {
      return Promise.resolve(this.snapshotCache.buffer);
    }
    if (this.snapshotInFlight) return this.snapshotInFlight;

    this.snapshotInFlight = captureJpegSnapshot(this.host, this.accessCode)
      .then((buffer) => {
        this.snapshotCache = { buffer, at: Date.now() };
        return buffer;
      })
      .finally(() => {
        this.snapshotInFlight = null;
      });
    return this.snapshotInFlight;
  }

  // Periodic health check: restart a stalled feed, shut an idle one down.
  supervise() {
    if (this.mode === 'native') return; // committed to native fallback — nothing to supervise
    const now = Date.now();
    if (this.proc && this.status === 'running' && now - this.lastFragmentAt > FRAGMENT_STALL_MS) {
      this.lastError = 'fragment stall — restarting';
      this.proc.kill('SIGKILL'); // onClose() schedules the restart
      return;
    }
    if (this.proc && !this.isDemanded()) {
      this.stop();
    }
  }

  health() {
    const now = Date.now();
    const codec = this.mode === 'av1' ? 'av1' : this.mode === 'native' ? 'native' : 'unknown';
    return {
      printerId: this.id,
      name: this.name,
      status: this.status,
      online:
        this.status === 'running' && !!this.lastFragment && now - this.lastFragmentAt < ONLINE_FRESH_MS,
      viewers: this.viewers.size,
      lastFrameAgeMs: this.lastFragmentAt ? now - this.lastFragmentAt : null,
      frames: this.fragments,
      restarts: this.restarts,
      uptimeMs: this.proc && this.startedAt ? now - this.startedAt : 0,
      lastError: this.lastError,
      codec,
      fallbackReason: this.fallbackReason,
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
      stream.kind === 'bambu'
        ? stream.host !== printer.ipAddress || stream.accessCode !== (printer.apiKeyHeader || '').trim()
        : stream.url !== (printer.url || '') || stream.apiKeyHeader !== (printer.apiKeyHeader || '');
    stream.applyPrinter(printer);
    if (changed) {
      if (stream.mode === 'native') {
        // Config changed (e.g. a corrected URL) — give the AV1 probe a fresh
        // chance rather than staying committed to a stale failure.
        stream.mode = 'probing';
        stream.probeResolved = false;
        stream.consecutiveProbeFailures = 0;
        stream.fallbackReason = null;
      }
      if (stream.proc) stream.restartForConfigChange();
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

// Health snapshot for one printer's camera. Reports without starting a feed,
// so it's safe to poll from a status badge.
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
    codec: 'unknown',
    fallbackReason: null,
  };
}

export function getAllCameraHealth() {
  return Array.from(streams.values(), (stream) => stream.health());
}
