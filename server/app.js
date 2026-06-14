import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import {
  createDiscordWebhook,
  createSlicerApiKey,
  deleteDiscordWebhook,
  deletePrinter,
  deleteQueueJob,
  deleteSlicerApiKey,
  ensureSchema,
  getAppSetting,
  getPrinterById,
  getPublicPrinterById,
  listDailyAnalytics,
  listDiscordWebhooks,
  listPrinters,
  listAuditLogs,
  listSlicerApiKeys,
  listQueueData,
  markQueueJobPrinted,
  recordAuditLog,
  resetDailyAnalytics,
  resetQueueJobs,
  setAppSetting,
  upsertPrinter,
  upsertQueueJobs,
} from './postgres.js';
import { verifySlicerGrant } from './slicerGrant.js';
import {
  addCameraViewer,
  getAllCameraHealth,
  getCameraHealth,
  getCameraSnapshot,
} from './bambuCamera.js';

// Bambu Lab printers share one LAN integration (MQTT status/commands, port-6000
// camera), so they're grouped rather than matched by a single model id.
const BAMBU_PROFILES = new Set(['bambulab_a1_mini', 'bambulab_h2s', 'bambulab_h2d']);

// The H2 series (like the X1) exposes its camera as an RTSP-over-TLS stream on
// port 322 (LIVE555 server, digest auth) — a different protocol from the A1/P1
// port-6000 length-prefixed JPEG socket — so its snapshots are grabbed via
// ffmpeg instead of captureBambuSnapshot.
const BAMBU_RTSP_PROFILES = new Set(['bambulab_h2s', 'bambulab_h2d']);

const PRINTER_CARD_LAYOUT_KEY = 'printer_card_layout';
const PRINTER_CARD_LAYOUT_PROFILES = new Set([
  'generic',
  'snapmaker_u1',
  'bambulab_a1_mini',
  'bambulab_h2s',
  'bambulab_h2d',
]);

// Analytics page grid layout: a single shared arrangement (admins drag/resize
// the cards) stored in app_settings, like the printer-detail card layout above.
const ANALYTICS_LAYOUT_KEY = 'analytics_layout';

// Google Sheet (queue feed) and Google Form (print-request) URLs. Configured by
// admins in Settings → Integrations and persisted in app_settings; they are
// empty until an admin sets them (no build-time/env defaults).
const INTEGRATION_URLS_KEY = 'integration_urls';

async function getIntegrationUrls() {
  const stored = (await getAppSetting(INTEGRATION_URLS_KEY)) || {};
  return {
    googleSheetQueueUrl: stored.googleSheetQueueUrl || '',
    googleFormUrl: stored.googleFormUrl || '',
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const port = Number.parseInt(process.env.PORT || '5173', 10);
const host = process.env.HOST || '0.0.0.0';
const maxBodyBytes = Number.parseInt(process.env.MAX_BODY_BYTES || String(1024 * 1024), 10);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// The admin bootstrap credential lives in app_settings (DB), not baked into the
// frontend bundle — it is set once through the website on first run. The stored
// value is { passwordHash: <sha256 hex> }; the plaintext is never sent or stored.
const ADMIN_CREDENTIAL_KEY = 'admin_credential';

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// Constant-time string compare so credential checks don't leak via timing.
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

// Best-effort client IP for the audit trail: prefer the first hop in
// X-Forwarded-For (nginx sets it) and fall back to the socket address.
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function sendJson(res, statusCode, payload, cacheControl = 'no-store') {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(payload));
}

function sendEmpty(res, statusCode = 204) {
  res.statusCode = statusCode;
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
}

function getGoogleSheetId(sheetUrl) {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) {
    throw new Error('Invalid Google Sheet URL');
  }

  return match[1];
}

function toGoogleSheetCsvUrl(sheetUrl) {
  return `https://docs.google.com/spreadsheets/d/${getGoogleSheetId(sheetUrl)}/gviz/tq?tqx=out:csv`;
}

function parseHeaderString(headerValue = '') {
  const separatorIndex = headerValue.indexOf(':');
  if (separatorIndex === -1) {
    const trimmedValue = headerValue.trim();
    return trimmedValue ? { 'X-API-Key': trimmedValue } : {};
  }

  const name = headerValue.slice(0, separatorIndex).trim();
  const value = headerValue.slice(separatorIndex + 1).trim();

  return name && value ? { [name]: value } : {};
}

function parseCsv(csvText) {
  const rows = [];
  let currentRow = [];
  let currentValue = '';
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        currentValue += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (character === ',' && !insideQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !insideQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      currentRow.push(currentValue);
      currentValue = '';

      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow);
      }

      currentRow = [];
      continue;
    }

    currentValue += character;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function normalizeSubmittedAt(value) {
  if (!value) return undefined;

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback.toISOString();
  }

  const [, month, day, year, hour, minute, second] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function buildQueueAddedEmbed(job) {
  const fields = [
    { name: 'Submitter', value: job.submitterName || 'Unknown', inline: true },
    { name: 'Numbers', value: String(job.fileCount ?? 1), inline: true },
  ];

  if (job.notes) {
    fields.push({ name: 'Notes', value: String(job.notes).slice(0, 1024), inline: false });
  }

  if (job.stlFileUrl) {
    fields.push({ name: 'File', value: job.stlFileUrl, inline: false });
  }

  return {
    title: 'New Queue Submission',
    description: job.filename || job.id,
    color: 0x3b82f6,
    fields,
    timestamp: new Date().toISOString(),
  };
}

