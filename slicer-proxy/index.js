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
//   - bambulab_h2s     → same Bambu LAN flow as the A1 Mini
//   - bambulab_h2d     → same Bambu LAN flow as the A1 Mini
//   - bambulab_h2c     → same Bambu LAN flow as the A1 Mini
// Generic printers have no upload API and are rejected.
//
// Connection secrets (IP, API key, access code, serial) are read from the DB
// inside this container and never echoed back to the slicer.

import { createHash } from 'node:crypto';
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
import { extractFilamentGramsFrom3mf } from './parse3mf.js';

const port = Number.parseInt(process.env.SLICER_PROXY_PORT || '8091', 10);
const host = process.env.HOST || '0.0.0.0';

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

// Read the multipart body and return the first part named "file".
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers });
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
      filename = info.filename || 'upload.gcode';
      stream.on('data', (chunk) => chunks.push(chunk));
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
  const form = new FormData();
  form.append('file', new Blob([file.buffer]), file.filename);
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

// Bambu LAN print flow (A1 Mini / H2S / H2D), modeled on the bambuddy project
// (maziggy/bambuddy, backend/app/services/{bambu_ftp,bambu_mqtt}.py).
//
// There is no HTTP upload. The sliced .3mf is pushed over implicit FTPS (port
// 990, user "bblp", password = LAN access code) to the *root* directory, then a
// `project_file` command is published over MQTT to start it. The print command
// references the file by name only — `url: ftp://<filename>` — so the file must
// live at the FTP root, not under a /cache or /mnt/sdcard path.
async function uploadToBambu(printer, file) {
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

  // Generous timeout: basic-ftp waits for the server's 226 "transfer complete"
  // before resolving, which confirms the file is flushed to the SD card. An H2D
  // can take 30+ s to send that 226 after the data channel closes; resolving the
  // print command before the file is fully written triggers SD read errors.
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
  } finally {
    ftp.close();
  }

  await publishBambuPrint(printer, serial, remoteName);

  // Record the slicer's filament estimate so the poller can show real per-job
  // usage. Bambu's MQTT report has no filament figure and H2 firmware blocks FTP
  // file access, so the .3mf we hold here is the only place this number exists.
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

function publishBambuPrint(printer, serial, remoteName) {
  // Unique per-submission identity. Bambu firmware (notably P1S 01.10) clamps
  // task identity fields to int32 max and treats a reused id as a continuation
  // of the prior job, so raw epoch-ms (13 digits) collides every time. Modulo
  // int32 keeps ids unique within a ~24-day window; `|| 1` guards the zero case
  // since task_id=0 is rejected. (bambuddy bambu_mqtt.py start_print)
  const submissionId = String((Date.now() % 2147483647) || 1);

  // project_file payload mirrors Bambu Studio / bambuddy. Notable fields:
  //   url: ftp://<name>  — file referenced by name at the FTP root (see upload)
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
      url: `ftp://${remoteName}`,
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

  const file = await parseUpload(req);
  if (!file || file.buffer.length === 0) {
    sendJson(res, 400, { error: 'No file part named "file" in the upload' });
    return;
  }

  if (printer.profile === 'snapmaker_u1') {
    await uploadToMoonraker(printer, file);
  } else if (
    printer.profile === 'bambulab_a1_mini' ||
    printer.profile === 'bambulab_h2s' ||
    printer.profile === 'bambulab_h2d' ||
    printer.profile === 'bambulab_h2c'
  ) {
    await uploadToBambu(printer, file);
  } else {
    sendJson(res, 415, { error: `Upload is not supported for printer profile "${printer.profile}"` });
    return;
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

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = requestUrl;

  if (pathname === '/' || pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
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

    // Connection handshake — slicers probe this before uploading.
    if (apiPath === '/api/version' && req.method === 'GET') {
      sendJson(res, 200, { api: '0.1', server: '1.9.0', text: 'OctoPrint 1.9.0' });
      return;
    }
    if ((apiPath === '/api/server' || apiPath === '/api/settings') && req.method === 'GET') {
      sendJson(res, 200, { version: '1.9.0', plugins: {} });
      return;
    }
    if (apiPath === '/api/files/local' && req.method === 'POST') {
      await handleUpload(req, res, printerId);
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
