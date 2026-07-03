// Slicer-upload proxy.
//
// A standalone HTTP service that emulates just enough of the OctoPrint API for a
// slicer (Orca / PrusaSlicer / Cura, configured with host type "OctoPrint") to
// push a sliced file to one of the farm's printers and auto-start the print.
//
// The slicer points at a per-printer base URL — http://<host>:<port>/printers/<id>
// — and authenticates with a named API key (the "X-Api-Key" header). One key
// works for every printer; the printer is chosen by which base URL the slicer
// uploads to. Keys are minted/revoked from the dashboard (Settings → Slicer
// Upload) and only their sha256 hash is stored, so the proxy validates by
// hashing the presented key.
//
// Dispatch by printer profile:
//   - snapmaker_u1     → Moonraker HTTP upload (POST /server/files/upload, print=true)
//   - bambulab_a1_mini → FTPS upload of the .3mf to root + MQTT project_file (bambuddy flow)
//   - bambulab_h2s     → H2-series firmware rejects FTP writes (553, even at
//   - bambulab_h2d       root — confirmed live), so instead of FTP we stage the
//   - bambulab_h2c       file in memory and hand the printer a plain HTTP URL
//                        (served by this same proxy at /printers/_tmpfile/...)
//                        to fetch it from, then MQTT project_file as usual.
// Generic printers have no upload API and are rejected.
//
// Connection secrets (IP, API key, access code, serial) are read from the DB
// inside this container and never echoed back to the slicer.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import busboy from 'busboy';
import { Client as FtpClient } from 'basic-ftp';
import mqtt from 'mqtt';
import {
  findSlicerApiKeyByHash,
  getPrinterById,
  recordAuditLog,
  recordSlicerPrintEstimate,
  touchSlicerApiKey,
} from '../server/postgres.js';
import { mintSlicerGrant } from '../server/slicerGrant.js';
import { extractFilamentGramsFrom3mf, extractPlateGcodeFrom3mf } from './parse3mf.js';
import {
  buildFilamentManagerSelections,
  buildFilamentManagerSpools,
  buildSpoolManagerSpools,
  FILAMENT_PLUGIN_SETTINGS,
} from './filamentSync.js';
import { buildConnection, buildJob, buildPrinterState } from './octoprintDevice.js';

const port = Number.parseInt(process.env.SLICER_PROXY_PORT || '8091', 10);
const host = process.env.HOST || '0.0.0.0';

// C-4 FIX: cap the in-memory buffer for multipart file uploads. Without a limit,
// a large upload exhausts the Node.js heap. Default 500 MB (matching nginx cap).
const SLICER_UPLOAD_MAX_BYTES = Number.parseInt(
  process.env.SLICER_UPLOAD_MAX_BYTES || String(500 * 1024 * 1024),
  10,
);

// In-memory staging area for the HTTP-delivery Bambu upload path (see
// uploadToBambu): H2-series firmware rejects FTP writes even to root, so
// instead of staging the .3mf on the printer's own storage we hold it here and
// hand the printer a URL to fetch it from itself. Token -> { buffer, filename,
// expiresAt }. Swept on a timer rather than deleted on first GET, since a
// printer may re-request the file (retry, or a slow/paused fetch).
const TMP_FILE_TTL_MS = 20 * 60 * 1000;
const tmpFiles = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tmpFiles) {
    if (entry.expiresAt < now) tmpFiles.delete(token);
  }
}, 60 * 1000).unref();

function registerTmpFile(buffer, filename) {
  const token = randomBytes(16).toString('hex');
  tmpFiles.set(token, { buffer, filename, expiresAt: Date.now() + TMP_FILE_TTL_MS });
  return token;
}

// H-5 FIX: sanitize a client-supplied filename before using it as a remote FTP
// path. Strip directory components, null bytes, and characters that are unsafe in
// FTPS paths or that could confuse Bambu/Moonraker (only alphanum, dash, dot,
// underscore allowed). Falls back to a safe default when the result is empty.
function sanitizeUploadFilename(raw) {
  if (typeof raw !== 'string' || !raw) return 'upload.gcode';
  // Take only the basename (strip any leading path / .. traversal attempts).
  const base = raw.replace(/\\/g, '/').split('/').pop() || '';
  // Keep only safe characters; replace everything else with underscore.
  const safe = base.replace(/[^\w.\-]/g, '_').replace(/\.{2,}/g, '_');
  return safe || 'upload.gcode';
}