// A webhook with events === null receives every event (historical default); an
// array restricts it to the listed event keys.
function webhookWantsEvent(webhook, eventKey) {
  if (webhook.enabled === false) {
    return false;
  }
  const { events } = webhook;
  if (!Array.isArray(events)) {
    return true;
  }
  return events.includes(eventKey);
}

async function sendQueueAddedNotifications(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  const webhooks = await listDiscordWebhooks();
  if (webhooks.length === 0) {
    return;
  }

  for (const job of jobs) {
    const embed = buildQueueAddedEmbed(job);
    await Promise.allSettled(
      webhooks
        .filter((webhook) => webhook.webhookUrl && webhookWantsEvent(webhook, 'queue_added'))
        .map((webhook) =>
          fetch(webhook.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: webhook.name || 'PrintFarm Bot',
              embeds: [embed],
            }),
          }).then((response) => {
            if (!response.ok) {
              throw new Error(`Discord webhook failed with ${response.status}`);
            }
          }),
        ),
    );
  }
}

function mapSheetRowsToQueue(rows) {
  return rows
    .slice(1)
    .map((row, index) => {
      const formType = row[4]?.trim();
      if (formType !== 'สั่งพิมพ์งาน 3D Print') {
        return null;
      }

      const submittedAt = normalizeSubmittedAt(row[0]?.trim());
      const studentId = row[1]?.trim();
      const firstName = row[2]?.trim();
      const lastName = row[3]?.trim();
      const course = row[5]?.trim();
      const notes = row[6]?.trim();
      const quantity = Number.parseInt(row[7]?.trim() || '1', 10);
      const fileUrl = row[8]?.trim();
      const submitterName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const fileLabel = fileUrl ? `Google Drive File ${index + 1}` : `Sheet Submission ${index + 1}`;
      const noteParts = [studentId ? `Student ID: ${studentId}` : '', course ? `Course: ${course}` : '', notes || '']
        .filter(Boolean);
      const estimatedTime = Math.max(30, Number.isFinite(quantity) ? quantity * 60 : 60);
      // Stable identity: a submission is uniquely keyed by its form timestamp and
      // student id. Editable fields (notes, quantity, file, name) are deliberately
      // excluded so editing a row in the sheet updates the existing job instead of
      // creating a duplicate — and never resurrects a soft-deleted one. Fall back
      // to the full-row hash only when both identity fields are missing.
      const idSource =
        submittedAt || studentId
          ? `${submittedAt ?? ''}|${studentId ?? ''}`
          : row.map((value) => value ?? '').join('|');
      const id = `queue-${createHash('sha1').update(idSource).digest('hex').slice(0, 16)}`;

      return {
        id,
        filename: fileLabel,
        fileCount: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        status: 'queued',
        progress: 0,
        estimatedTime,
        timeRemaining: estimatedTime,
        filamentUsed: 0,
        priority: quantity >= 3 ? 'high' : quantity >= 2 ? 'medium' : 'low',
        stlFileUrl: fileUrl || undefined,
        submitterName: submitterName || studentId || `Submission ${index + 1}`,
        notes: noteParts.join(' | ') || undefined,
        submittedAt,
        formType,
        printedStatus: 0,
      };
    })
    .filter((job) => job && (job.stlFileUrl || job.submitterName));
}

// Bambu printers have no HTTP control API; pause/resume/cancel and the chamber
// light are MQTT commands published to device/<serial>/request. We open a
// short-lived publish-only connection (no subscribe), which coexists with the
// poller's connection.
const BAMBU_PRINT_ACTIONS = { pause: 'pause', resume: 'resume', cancel: 'stop' };

// Map a heater target to the M-code Bambu accepts over `gcode_line`.
function buildBambuTemperatureGcode(heater, target, nozzleIndex = 0) {
  const value = Math.round(Number(target));
  if (!Number.isFinite(value) || value < 0 || value > 350) {
    throw new Error('Temperature target is out of range');
  }
  if (heater === 'nozzle') {
    const tool = Number(nozzleIndex) > 0 ? ` T${Number(nozzleIndex)}` : '';
    return `M104${tool} S${value}\n`;
  }
  if (heater === 'bed') {
    return `M140 S${value}\n`;
  }
  if (heater === 'chamber') {
    // The H2 chamber heater is driven by M141; a valid target is 0–60 °C
    // (0 turns active chamber heating off).
    if (value > 60) {
      throw new Error('Chamber temperature target is out of range');
    }
    return `M141 S${value}\n`;
  }
  throw new Error(`Unsupported heater: ${heater}`);
}

// Motion control posts raw G-code, but only a safe motion subset is honored
// over this endpoint — never heater or firmware-config commands, so a stray or
// hostile request can't drive the hotend or flash the board.
const ALLOWED_MOTION_GCODE = /^(?:G0|G1|G28|G90|G91|M84|M18)\b/i;

