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
//   - bambulab_a1_mini → FTPS upload of the .3mf + an MQTT project_file command
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
  touchSlicerApiKey,
} from '../server/postgres.js';

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

function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

// The slicer's "Device" tab loads the OctoPrint host base URL in an embedded
// browser. Point it at the dashboard's printer-management page, granting
// operator access (pause/resume/cancel) instead of a read-only viewer.
function buildDeviceUrl(req, printerId) {
  const base = appBaseUrl || defaultAppBase(req);
  const id = encodeURIComponent(printerId);
  return `${base.replace(/\/+$/, '')}/printer/${id}?slicer_access=operator`;
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

// Bambu A1 Mini: there is no HTTP upload. Push the .3mf over implicit FTPS (port
// 990, user "bblp", password = LAN access code) then publish a project_file
// command over MQTT to start it. NOTE: the exact project_file params and the
// file URL scheme are device-specific and need live tuning against the printer.
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
  const remoteName = file.filename.toLowerCase().endsWith('.3mf')
    ? file.filename
    : `${file.filename.replace(/\.[^.]+$/, '')}.3mf`;
  const checksum = md5(file.buffer);

  const ftp = new FtpClient(15000);
  try {
    await ftp.access({
      host: printer.ipAddress,
      port: 990,
      user: 'bblp',
      password: accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false },
    });
    await ftp.uploadFrom(Readable.from(file.buffer), remoteName);
  } finally {
    ftp.close();
  }

  await publishBambuPrint(printer, serial, remoteName, checksum);
}

function publishBambuPrint(printer, serial, remoteName, checksum) {
  const payload = {
    print: {
      sequence_id: String(Date.now() % 1000000),
      command: 'project_file',
      param: 'Metadata/plate_1.gcode',
      project_id: '0',
      profile_id: '0',
      task_id: '0',
      subtask_id: '0',
      subtask_name: remoteName.replace(/\.3mf$/i, ''),
      url: `file:///mnt/sdcard/${remoteName}`,
      md5: checksum,
      timelapse: false,
      bed_type: 'auto',
      bed_levelling: true,
      flow_cali: false,
      vibration_cali: true,
      layer_inspect: false,
      ams_mapping: '',
      use_ams: false,
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
  const key = await authenticate(req);
  if (!key) {
    sendJson(res, 401, { error: 'Invalid or missing API key' });
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
  } else if (printer.profile === 'bambulab_a1_mini') {
    await uploadToBambu(printer, file);
  } else {
    sendJson(res, 415, { error: `Upload is not supported for printer profile "${printer.profile}"` });
    return;
  }

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