// Where the dashboard lives, for the slicer's "Device" tab redirect. Prefer an
// explicit APP_BASE_URL; otherwise reuse the request's hostname with the
// dashboard's HTTP_PORT (nginx), since the proxy is published on a sibling port.
const httpPort = process.env.HTTP_PORT || '8080';
const appBaseUrl = (process.env.APP_BASE_URL || '').trim();

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Best-effort client IP for the audit trail (nginx sets X-Forwarded-For).
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

// Append an audit entry without ever letting a logging failure break the upload.
function audit(entry) {
  recordAuditLog(entry).catch((error) => {
    console.error('Failed to record slicer audit log', error);
  });
}

// The slicer's "Device" tab loads the OctoPrint host base URL in an embedded
// browser. Point it at the dashboard's printer-management page, granting
// operator access (pause/resume/cancel) instead of a read-only viewer.
//
// The grant is carried as a short-lived, HMAC-signed token (never a constant
// flag), so the dashboard only promotes to operator after the web server
// verifies the signature. If no signing secret is configured we still redirect
// to the printer page, just without a grant — the user stays a viewer.
function buildDeviceUrl(req, printerId) {
  const base = appBaseUrl || defaultAppBase(req);
  const id = encodeURIComponent(printerId);
  const target = `${base.replace(/\/+$/, '')}/printer/${id}`;
  try {
    const token = mintSlicerGrant(printerId);
    return `${target}?slicer_grant=${encodeURIComponent(token)}`;
  } catch (error) {
    console.error('Slicer operator grant unavailable; redirecting without it', error);
    return target;
  }
}

function defaultAppBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();

  // Behind nginx (same domain as the dashboard) the forwarded host already
  // carries the right hostname and port, so the redirect stays on this origin.
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) {
    return `${proto}://${String(forwardedHost).split(',')[0].trim()}`;
  }

  // Direct hit on the proxy's own port: swap it for the dashboard's HTTP_PORT.
  const hostname = String(req.headers.host || `localhost:${port}`).split(':')[0];
  return `${proto}://${hostname}:${httpPort}`;
}