function sanitizeMotionGcode(gcode) {
  if (typeof gcode !== 'string') {
    throw new Error('gcode must be a string');
  }
  const lines = gcode
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 8) {
    throw new Error('gcode must contain between 1 and 8 commands');
  }
  for (const line of lines) {
    if (!ALLOWED_MOTION_GCODE.test(line)) {
      throw new Error(`Disallowed motion command: ${line}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// One `system` ledctrl message for a single LED node.
function buildBambuLedPayload(node, on, sequenceId) {
  return {
    system: {
      sequence_id: sequenceId,
      command: 'ledctrl',
      led_node: node,
      led_mode: on ? 'on' : 'off',
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 0,
      interval_time: 0,
    },
  };
}

// The H2 series lights its chamber with two LED bars, each its own ledctrl node,
// so one toggle has to drive both. Other Bambu models only expose chamber_light.
const BAMBU_LIGHT_NODES = {
  bambulab_h2s: ['chamber_light', 'chamber_light2'],
  bambulab_h2d: ['chamber_light', 'chamber_light2'],
};

function bambuLightNodes(profile) {
  return BAMBU_LIGHT_NODES[profile] ?? ['chamber_light'];
}

// Print actions go under `print`; the chamber light is a `system` ledctrl
// message. Light commands may return several payloads (one per LED node).
function buildBambuCommandPayload(command, params = {}, profile) {
  const sequenceId = String(Date.now() % 1000000);

  if (command === 'light_on' || command === 'light_off') {
    const on = command === 'light_on';
    return bambuLightNodes(profile).map((node, index) =>
      // Distinct sequence ids so the printer doesn't dedupe the second message.
      buildBambuLedPayload(node, on, String((Date.now() + index) % 1000000)),
    );
  }

  if (command === 'set_temperature') {
    return {
      print: {
        command: 'gcode_line',
        param: buildBambuTemperatureGcode(params.heater, params.target, params.nozzleIndex),
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'gcode') {
    return {
      print: {
        command: 'gcode_line',
        param: sanitizeMotionGcode(params.gcode),
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'set_fan') {
    // Bambu addresses its fans by M106 P-index: P1 part cooling, P2 auxiliary,
    // P3 chamber. Speed is an 8-bit PWM value (0 = off).
    const port = Number(params.fanPort);
    const speed = Math.round(Number(params.speed));
    if (!Number.isInteger(port) || port < 1 || port > 3) {
      throw new Error('Fan port is out of range');
    }
    if (!Number.isFinite(speed) || speed < 0 || speed > 255) {
      throw new Error('Fan speed is out of range');
    }
    return {
      print: {
        command: 'gcode_line',
        param: `M106 P${port} S${speed}\n`,
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'set_airduct') {
    // The H2 series routes chamber air through a mode-based "air duct" system
    // rather than an individually-addressable filter fan, so the activated-carbon
    // filter is engaged by selecting a mode, not by spinning a fan. Bambu Studio
    // sets it with a `set_airduct` MQTT command. Modes (from BambuStudio's
    // AIR_DUCT enum): 0 cooling+filter, 1 heating+filter, 2 exhaust, 3 full
    // cooling. `submode` defaults to -1, matching Studio.
    const modeId = Number(params.modeId);
    if (!Number.isInteger(modeId) || modeId < 0 || modeId > 3) {
      throw new Error('Air duct mode is out of range');
    }
    const submode = params.submode === undefined ? -1 : Number(params.submode);
    if (!Number.isInteger(submode)) {
      throw new Error('Air duct submode must be an integer');
    }
    return {
      print: {
        command: 'set_airduct',
        modeId,
        submode,
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'load_filament' || command === 'unload_filament') {
    // ams_change_filament: `target` is the global tray id (AMS unit * 4 + tray,
    // or 254 for the external spool). 255 tells the printer to unload whatever
    // is currently loaded. `tar_temp` preheats the hotend for the swap; the
    // printer applies its own filament profile when handed 0.
    const isUnload = command === 'unload_filament';
    const target = isUnload ? 255 : Number(params.trayId);
    if (!Number.isFinite(target) || target < 0 || target > 255) {
      throw new Error('Filament tray target is out of range');
    }
    const tarTemp = isUnload ? 0 : Math.round(Number(params.target) || 220);
    return {
      print: {
        command: 'ams_change_filament',
        target,
        curr_temp: 0,
        tar_temp: tarTemp,
        sequence_id: sequenceId,
      },
    };
  }

  const action = BAMBU_PRINT_ACTIONS[command];
  if (!action) {
    throw new Error(`Unsupported command: ${command}`);
  }
  const printCommand = { command: action, sequence_id: sequenceId };
  if (action === 'stop') {
    printCommand.param = '';
  }
  return { print: printCommand };
}

function sendBambuCommand(printer, command, params) {
  // A command may expand to several MQTT messages (e.g. one per LED node).
  const payloads = [].concat(buildBambuCommandPayload(command, params, printer.profile));
  const serial = (printer.serial || '').trim();
  if (!serial) {
    throw new Error('Bambu printer is missing its serial number');
  }

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
    const timer = setTimeout(() => fail(new Error('MQTT command timed out')), 6000);

    client.once('error', fail);
    client.once('connect', () => {
      // QoS 0 (the printer's broker isn't guaranteed to PUBACK on this topic, and
      // the poller already proves request-topic commands are honored). The fix for
      // the original dropped command is the graceful close below, not the QoS.
      const topic = `device/${serial}/request`;
      let remaining = payloads.length;
      let firstError = null;
      payloads.forEach((payload) => {
        client.publish(topic, JSON.stringify(payload), { qos: 0 }, (error) => {
          if (error && !firstError) firstError = error;
          remaining -= 1;
          if (remaining > 0 || settled) return;
          if (firstError) return fail(firstError);
          settled = true;
          clearTimeout(timer);
          // Close gracefully so the queued packets are flushed to the socket
          // before it closes — a force close here can drop commands in transit.
          client.end(false, {}, () => resolve());
        });
      });
    });
  });
}

// The A1 Mini has no HTTP webcam; its chamber camera is a length-prefixed JPEG
// stream over a raw TLS socket on port 6000 (auth: user "bblp" + LAN access
// code, same code stored in api_key_header). We connect, read one frame, and
// return it as a snapshot — the printer must have "LAN Mode Liveview" enabled.
const BAMBU_CAMERA_PORT = 6000;

// The A1 Mini's camera is slow — a single ~150 KB frame can take ~5 s to stream
// over the TLS socket — so the default timeout is generous. The H2 series, by
// contrast, rejects the request with a tiny non-JPEG status frame (validated
// below) rather than streaming, so it fails fast regardless.
function captureBambuSnapshot(host, accessCode, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // 80-byte auth packet: 16-byte header, then "bblp" and the access code,
    // each null-padded to 32 bytes.
    const auth = Buffer.alloc(80);
    auth.writeUInt32LE(0x40, 0);
    auth.writeUInt32LE(0x3000, 4);
    auth.write('bblp', 16, 'ascii');
    auth.write(accessCode, 48, 'ascii');

    const socket = tls.connect(
      { host, port: BAMBU_CAMERA_PORT, rejectUnauthorized: false },
      () => socket.write(auth),
    );

    let buffer = Buffer.alloc(0);
    let payloadSize = null;
    let settled = false;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Bambu camera timed out')), timeoutMs);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Each frame starts with a 16-byte header whose first uint32 is the JPEG
      // payload length; the JPEG bytes follow.
      if (payloadSize === null) {
        if (buffer.length < 16) return;
        payloadSize = buffer.readUInt32LE(0);
        buffer = buffer.subarray(16);
        // The H2 series rejects the camera request with a tiny status frame
        // (observed: an 8-byte 0xffffffff payload) instead of a JPEG. A real
        // frame is ~100 KB+, so an implausible length means the camera isn't
        // serving us an image — usually LAN Mode Liveview is off.
        if (payloadSize < 1024 || payloadSize > 20 * 1024 * 1024) {
          finish(
            new Error(
              `Bambu camera returned a non-image frame (${payloadSize} bytes) — enable LAN Mode Liveview on the printer`,
            ),
          );
          return;
        }
      }
      if (buffer.length >= payloadSize) {
        const frame = Buffer.from(buffer.subarray(0, payloadSize));
        // Sanity-check the JPEG magic (FF D8 FF); anything else is an error frame
        // we shouldn't pass off to the browser as an image.
        if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff) {
          finish(new Error('Bambu camera frame was not a JPEG'));
          return;
        }
        finish(null, frame);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Bambu camera closed before a frame arrived')));
  });
}

// H2/X1-class cameras (RTSP-over-TLS, port 322) are served by the camera hub
// (server/bambuCamera.js): one persistent ffmpeg per printer, fanned out to all
// viewers and reused for snapshots, with a health-check supervisor. The A1/P1
// port-6000 JPEG socket stays on captureBambuSnapshot below.

async function handleBambuWebcam(req, res, printer, pathParts) {
  // H2/X1-class printers (RTSP) can stream live MJPEG; the A1/P1 port-6000
  // camera is snapshot-only.
  if (pathParts[0] === 'stream.mjpg' && BAMBU_RTSP_PROFILES.has(printer.profile)) {
    addCameraViewer(printer, req, res);
    return;
  }
  if (pathParts[0] !== 'snapshot.jpg') {
    sendJson(res, 404, { error: 'Unsupported Bambu camera path' });
    return;
  }
  try {
    // H2/X1-class cameras are RTSP-over-TLS (served from the shared hub feed);
    // A1/P1 are the port-6000 JPEG socket.
    const jpeg = BAMBU_RTSP_PROFILES.has(printer.profile)
      ? await getCameraSnapshot(printer)
      : await captureBambuSnapshot(printer.ipAddress, (printer.apiKeyHeader || '').trim());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    // Allow the snapshot to load inside a cross-origin (e.g. sandboxed Grafana)
    // <iframe> — see the note in the /__printer_webcam stream branch.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(jpeg);
  } catch (error) {
    // A failed capture is non-fatal for the UI (it just shows "Webcam offline"),
    // but the <img> swallows the 502 body — so log the real cause server-side
    // (visible via `docker compose logs web`) to diagnose camera issues.
    const message = error instanceof Error ? error.message : 'Bambu camera unavailable';
    console.error(
      `bambu camera capture failed (${printer.profile} ${printer.name} @ ${printer.ipAddress}): ${message}`,
    );
    sendJson(res, 502, { error: message });
  }
}

// Self-contained webcam player page, embeddable in an <iframe src="/webcam/:id">
// on any site (e.g. a signage screen or a wiki). The page itself is profile-aware
// and pulls frames from the existing same-origin /__printer_webcam/:id endpoints:
// printers with a live MJPEG stream (Snapmaker U1, Bambu H2 series) render it in
// an <img>; everything else falls back to an auto-refreshing snapshot.
const LIVE_MJPEG_PROFILES = new Set(['snapmaker_u1', 'bambulab_h2s', 'bambulab_h2d']);

async function handleWebcamPage(req, res, requestUrl) {
  const match = requestUrl.pathname.match(/^\/webcam\/([^/]+)\/?$/);
  if (!match) {
    return false;
  }

  const printerId = decodeURIComponent(match[1]);
  const printer = await getPrinterById(printerId);
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return true;
  }

  const live = LIVE_MJPEG_PROFILES.has(printer.profile);
  const base = `/__printer_webcam/${encodeURIComponent(printer.id)}`;
  const streamUrl = live ? `${base}/stream.mjpg` : `${base}/snapshot.jpg`;
  const title = `${printer.name} webcam`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #cam { width: 100%; height: 100%; object-fit: contain; display: block; }
</style>
</head>
<body>
<img id="cam" alt="${escapeHtml(title)}" src="${escapeHtml(streamUrl)}" />
<script>
  (function () {
    var img = document.getElementById('cam');
    var live = ${live ? 'true' : 'false'};
    var src = ${JSON.stringify(streamUrl)};
    if (live) {
      // The MJPEG stream can drop if the printer/camera hiccups; reconnect on error.
      img.addEventListener('error', function () {
        setTimeout(function () { img.src = src + '?t=' + Date.now(); }, 2000);
      });
    } else {
      // Snapshot-only camera: poll a fresh frame on a timer (cache-busted).
      setInterval(function () { img.src = src + '?t=' + Date.now(); }, 1000);
    }
  })();
</script>
</body>
</html>`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // This page is meant to be embedded cross-origin in an <iframe> (e.g. a Grafana
  // text panel), so relax the global X-Frame-Options: DENY and the same-origin
  // Cross-Origin-Resource-Policy. The frames themselves come from the
  // /__printer_webcam endpoints, so no printer secrets are exposed to the embedder.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end(html);
  return true;
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, 'no-store');
    return true;
  }

  if (requestUrl.pathname === '/api/printers') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listPrinters());
      return true;
    }
    if (req.method === 'POST') {
      await upsertPrinter(await readJsonBody(req));
      sendEmpty(res);
      return true;
    }
  }

  if (
    requestUrl.pathname.startsWith('/api/printers/') &&
    requestUrl.pathname.endsWith('/command') &&
    req.method === 'POST'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/printers/'.length, -'/command'.length),
    );
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    const { command, heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode } =
      await readJsonBody(req);
    await sendBambuCommand(printer, command, {
      heater,
      target,
      nozzleIndex,
      gcode,
      trayId,
      fanPort,
      speed,
      modeId,
      submode,
    });
    sendEmpty(res);
    return true;
  }

  // Live-view camera health: supervisor status, frame freshness, viewer count,
  // restarts. Read-only and in-memory, so it's cheap to poll from a status badge.
  if (requestUrl.pathname === '/api/cameras/health' && req.method === 'GET') {
    sendJson(res, 200, getAllCameraHealth(), 'no-store');
    return true;
  }

  if (
    requestUrl.pathname.startsWith('/api/printers/') &&
    requestUrl.pathname.endsWith('/camera/health') &&
    req.method === 'GET'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/printers/'.length, -'/camera/health'.length),
    );
    sendJson(res, 200, getCameraHealth(id), 'no-store');
    return true;
  }

  if (requestUrl.pathname.startsWith('/api/printers/') && req.method === 'DELETE') {
    await deletePrinter(decodeURIComponent(requestUrl.pathname.slice('/api/printers/'.length)));
    sendEmpty(res);
    return true;
  }

  // Single printer by id — lets the detail page refresh one printer instead of
  // pulling the whole list every poll. Redacts sensitive connection fields in
  // public viewer mode, exactly like the list endpoint.
  if (requestUrl.pathname.startsWith('/api/printers/') && req.method === 'GET') {
    const id = decodeURIComponent(requestUrl.pathname.slice('/api/printers/'.length));
    const printer = await getPublicPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    sendJson(res, 200, printer);
    return true;
  }

  if (requestUrl.pathname === '/api/analytics/daily') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listDailyAnalytics(7));
      return true;
    }
  }

  if (requestUrl.pathname === '/api/analytics/daily/reset' && req.method === 'POST') {
    await resetDailyAnalytics();
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname === '/api/queue') {
    if (req.method === 'GET') {
      const { googleSheetQueueUrl } = await getIntegrationUrls();
      if (!googleSheetQueueUrl) {
        throw new Error('Google Sheet queue URL is not configured (set it in Settings → Integrations)');
      }

      const response = await fetch(toGoogleSheetCsvUrl(googleSheetQueueUrl), {
        headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' },
      });

      if (!response.ok) {
        throw new Error(`Google Sheet request failed with ${response.status}`);
      }

      const jobs = mapSheetRowsToQueue(parseCsv(await response.text()));
      const addedJobs = await upsertQueueJobs(jobs);
      sendQueueAddedNotifications(addedJobs).catch((error) => {
        console.error('Failed to send queue add notification', error);
      });
      sendJson(res, 200, await listQueueData());
      return true;
    }
  }

  if (requestUrl.pathname === '/api/queue/reset' && req.method === 'POST') {
    await resetQueueJobs();
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname.startsWith('/api/queue/') && requestUrl.pathname.endsWith('/printed') && req.method === 'POST') {
    const jobId = decodeURIComponent(requestUrl.pathname.slice('/api/queue/'.length, -'/printed'.length));
    await markQueueJobPrinted(jobId);
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname.startsWith('/api/queue/') && req.method === 'DELETE') {
    await deleteQueueJob(decodeURIComponent(requestUrl.pathname.slice('/api/queue/'.length)));
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname === '/api/notifications/discord-webhooks') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listDiscordWebhooks());
      return true;
    }
    if (req.method === 'POST') {
      await createDiscordWebhook(await readJsonBody(req));
      sendEmpty(res);
      return true;
    }
  }

  if (requestUrl.pathname.startsWith('/api/notifications/discord-webhooks/') && req.method === 'DELETE') {
    await deleteDiscordWebhook(decodeURIComponent(requestUrl.pathname.slice('/api/notifications/discord-webhooks/'.length)));
    sendEmpty(res);
    return true;
  }

  // Named API keys for the slicer-upload proxy. The plaintext key is generated
  // here and returned only once (POST response); only its sha256 hash is stored,
  // so listing keys never exposes the secret again.
  if (requestUrl.pathname === '/api/slicer-keys') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listSlicerApiKeys());
      return true;
    }
    if (req.method === 'POST') {
      const { name } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const key = randomBytes(24).toString('base64url');
      const id = randomUUID();
      await createSlicerApiKey({
        id,
        name: name.trim(),
        keyHash: hash(key),
        keyPrefix: key.slice(0, 8),
      });
      sendJson(res, 201, { id, name: name.trim(), key });
      return true;
    }
  }

  if (requestUrl.pathname.startsWith('/api/slicer-keys/') && req.method === 'DELETE') {
    await deleteSlicerApiKey(decodeURIComponent(requestUrl.pathname.slice('/api/slicer-keys/'.length)));
    sendEmpty(res);
    return true;
  }

  // Verifies the operator-grant token a slicer's "Device" tab carries when it
  // redirects into the dashboard. The token is HMAC-signed by the slicer-proxy
  // and expires quickly, so a constant URL flag can no longer self-promote to
  // operator — the session is only granted when this check passes.
  if (requestUrl.pathname === '/api/slicer-grant/verify' && req.method === 'POST') {
    const { token } = await readJsonBody(req);
    const grant = verifySlicerGrant(token);
    if (!grant) {
      sendJson(res, 401, { error: 'Invalid or expired slicer grant' });
      return true;
    }
    sendJson(res, 200, { printerId: grant.printerId });
    return true;
  }

  // Admin bootstrap credential. The password is set through the website on first
  // run (no default is shipped in the bundle), stored as a sha256 hash in the DB.
  //   GET  → { configured }            : has the admin password been set yet?
  //   POST → first-run set             : allowed only while unconfigured.
  //   PUT  → change                    : requires the current password hash.
  if (requestUrl.pathname === '/api/admin/credential') {
    const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
    const storedHash =
      stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';
    const configured = storedHash.length > 0;

    if (req.method === 'GET') {
      // Never return the hash — only whether first-run setup is complete.
      sendJson(res, 200, { configured });
      return true;
    }

    if (req.method === 'POST') {
      // First-run only: once an admin password exists this open endpoint must
      // refuse, so it can't be used to overwrite/hijack the existing credential.
      if (configured) {
        sendJson(res, 409, { error: 'Admin password is already configured' });
        return true;
      }
      const { passwordHash } = await readJsonBody(req);
      if (!isSha256Hex(passwordHash)) {
        sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
        return true;
      }
      await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: passwordHash.toLowerCase() });
      sendEmpty(res, 201);
      return true;
    }

    if (req.method === 'PUT') {
      if (!configured) {
        sendJson(res, 409, { error: 'Admin password is not configured yet' });
        return true;
      }
      const { currentPasswordHash, newPasswordHash } = await readJsonBody(req);
      if (!isSha256Hex(newPasswordHash)) {
        sendJson(res, 400, { error: 'newPasswordHash must be a sha256 hex string' });
        return true;
      }
      // Knowledge of the current password authorizes the change (there is no
      // server session to authorize it otherwise).
      if (!timingSafeEqualString(storedHash, String(currentPasswordHash || '').toLowerCase())) {
        sendJson(res, 401, { error: 'Current password is incorrect' });
        return true;
      }
      await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: newPasswordHash.toLowerCase() });
      sendEmpty(res);
      return true;
    }
  }

  // Validates an admin login. Returns { valid } and an HTTP 401 on mismatch so
  // the client can branch without parsing the body. The hash is compared in
  // constant time; the stored hash is never echoed back.
  if (requestUrl.pathname === '/api/admin/credential/verify' && req.method === 'POST') {
    const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
    const storedHash =
      stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';
    const { passwordHash } = await readJsonBody(req);
    const valid =
      storedHash.length > 0 &&
      isSha256Hex(passwordHash) &&
      timingSafeEqualString(storedHash, passwordHash.toLowerCase());
    sendJson(res, valid ? 200 : 401, { valid });
    return true;
  }

  // Audit log. GET returns the most recent entries (admin-only in the UI); POST
  // appends an entry reported by the client. Identity travels in the body since
  // auth is client-side; the server stamps the source ('web') and client IP.
  if (requestUrl.pathname === '/api/audit-logs') {
    if (req.method === 'GET') {
      const limit = requestUrl.searchParams.get('limit') || '200';
      sendJson(res, 200, await listAuditLogs(limit));
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body?.action !== 'string' || !body.action.trim()) {
        sendJson(res, 400, { error: 'action is required' });
        return true;
      }
      const actor = body.actor && typeof body.actor === 'object' ? body.actor : {};
      await recordAuditLog({
        actorName: typeof actor.name === 'string' ? actor.name : null,
        actorUsername: typeof actor.username === 'string' ? actor.username : null,
        actorRole: typeof actor.role === 'string' ? actor.role : null,
        action: body.action,
        target: typeof body.target === 'string' ? body.target : null,
        details: body.details ?? null,
        source: 'web',
        ip: getClientIp(req),
      });
      sendEmpty(res, 201);
      return true;
    }
  }

  // Printer-detail card layout, stored per printer profile so every printer of
  // a given type (e.g. all Snapmaker U1) shares one arrangement.
  if (requestUrl.pathname.startsWith('/api/settings/printer-card-layout/')) {
    const profile = decodeURIComponent(
      requestUrl.pathname.slice('/api/settings/printer-card-layout/'.length),
    );
    if (!PRINTER_CARD_LAYOUT_PROFILES.has(profile)) {
      sendJson(res, 400, { error: 'unknown printer profile' });
      return true;
    }
    const key = `${PRINTER_CARD_LAYOUT_KEY}:${profile}`;
    if (req.method === 'GET') {
      sendJson(res, 200, { layout: await getAppSetting(key) });
      return true;
    }
    if (req.method === 'PUT') {
      const { layout } = await readJsonBody(req);
      if (!Array.isArray(layout) || !layout.every((column) => Array.isArray(column))) {
        sendJson(res, 400, { error: 'layout must be an array of arrays' });
        return true;
      }
      await setAppSetting(key, layout);
      sendEmpty(res);
      return true;
    }
  }

  // Analytics page grid layout — one shared arrangement of cards (position and
  // size in grid units). GET returns the stored layout (null until first save);
  // the client normalizes it against the known card set.
  if (requestUrl.pathname === '/api/settings/analytics-layout') {
    if (req.method === 'GET') {
      sendJson(res, 200, { layout: await getAppSetting(ANALYTICS_LAYOUT_KEY) });
      return true;
    }
    if (req.method === 'PUT') {
      const { layout } = await readJsonBody(req);
      if (
        !Array.isArray(layout) ||
        !layout.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof item.i === 'string' &&
            ['x', 'y', 'w', 'h'].every((key) => typeof item[key] === 'number'),
        )
      ) {
        sendJson(res, 400, { error: 'layout must be an array of {i,x,y,w,h} items' });
        return true;
      }
      await setAppSetting(ANALYTICS_LAYOUT_KEY, layout);
      sendEmpty(res);
      return true;
    }
  }

  // Google Sheet (queue feed) + Google Form (print request) URLs. GET merges the
  // stored values with the VITE_* env defaults so callers always get an effective
  // value; PUT (admin-only in the UI) persists the override.
  if (requestUrl.pathname === '/api/settings/integrations') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getIntegrationUrls());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const googleSheetQueueUrl = body?.googleSheetQueueUrl;
      const googleFormUrl = body?.googleFormUrl;
      if (typeof googleSheetQueueUrl !== 'string' || typeof googleFormUrl !== 'string') {
        sendJson(res, 400, { error: 'googleSheetQueueUrl and googleFormUrl must be strings' });
        return true;
      }
      await setAppSetting(INTEGRATION_URLS_KEY, {
        googleSheetQueueUrl: googleSheetQueueUrl.trim(),
        googleFormUrl: googleFormUrl.trim(),
      });
      sendJson(res, 200, await getIntegrationUrls());
      return true;
    }
  }

  return false;
}