// Build the URL a printer on the LAN uses to fetch a staged file back from us
// (see registerTmpFile). Deliberately ignores APP_BASE_URL (that's meant for a
// browser/SSO callback and may be a public DNS name) and always uses the
// request's own host — the same LAN address the slicer used to reach the
// dashboard, which the printer (same network) can reach too — routed through
// nginx's existing /printers/ location.
function buildTmpFileUrl(req, token, filename) {
  const base = defaultAppBase(req).replace(/\/+$/, '');
  return `${base}/printers/_tmpfile/${token}/${encodeURIComponent(filename)}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// Pull the presented key from "X-Api-Key" or "Authorization: Bearer <key>".
function extractApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

async function authenticate(req) {
  const key = extractApiKey(req);
  if (!key) {
    return null;
  }
  const record = await findSlicerApiKeyByHash(hash(key));
  if (!record) {
    return null;
  }
  // Best-effort usage stamp; never block the upload on this.
  touchSlicerApiKey(record.id).catch((error) => {
    console.error('Failed to stamp slicer key usage', error);
  });
  return record;
}

// Gate an OctoPrint endpoint on a valid API key. OctoPrint answers its protected
// endpoints (incl. /api/version, which the slicer's "Test" button hits) with 403
// when the key is wrong or absent, and a slicer treats any non-2xx as "cannot
// connect". Mirror that so a bad key fails the test instead of silently passing.
// Returns the key record, or null after having sent the 403 response.
async function requireKey(req, res) {
  const key = await authenticate(req);
  if (!key) {
    sendJson(res, 403, { error: 'Invalid or missing API key' });
    return null;
  }
  return key;
}

// Read the multipart body and return the first part named "file".
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      // C-4 FIX: enforce per-file and total-body size limits so a large upload
      // cannot exhaust the Node.js heap. busboy truncates streams silently when
      // a limit is hit and sets the `truncated` flag on the stream info.
      bb = busboy({ headers: req.headers, limits: { fileSize: SLICER_UPLOAD_MAX_BYTES } });
    } catch (error) {
      reject(error);
      return;
    }

    let filename = null;
    const chunks = [];
    let captured = false;

    bb.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file' || captured) {
        stream.resume();
        return;
      }
      captured = true;
      filename = sanitizeUploadFilename(info.filename); // H-5: strip path traversal
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        // busboy hit the fileSize limit — drain and reject so the caller
        // returns a 413 rather than uploading a truncated file to the printer.
        stream.resume();
        reject(Object.assign(new Error('Upload exceeds maximum allowed size'), { code: 'LIMIT_FILE_SIZE' }));
      });
      stream.on('error', reject);
    });
    bb.on('error', reject);
    bb.on('close', () => {
      if (!captured) {
        resolve(null);
        return;
      }
      resolve({ filename, buffer: Buffer.concat(chunks) });
    });

    req.pipe(bb);
  });
}

// Snapmaker U1 speaks Moonraker: a multipart POST to /server/files/upload with a
// "print" form field auto-starts the job once the upload finishes.
async function uploadToMoonraker(printer, file) {
  // Klipper/Moonraker prints plain G-code. Slicers upload an Orca/Bambu .gcode.3mf
  // bundle, so unwrap the plate G-code (Metadata/plate_<n>.gcode) and send that.
  let uploadBuffer = file.buffer;
  let uploadName = file.filename;
  if (/\.3mf$/i.test(file.filename)) {
    const plate = extractPlateGcodeFrom3mf(file.buffer);
    if (!plate) {
      throw new Error('Could not find plate G-code inside the uploaded .3mf bundle');
    }
    uploadBuffer = plate.data;
    uploadName = file.filename.replace(/\.gcode\.3mf$/i, '.gcode').replace(/\.3mf$/i, '.gcode');
  }

  const form = new FormData();
  form.append('file', new Blob([uploadBuffer]), uploadName);
  form.append('print', 'true');

  const headers = {};
  const apiKey = (printer.apiKeyHeader || '').trim();
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  const response = await fetch(`${printer.url}/server/files/upload`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Moonraker upload failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

// Bambu LAN print flow (A1 Mini / H2S / H2D / H2C), modeled on the bambuddy
// project (maziggy/bambuddy, backend/app/services/{bambu_ftp,bambu_mqtt}.py).
//
// The A1 Mini accepts a plain FTPS (port 990, user "bblp", password = LAN
// access code) write to its root directory, so the .3mf is staged there and
// referenced as `url: ftp://<filename>`. The H2-series firmware does not: live
// testing against real H2S/H2D units showed an empty FTP root and a `553
// Could not create file` on every STOR attempt, root included — not a bad
// path, an FTP server with no writable storage exposed at all. So for the H2
// family we skip FTP entirely: the file is held here in memory
// (registerTmpFile) and the printer is told to fetch it itself over plain
// HTTP through this same proxy (`url: http://.../printers/_tmpfile/<token>/...`).
// Either way a `project_file` command is then published over MQTT to start it.
async function uploadToBambu(printer, file, req) {
  const accessCode = (printer.apiKeyHeader || '').trim();
  const serial = (printer.serial || '').trim();
  if (!accessCode) {
    throw new Error('Bambu printer is missing its LAN access code');
  }
  if (!serial) {
    throw new Error('Bambu printer is missing its serial number');
  }

  // Bambu's 3mf naming: keep the slicer's name but ensure a .3mf extension.
  // A sliced Orca/Studio export is "<name>.gcode.3mf", which already ends in
  // ".3mf" and is preserved as-is.
  const remoteName = file.filename.toLowerCase().endsWith('.3mf')
    ? file.filename
    : `${file.filename.replace(/\.[^.]+$/, '')}.3mf`;

  let fileUrl;
  if (printer.profile === 'bambulab_a1_mini') {
    // Generous timeout: basic-ftp waits for the server's 226 "transfer complete"
    // before resolving, which confirms the file is flushed to the SD card.
    //
    // The FTP and MQTT stages are wrapped separately so a failure says *which*
    // step broke: a failed STOR here vs. a rejected print command are different
    // fixes. The slicer surfaces this text verbatim, and handleUpload writes it
    // to the audit log.
    const ftp = new FtpClient(60000);
    try {
      await ftp.access({
        host: printer.ipAddress,
        port: 990,
        user: 'bblp',
        password: accessCode,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
      });
      // Upload to the root directory so `ftp://<filename>` resolves on the printer.
      await ftp.uploadFrom(Readable.from(file.buffer), remoteName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`FTP upload to ${printer.profile} failed: ${detail}`);
    } finally {
      ftp.close();
    }
    fileUrl = `ftp://${remoteName}`;
  } else {
    // H2S / H2D / H2C: stage the file here and let the printer pull it over HTTP.
    const token = registerTmpFile(file.buffer, remoteName);
    fileUrl = buildTmpFileUrl(req, token, remoteName);
  }

  try {
    await publishBambuPrint(printer, serial, remoteName, fileUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The file is already staged (SD card or our own temp store); only the
    // auto-start command failed.
    throw new Error(
      `File uploaded to ${printer.profile} but the print command failed: ${detail}`,
    );
  }

  // Record the slicer's filament estimate so the poller can show real per-job
  // usage. Bambu's MQTT report has no filament figure, and the poller can't
  // read it back off the printer either (H2 blocks FTP outright; the .3mf we
  // hold here is the only place this number exists for any Bambu profile).
  // Best-effort: a parse/DB failure must never fail an already-started print.
  try {
    const grams = extractFilamentGramsFrom3mf(file.buffer);
    if (grams && grams > 0) {
      await recordSlicerPrintEstimate({
        printerId: printer.id,
        jobName: bambuSubtaskName(remoteName),
        filamentGrams: grams,
      });
    }
  } catch (error) {
    console.error('Failed to record slicer filament estimate', error);
  }
}

// The job identity the printer reports back (and the poller keys on) is the file
// name with the slicer's .gcode.3mf / .3mf suffix stripped — see publishBambuPrint.
function bambuSubtaskName(remoteName) {
  return remoteName.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '');
}

function publishBambuPrint(printer, serial, remoteName, fileUrl) {
  // Unique per-submission identity. Bambu firmware (notably P1S 01.10) clamps
  // task identity fields to int32 max and treats a reused id as a continuation
  // of the prior job, so raw epoch-ms (13 digits) collides every time. Modulo
  // int32 keeps ids unique within a ~24-day window; `|| 1` guards the zero case
  // since task_id=0 is rejected. (bambuddy bambu_mqtt.py start_print)
  const submissionId = String((Date.now() % 2147483647) || 1);

  // project_file payload mirrors Bambu Studio / bambuddy. Notable fields:
  //   url: caller-supplied — ftp://<name> at the FTP root for the A1 Mini, or
  //                        an http(s) URL the printer fetches from us for the
  //                        H2 family (see uploadToBambu)
  //   md5: ""            — empty tells firmware to skip md5 validation; a wrong
  //                        digest can hard-fail the job, so we don't synthesize one
  //   use_ams: false     — a slicer push carries no AMS mapping; AMS-on with no
  //                        mapping fails with "Failed to get AMS mapping table"
  //   bed_leveling       — American spelling is what firmware reads (not "levelling")
  //   extrude_cali_flag 2 / nozzle_offset_cali 2 — "skip"; we don't drive calibration
  const subtaskName = bambuSubtaskName(remoteName);
  const payload = {
    print: {
      sequence_id: '20000',
      command: 'project_file',
      param: 'Metadata/plate_1.gcode',
      url: fileUrl,
      file: remoteName,
      md5: '',
      bed_type: 'auto',
      timelapse: false,
      bed_leveling: true,
      auto_bed_leveling: 1,
      flow_cali: false,
      vibration_cali: true,
      layer_inspect: false,
      use_ams: false,
      cfg: '0',
      extrude_cali_flag: 2,
      extrude_cali_manual_mode: 0,
      nozzle_offset_cali: 2,
      subtask_name: subtaskName,
      profile_id: '0',
      project_id: submissionId,
      subtask_id: submissionId,
      task_id: submissionId,
    },
  };

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${printer.ipAddress}:8883`, {
      username: 'bblp',
      password: (printer.apiKeyHeader || '').trim(),
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 4000,
    });

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('MQTT print command timed out')), 6000);

    client.once('error', fail);
    client.once('connect', () => {
      client.publish(`device/${serial}/request`, JSON.stringify(payload), { qos: 0 }, (error) => {
        if (error) return fail(error);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Graceful close so the queued packet flushes before the socket closes.
        client.end(false, {}, () => resolve());
      });
    });
  });
}

async function handleUpload(req, res, printerId) {
  const ip = getClientIp(req);
  const key = await authenticate(req);
  if (!key) {
    // Record rejected attempts so an admin can spot a misconfigured or abused key.
    audit({
      action: 'slicer.upload_rejected',
      target: printerId,
      details: { reason: 'invalid or missing API key' },
      source: 'slicer',
      ip,
    });
    sendJson(res, 401, { error: 'Invalid or missing API key' });
    return;
  }

  // The key must carry the 'slicer_upload' scope to push prints. Legacy keys
  // (created before scopes existed) backfill to all scopes, so they keep working.
  const permissions = Array.isArray(key.permissions) ? key.permissions : [];
  if (!permissions.includes('slicer_upload')) {
    audit({
      action: 'slicer.upload_rejected',
      target: printerId,
      details: { reason: "API key lacks the 'slicer_upload' permission", keyId: key.id },
      source: 'slicer',
      ip,
    });
    sendJson(res, 403, { error: "This API key lacks the 'slicer_upload' permission." });
    return;
  }

  const printer = await getPrinterById(printerId);
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return;
  }

  let file;
  try {
    file = await parseUpload(req);
  } catch (err) {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      sendJson(res, 413, { error: `Upload exceeds the ${SLICER_UPLOAD_MAX_BYTES} byte limit` });
      return;
    }
    throw err;
  }
  if (!file || file.buffer.length === 0) {
    sendJson(res, 400, { error: 'No file part named "file" in the upload' });
    return;
  }

  try {
    if (printer.profile === 'snapmaker_u1') {
      await uploadToMoonraker(printer, file);
    } else if (
      printer.profile === 'bambulab_a1_mini' ||
      printer.profile === 'bambulab_h2s' ||
      printer.profile === 'bambulab_h2d' ||
      printer.profile === 'bambulab_h2c'
    ) {
      await uploadToBambu(printer, file, req);
    } else {
      sendJson(res, 415, { error: `Upload is not supported for printer profile "${printer.profile}"` });
      return;
    }
  } catch (error) {
    // Record the exact failure (stage + profile, from uploadToBambu/uploadToMoonraker)
    // so an operator can diagnose a failed slicer push from the dashboard audit log,
    // then re-throw for the top-level handler to return it to the slicer.
    const detail = error instanceof Error ? error.message : String(error);
    audit({
      actorName: key.name,
      actorUsername: `slicer-key:${key.name}`,
      actorRole: 'operator',
      action: 'slicer.upload_failed',
      target: printer.name,
      details: { keyName: key.name, filename: file.filename, printerId: printer.id, profile: printer.profile, error: detail },
      source: 'slicer',
      ip,
    });
    throw error;
  }

  // A successful slicer upload counts as the key actor performing the print.
  audit({
    actorName: key.name,
    actorUsername: `slicer-key:${key.name}`,
    actorRole: 'operator',
    action: 'slicer.upload',
    target: printer.name,
    details: { keyName: key.name, filename: file.filename, printerId: printer.id, profile: printer.profile },
    source: 'slicer',
    ip,
  });

  // OctoPrint upload response shape, so the slicer reports success.
  sendJson(res, 201, { done: true, files: { local: { name: file.filename } } });
}

// OctoPrint device-page state paths the slicer polls to show "connected".
const DEVICE_STATE_PATHS = new Set(['/api/connection', '/api/printer', '/api/job']);

// Serve the printer's last-known state in OctoPrint's connection/printer/job
// shapes so the slicer's device page connects. Authenticated like the filament
// reads (any valid key, read-only, no connection secrets returned).
async function handleDeviceState(req, res, printerId, apiPath) {
  if (!(await requireKey(req, res))) return;

  const printer = await getPrinterById(printerId);
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return;
  }

  if (apiPath === '/api/connection') {
    sendJson(res, 200, buildConnection(printer));
  } else if (apiPath === '/api/printer') {
    sendJson(res, 200, buildPrinterState(printer));
  } else {
    sendJson(res, 200, buildJob(printer));
  }
}

// OctoPrint filament-plugin read paths the slicer hits when syncing filament.
const FILAMENT_SYNC_PATHS = new Set([
  '/plugin/filamentmanager/spools',
  '/plugin/filamentmanager/selections',
  '/plugin/SpoolManager/loadSpoolsByQuery',
]);

// Serve the printer's currently-loaded filament in the OctoPrint plugin shapes.
// Authenticated with the same API key as uploads (read-only; no scope required,
// no connection secrets returned), so the slicer's X-Api-Key reaches it.
async function handleFilamentSync(req, res, printerId, apiPath) {
  if (!(await requireKey(req, res))) return;

  const printer = await getPrinterById(printerId);
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return;
  }

  if (apiPath === '/plugin/filamentmanager/spools') {
    sendJson(res, 200, buildFilamentManagerSpools(printer));
  } else if (apiPath === '/plugin/filamentmanager/selections') {
    sendJson(res, 200, buildFilamentManagerSelections(printer));
  } else {
    sendJson(res, 200, buildSpoolManagerSpools(printer));
  }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = requestUrl;

  if (pathname === '/' || pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // H2-series HTTP delivery: the printer itself GETs the staged file back from
  // us (see registerTmpFile / uploadToBambu). Matched before the generic
  // per-printer route below so "_tmpfile" can never collide with a printer id.
  const tmpFileMatch = pathname.match(/^\/printers\/_tmpfile\/([0-9a-f]{32})\/[^/]+$/);
  if (tmpFileMatch && req.method === 'GET') {
    const entry = tmpFiles.get(tmpFileMatch[1]);
    if (!entry || entry.expiresAt < Date.now()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(entry.buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(entry.buffer);
    return;
  }

  // The slicer's "Device" tab opens the host base URL (/printers/<id> with no
  // further path). Redirect it to the dashboard's printer-management page.
  const deviceMatch = pathname.match(/^\/printers\/([^/]+)\/?$/);
  if (deviceMatch && req.method === 'GET') {
    const printerId = decodeURIComponent(deviceMatch[1]);
    res.statusCode = 302;
    res.setHeader('Location', buildDeviceUrl(req, printerId));
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }

  // Per-printer OctoPrint surface: /printers/<id>/...
  const match = pathname.match(/^\/printers\/([^/]+)\/(.+)$/);
  if (match) {
    const printerId = decodeURIComponent(match[1]);
    const apiPath = `/${match[2]}`;

    // Connection handshake — the slicer's "Test" button hits /api/version with
    // the X-Api-Key header. Validate the key (403 on wrong/missing) so a bad key
    // reports "cannot connect" rather than silently passing the test.
    if (apiPath === '/api/version' && req.method === 'GET') {
      if (!(await requireKey(req, res))) return;
      sendJson(res, 200, { api: '0.1', server: '1.9.0', text: 'OctoPrint 1.9.0' });
      return;
    }
    if (apiPath === '/api/server' && req.method === 'GET') {
      if (!(await requireKey(req, res))) return;
      sendJson(res, 200, { version: '1.9.0', plugins: {} });
      return;
    }
    // Advertise the filament plugins so the slicer offers a "sync filament" action.
    if (apiPath === '/api/settings' && req.method === 'GET') {
      if (!(await requireKey(req, res))) return;
      sendJson(res, 200, { version: '1.9.0', plugins: FILAMENT_PLUGIN_SETTINGS });
      return;
    }
    if (apiPath === '/api/files/local' && req.method === 'POST') {
      await handleUpload(req, res, printerId);
      return;
    }
    // A slicer's "Device" page issues a connect command before monitoring; we
    // have no serial link to manage, so just acknowledge it (firmware-managed).
    if (apiPath === '/api/connection' && req.method === 'POST') {
      res.statusCode = 204;
      res.end();
      return;
    }
    // Device-page state: connection / printer / job, synthesized from our DB so
    // the slicer shows the printer as connected instead of "cannot connect".
    if (req.method === 'GET' && DEVICE_STATE_PATHS.has(apiPath)) {
      await handleDeviceState(req, res, printerId, apiPath);
      return;
    }
    // Read-only filament-sync surface: serve the printer's currently-loaded AMS
    // spools in the OctoPrint filament-plugin shapes (FilamentManager / SpoolManager).
    if (req.method === 'GET' && FILAMENT_SYNC_PATHS.has(apiPath)) {
      await handleFilamentSync(req, res, printerId, apiPath);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Request failed' });
    } else {
      res.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`slicer-proxy listening on http://${host}:${port}`);
});