async function handlePrinterProxy(req, res, requestUrl, prefix, makeTargetUrl, extraHeaders = {}) {
  if (!requestUrl.pathname.startsWith(prefix)) {
    return false;
  }

  const pathParts = requestUrl.pathname.slice(prefix.length).split('/').filter(Boolean);
  const printerId = decodeURIComponent(pathParts.shift() || '');
  if (!printerId) {
    sendJson(res, 400, { error: 'Missing printer proxy target' });
    return true;
  }

  const printer = await getPrinterById(printerId);
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return true;
  }

  // Bambu's chamber camera isn't an HTTP endpoint — capture it over its TLS socket.
  if (prefix === '/__printer_webcam/' && BAMBU_PROFILES.has(printer.profile)) {
    await handleBambuWebcam(req, res, printer, pathParts);
    return true;
  }

  const proxyPath = `/${pathParts.map(encodeURIComponent).join('/')}${requestUrl.search}`;
  const body = req.method && !['GET', 'HEAD'].includes(req.method) ? await readBody(req) : undefined;
  const isWebcam = prefix === '/__printer_webcam/';

  // A webcam response can be an endless MJPEG stream (multipart/x-mixed-replace),
  // so it's piped through rather than buffered with arrayBuffer() (which would
  // never resolve). Abort the upstream fetch when the client disconnects so we
  // don't leak a camera connection per closed tab.
  const abortController = new AbortController();
  if (isWebcam) {
    res.on('close', () => abortController.abort());
    res.on('error', () => abortController.abort());
  }

  let response;
  try {
    response = await fetch(makeTargetUrl(printer, proxyPath), {
      method: req.method,
      headers: {
        ...parseHeaderString(printer.apiKeyHeader),
        ...extraHeaders,
        ...Object.fromEntries(
          Object.entries(req.headers).filter(([key]) => !['host', 'connection', 'content-length'].includes(key)),
        ),
      },
      body: body && body.length > 0 ? body : undefined,
      signal: abortController.signal,
    });
  } catch (error) {
    // A client navigating away aborts the fetch — expected, not an error.
    if (abortController.signal.aborted) {
      return true;
    }
    throw error;
  }

  res.statusCode = response.status;
  const contentType = response.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  if (isWebcam) {
    res.setHeader('Cache-Control', 'no-store');
    // The webcam player is embedded in an <iframe> on the detail page; relax the
    // global X-Frame-Options: DENY to allow same-origin framing of camera assets.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // The embeddable /webcam/:id page may be framed cross-origin (e.g. a Grafana
    // text panel, which sandboxes the iframe to an opaque origin). The global
    // Cross-Origin-Resource-Policy: same-origin would then block these frames, so
    // relax it for camera assets — they carry no printer secrets.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!response.body) {
      res.end();
      return true;
    }
    const upstream = Readable.fromWeb(response.body);
    upstream.on('error', () => {
      abortController.abort();
      if (!res.writableEnded) {
        res.end();
      }
    });
    upstream.pipe(res);
    return true;
  }

  res.end(Buffer.from(await response.arrayBuffer()));
  return true;
}

function resolveStaticPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(distDir, normalizedPath === '/' ? 'index.html' : normalizedPath);
  const resolvedPath = path.resolve(filePath);

  return resolvedPath.startsWith(distDir) ? resolvedPath : path.join(distDir, 'index.html');
}

async function serveStatic(req, res, requestUrl) {
  let filePath = resolveStaticPath(requestUrl.pathname);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }

  const extension = path.extname(filePath);
  res.setHeader('Content-Type', mimeTypes[extension] || 'application/octet-stream');
  res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/healthz') {
    // Liveness/readiness probe: keep this cheap and DB-independent so a
    // brief database blip never cascades into web pods being killed.
    sendJson(res, 200, { ok: true }, 'no-store');
    return;
  }

  try {
    if (await handleApi(req, res, requestUrl)) {
      return;
    }

    if (
      await handlePrinterProxy(
        req,
        res,
        requestUrl,
        '/__printer_proxy/',
        (printer, proxyPath) => `${printer.url}${proxyPath}`,
        {},
      )
    ) {
      return;
    }

    if (
      await handlePrinterProxy(
        req,
        res,
        requestUrl,
        '/__printer_webcam/',
        (printer, proxyPath) => `${printer.url}/webcam${proxyPath}`,
        {},
      )
    ) {
      return;
    }

    if (await handleWebcamPage(req, res, requestUrl)) {
      return;
    }

    await serveStatic(req, res, requestUrl);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, error.message === 'Request body is too large' ? 413 : 500, {
        error: error instanceof Error ? error.message : 'Request failed',
      });
    } else {
      res.end();
    }
  }
}

async function assertProductionInputs() {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('dist/index.html is missing. Run npm run build before starting the production server.');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  await readFile(path.join(distDir, 'index.html'));
}

await assertProductionInputs();

// Ensure the schema proactively, but do not block startup on the database:
// the SPA must still be served (and the liveness probe stay green) if the
// database is briefly unavailable. Query paths also call ensureSchema lazily.
ensureSchema().catch((error) => {
  console.error('Initial schema setup failed; will retry on first database request', error);
});

createServer(handleRequest).listen(port, host, () => {
  console.log(`Print Farm server listening on ${host}:${port}`);
});
