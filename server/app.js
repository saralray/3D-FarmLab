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
  findSlicerApiKeyByHash,
  getAppSetting,
  getPrinterById,
  getPrinterByIdOrName,
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
  touchSlicerApiKey,
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

// Queue sync cadence. The Sheet is pulled once per interval server-side (not per
// client request), and each pull is bounded by a fetch timeout so a slow Sheet
// can't hang the loop. 0 disables the background loop (sync then runs only on
// explicit POST /api/queue/sync).
const QUEUE_SYNC_INTERVAL_MS = Number.parseInt(process.env.QUEUE_SYNC_INTERVAL_MS ?? '60000', 10);
const QUEUE_SYNC_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.QUEUE_SYNC_FETCH_TIMEOUT_MS ?? '15000',
  10,
);

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

// Branding: an admin-uploaded logo that overrides the bundled default SVG.
// The image is stored as a data: URL in app_settings so it survives container
// rebuilds without a filesystem volume; an empty value means "use the default".
// For SVG uploads we also analyze the markup and keep a theme-adaptive copy
// (`logoSvg`) so the frontend can inline it and let monochrome marks follow the
// light/dark theme via `currentColor`. `logoScale` sizes the rendered logo.
const BRANDING_KEY = 'branding';

// Cap the stored data URL so a single logo can't bloat the row past the request
// body limit (maxBodyBytes). 700 KB of data URL ~= a 512 KB image after base64.
const MAX_LOGO_DATA_URL_BYTES = 700 * 1024;

// Allowed logo size multiplier range (1 = the built-in default size).
const MIN_LOGO_SCALE = 0.5;
const MAX_LOGO_SCALE = 2;

function clampLogoScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_LOGO_SCALE, Math.max(MIN_LOGO_SCALE, Math.round(scale * 100) / 100));
}

async function getBranding() {
  const stored = (await getAppSetting(BRANDING_KEY)) || {};
  return {
    logoDataUrl: typeof stored.logoDataUrl === 'string' ? stored.logoDataUrl : '',
    logoSvg: typeof stored.logoSvg === 'string' ? stored.logoSvg : '',
    logoAdaptive: stored.logoAdaptive === true,
    logoScale: clampLogoScale(stored.logoScale ?? 1),
  };
}

function decodeSvgDataUrl(dataUrl) {
  const match = /^data:image\/svg\+xml;base64,(.*)$/s.exec(dataUrl);
  if (!match) return '';
  try {
    return Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// Strip the obvious active-content vectors before we inline admin-uploaded SVG
// markup into the DOM. Upload is admin-only, but this is cheap insurance against
// a stored XSS via <script>, event handlers, or external/script URLs.
function sanitizeSvg(svg) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(?:xlink:href|href)\s*=\s*"(?:\s*javascript:|\s*https?:|\s*data:)[^"]*"/gi, '')
    .trim();
}

// Drop the root width/height so CSS height controls the rendered size (keeping
// aspect ratio via viewBox); synthesize a viewBox from width/height if missing.
function normalizeSvgSize(svg) {
  return svg.replace(/<svg\b[^>]*>/i, (tag) => {
    let next = tag;
    if (!/viewBox\s*=/i.test(next)) {
      const width = (/(?:^|\s)width\s*=\s*["']?([\d.]+)/i.exec(next) || [])[1];
      const height = (/(?:^|\s)height\s*=\s*["']?([\d.]+)/i.exec(next) || [])[1];
      if (width && height) {
        next = next.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
      }
    }
    return next.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[\d.]+)(?=[\s>])/gi, '');
  });
}

const SVG_COLOR_KEYWORDS = new Set([
  'none',
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'context-fill',
  'context-stroke',
]);

// Inspect an uploaded SVG and decide whether it is a single-color ("monochrome")
// mark we can recolor to follow the theme. If so, every visible color is swapped
// for `currentColor` so light/dark mode drives it; genuine multi-color art is
// left with its own colors. Returns the size-normalized markup either way.
function analyzeSvgForTheme(rawSvg) {
  const svg = normalizeSvgSize(sanitizeSvg(rawSvg));
  if (!/<svg[\s>]/i.test(svg)) {
    return { svg: '', adaptive: false };
  }

  const colorAttr = /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*([^"';>\s]+)/gi;
  const originalValues = [];
  const normalizedColors = new Set();
  let match;
  while ((match = colorAttr.exec(svg)) !== null) {
    const raw = match[1].trim();
    const normalized = raw.toLowerCase();
    if (SVG_COLOR_KEYWORDS.has(normalized) || normalized.startsWith('url(')) {
      continue;
    }
    originalValues.push(raw);
    normalizedColors.add(normalized);
  }

  // More than one distinct color → real multi-color logo; keep it untouched.
  if (normalizedColors.size > 1) {
    return { svg, adaptive: false };
  }

  let themed = svg;
  for (const value of new Set(originalValues)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    themed = themed.replace(new RegExp(escaped, 'gi'), 'currentColor');
  }
  // No explicit fill anywhere → the art relies on the default black fill; pin
  // that to currentColor on the root so it adapts too.
  if (originalValues.length === 0 && !/fill\s*[:=]/i.test(themed)) {
    themed = themed.replace(/<svg\b/i, '<svg fill="currentColor"');
  }

  return { svg: themed, adaptive: true };
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

// Staff user accounts (operators and any extra admins) are persisted server-side
// under this app_settings key so the list survives container rebuilds and is the
// same in every browser — they used to live only in the browser's localStorage,
// which made them vanish on a new machine or a fresh build. The primary `admin`
// account is the separate credential above and is never part of this list. Each
// record is { id, name, username, role, passwordHash } where passwordHash is a
// sha256 hex (hashed client-side); the hash is never returned by list/verify.
const STAFF_USERS_KEY = 'staff_users';
const RESERVED_USERNAME = 'admin';
const USER_ROLES = new Set(['admin', 'operator', 'viewer']);

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

// The stored staff-user list, or [] when none have been created yet.
async function readStaffUsers() {
  const stored = await getAppSetting(STAFF_USERS_KEY);
  return Array.isArray(stored) ? stored : [];
}

// Drop the password hash before a record leaves the server.
function sanitizeStaffUser(record) {
  return {
    id: record.id,
    name: record.name,
    username: record.username,
    role: record.role,
  };
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

// Pull the Google Sheet, upsert new/changed rows, and fire add notifications.
// This is the only place that touches the Sheet, shared by the periodic
// background sync and the explicit POST /api/queue/sync endpoint so that the
// read path (GET /api/queue) can stay a cheap DB read. The fetch is bounded by
// QUEUE_SYNC_FETCH_TIMEOUT_MS so a slow/unreachable Sheet can never hang a
// request or stall the background loop.
async function syncQueueFromSheet() {
  const { googleSheetQueueUrl } = await getIntegrationUrls();
  if (!googleSheetQueueUrl) {
    throw new Error('Google Sheet queue URL is not configured (set it in Settings → Integrations)');
  }

  const response = await fetch(toGoogleSheetCsvUrl(googleSheetQueueUrl), {
    headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(QUEUE_SYNC_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Google Sheet request failed with ${response.status}`);
  }

  const jobs = mapSheetRowsToQueue(parseCsv(await response.text()));
  const addedJobs = await upsertQueueJobs(jobs);
  sendQueueAddedNotifications(addedJobs).catch((error) => {
    console.error('Failed to send queue add notification', error);
  });
  return addedJobs;
}

// Periodic background sync: keeps queue_jobs fresh from the Sheet without any
// client driving it, so every tab can poll the cheap read endpoint instead of
// each one triggering its own Sheet fetch + full upsert. Runs are serialized
// (no overlap) and failures are logged but never throw out of the interval.
let queueSyncInFlight = false;
async function runBackgroundQueueSync() {
  if (queueSyncInFlight) {
    return;
  }
  queueSyncInFlight = true;
  try {
    await syncQueueFromSheet();
  } catch (error) {
    console.error('Background queue sync failed', error);
  } finally {
    queueSyncInFlight = false;
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

// Generic Bambu filament presets keyed by material type. `idx` is Bambu's
// tray_info_idx code (the generic profile for each material); `min`/`max` are
// the nozzle temperature window. Used by the ams_filament_setting command when
// staff edit a tray's material. Codes/temps may need per-model tuning.
const BAMBU_FILAMENT_PRESETS = {
  PLA: { idx: 'GFL99', type: 'PLA', min: 190, max: 230 },
  PETG: { idx: 'GFG99', type: 'PETG', min: 230, max: 260 },
  ABS: { idx: 'GFB99', type: 'ABS', min: 240, max: 270 },
  ASA: { idx: 'GFB98', type: 'ASA', min: 240, max: 270 },
  TPU: { idx: 'GFU99', type: 'TPU', min: 200, max: 240 },
  PC: { idx: 'GFC99', type: 'PC', min: 260, max: 280 },
  PA: { idx: 'GFN99', type: 'PA', min: 260, max: 290 },
  PVA: { idx: 'GFS99', type: 'PVA', min: 190, max: 220 },
};

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

  if (command === 'set_filament') {
    // ams_filament_setting: change the material/color the printer thinks is in a
    // tray. `trayId` is the global tray id (AMS unit * 4 + tray, or 254 for the
    // external spool). Bambu splits it into ams_id (the unit) and tray_id (0-3
    // within the unit); the external spool uses ams_id 255 / tray_id 254.
    // `tray_info_idx` is Bambu's filament code (e.g. generic PLA = GFL99) and
    // `tray_color` is RRGGBBAA. These codes/temps are device-specific and may
    // need live tuning per printer model.
    const target = Number(params.trayId);
    if (!Number.isFinite(target) || target < 0 || target > 255) {
      throw new Error('Filament tray target is out of range');
    }
    const isExternal = target === 254;
    const amsId = isExternal ? 255 : Math.floor(target / 4);
    const trayId = isExternal ? 254 : target % 4;
    const type = String(params.type || '').toUpperCase().trim();
    const preset = BAMBU_FILAMENT_PRESETS[type] || BAMBU_FILAMENT_PRESETS.PLA;
    const color = String(params.color || '#808080').replace('#', '').slice(0, 6).toUpperCase();
    const trayColor = `${color.padEnd(6, '0')}FF`;
    return {
      print: {
        command: 'ams_filament_setting',
        ams_id: amsId,
        tray_id: trayId,
        tray_info_idx: preset.idx,
        tray_color: trayColor,
        nozzle_temp_min: preset.min,
        nozzle_temp_max: preset.max,
        tray_type: preset.type,
        setting_id: '',
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

// Friendly webcam stream URL — GET /webcam/<printerId-or-name> serves the camera
// feed directly so it drops straight into an <img src> (e.g. a Grafana HTML/text
// panel) with no iframe. Live-MJPEG printers (Snapmaker U1, Bambu H2 series)
// stream multipart/x-mixed-replace; everything else returns a single JPEG
// snapshot. It just resolves the printer and delegates to the existing webcam
// proxy, so the cross-origin / no-store / Bambu handling is shared.
const LIVE_MJPEG_PROFILES = new Set(['snapmaker_u1', 'bambulab_h2s', 'bambulab_h2d']);

async function handleWebcamStream(req, res, requestUrl) {
  const match = requestUrl.pathname.match(/^\/webcam\/([^/]+)\/?$/);
  if (!match) {
    return false;
  }

  const printer = await getPrinterByIdOrName(decodeURIComponent(match[1]));
  if (!printer) {
    sendJson(res, 404, { error: 'Printer not found' });
    return true;
  }

  // Reuse the /__printer_webcam proxy by rewriting to the resolved printer id and
  // the right camera path for its profile (stream vs. snapshot).
  const camPath = LIVE_MJPEG_PROFILES.has(printer.profile) ? 'stream.mjpg' : 'snapshot.jpg';
  const proxyUrl = new URL(
    `/__printer_webcam/${encodeURIComponent(printer.id)}/${camPath}`,
    requestUrl,
  );
  return handlePrinterProxy(
    req,
    res,
    proxyUrl,
    '/__printer_webcam/',
    (p, proxyPath) => `${p.url}/webcam${proxyPath}`,
    {},
  );
}

// ── /api/v1: API-key-protected programmatic data API ───────────────────────
// A versioned external/integration API over the print-farm's data, gated by a
// named API key. Per the project decision it reuses the slicer_api_keys store
// (X-Api-Key header, or `Authorization: Bearer <key>`); any valid key grants
// full read/write. This namespace is entirely separate from the cookieless
// frontend /api/* endpoints, which stay unauthenticated and untouched. Because
// the key is the guard here, connection details are NOT redacted (unlike the
// public-viewer listPrinters path). Mutations are stamped into the audit log
// with source 'api' so key-driven changes are attributable.
const DATA_API_PREFIX = '/api/v1/';

const DATA_API_RESOURCES = [
  'printers',
  'queue',
  'analytics',
  'notifications',
  'slicer-keys',
  'audit-logs',
  'settings',
];

function extractApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

// Resolve the presented key to a slicer_api_keys record, or null. Mirrors the
// slicer-proxy: hash the plaintext, look it up, and best-effort stamp usage.
async function authenticateDataApi(req) {
  const key = extractApiKey(req);
  if (!key) {
    return null;
  }
  const record = await findSlicerApiKeyByHash(hash(key));
  if (!record) {
    return null;
  }
  touchSlicerApiKey(record.id).catch((error) => {
    console.error('Failed to stamp API key usage', error);
  });
  return record;
}

// Best-effort audit entry for a key-driven mutation; never blocks the response.
function auditDataApi(req, apiKey, action, target, details) {
  recordAuditLog({
    actorName: `api:${apiKey.name}`,
    actorUsername: apiKey.id,
    actorRole: 'api',
    action,
    target: target ?? null,
    details: details ?? null,
    source: 'api',
    ip: getClientIp(req),
  }).catch((error) => {
    console.error('Failed to record API audit log', error);
  });
}

async function handleDataApi(req, res, requestUrl) {
  if (!requestUrl.pathname.startsWith(DATA_API_PREFIX)) {
    return false;
  }

  const apiKey = await authenticateDataApi(req);
  if (!apiKey) {
    sendJson(res, 401, {
      error: 'A valid API key is required. Pass it as the X-Api-Key header or `Authorization: Bearer <key>`.',
    });
    return true;
  }

  const method = req.method;
  const segments = requestUrl.pathname
    .slice(DATA_API_PREFIX.length)
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const [entity, id, sub] = segments;

  // Discovery root: GET /api/v1 lists the available resources.
  if (!entity) {
    sendJson(res, 200, { version: 'v1', resources: DATA_API_RESOURCES });
    return true;
  }

  switch (entity) {
    case 'printers':
      return handleDataApiPrinters(req, res, { apiKey, method, id, sub, action: segments[3], requestUrl });
    case 'queue':
      return handleDataApiQueue(req, res, { apiKey, method, id, sub });
    case 'analytics':
      return handleDataApiAnalytics(req, res, { apiKey, method, id, requestUrl });
    case 'notifications':
      return handleDataApiNotifications(req, res, { apiKey, method, id });
    case 'slicer-keys':
      return handleDataApiSlicerKeys(req, res, { apiKey, method, id });
    case 'audit-logs':
      return handleDataApiAuditLogs(req, res, { apiKey, method, requestUrl });
    case 'settings':
      return handleDataApiSettings(req, res, { apiKey, method, id });
    default:
      sendJson(res, 404, { error: `Unknown resource '${entity}'.`, resources: DATA_API_RESOURCES });
      return true;
  }
}

function dataApiMethodNotAllowed(res) {
  sendJson(res, 405, { error: 'Method not allowed for this resource.' });
  return true;
}

// printers: list / read / upsert / delete (+ pass-through Bambu command, webcam).
async function handleDataApiPrinters(req, res, { apiKey, method, id, sub, action, requestUrl }) {
  if (!id) {
    if (method === 'GET') {
      // Data API is key-gated, so connection details (url, ip, api key, serial —
      // needed to reach each printer's hardware/webcam) are NOT redacted, even in
      // public viewer mode. This matches the single-printer getPrinterById read.
      sendJson(res, 200, await listPrinters(true));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== 'string' || !body.id.trim()) {
        sendJson(res, 400, { error: 'printer id is required' });
        return true;
      }
      await upsertPrinter(body);
      auditDataApi(req, apiKey, 'printer.upsert', body.id);
      sendJson(res, 200, await getPrinterById(body.id));
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

  // POST /printers/:id/command — proxy a Bambu MQTT command.
  if (sub === 'command' && method === 'POST') {
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    const { command, heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode } =
      await readJsonBody(req);
    await sendBambuCommand(printer, command, {
      heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode,
    });
    auditDataApi(req, apiKey, 'printer.command', id, { command });
    sendEmpty(res);
    return true;
  }

  // GET /printers/:id/camera/{snapshot,stream,health} — webcam access. Snapshot
  // and stream delegate to the same /__printer_webcam proxy the friendly
  // /webcam/<id> route uses, so every profile (Bambu port-6000 JPEG, H2 RTSP
  // hub, Snapmaker live MJPEG) is handled identically. `stream` serves live
  // multipart MJPEG where the profile supports it and otherwise falls back to a
  // single snapshot.
  if (sub === 'camera') {
    if (method !== 'GET') {
      return dataApiMethodNotAllowed(res);
    }
    if (action === 'health') {
      sendJson(res, 200, getCameraHealth(id), 'no-store');
      return true;
    }
    if (action !== 'snapshot' && action !== 'stream') {
      sendJson(res, 404, { error: "Use /camera/snapshot, /camera/stream, or /camera/health." });
      return true;
    }
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    const camPath =
      action === 'stream' && LIVE_MJPEG_PROFILES.has(printer.profile) ? 'stream.mjpg' : 'snapshot.jpg';
    const proxyUrl = new URL(
      `/__printer_webcam/${encodeURIComponent(printer.id)}/${camPath}`,
      requestUrl,
    );
    return handlePrinterProxy(
      req,
      res,
      proxyUrl,
      '/__printer_webcam/',
      (p, proxyPath) => `${p.url}/webcam${proxyPath}`,
      {},
    );
  }

  if (method === 'GET') {
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    sendJson(res, 200, printer);
    return true;
  }
  if (method === 'DELETE') {
    await deletePrinter(id);
    auditDataApi(req, apiKey, 'printer.delete', id);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// queue: list stored jobs / upsert / reset / mark printed / delete.
// GET returns the stored queue (it does NOT trigger a Google Sheet sync — that
// stays on the frontend /api/queue path).
async function handleDataApiQueue(req, res, { apiKey, method, id, sub }) {
  if (!id) {
    if (method === 'GET') {
      sendJson(res, 200, await listQueueData());
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const jobs = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : null;
      if (!jobs) {
        sendJson(res, 400, { error: 'expected an array of jobs or { jobs: [...] }' });
        return true;
      }
      const added = await upsertQueueJobs(jobs);
      auditDataApi(req, apiKey, 'queue.upsert', null, { count: jobs.length });
      sendJson(res, 200, { added });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

  if (id === 'reset' && method === 'POST') {
    await resetQueueJobs();
    auditDataApi(req, apiKey, 'queue.reset', null);
    sendEmpty(res);
    return true;
  }
  if (sub === 'printed' && method === 'POST') {
    await markQueueJobPrinted(id);
    auditDataApi(req, apiKey, 'queue.printed', id);
    sendEmpty(res);
    return true;
  }
  if (method === 'DELETE') {
    await deleteQueueJob(id);
    auditDataApi(req, apiKey, 'queue.delete', id);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// analytics: daily rollups (read) + reset.
async function handleDataApiAnalytics(req, res, { apiKey, method, id, requestUrl }) {
  if (!id) {
    if (method === 'GET') {
      const days = Number.parseInt(requestUrl.searchParams.get('days') || '7', 10);
      sendJson(res, 200, await listDailyAnalytics(Number.isFinite(days) ? days : 7));
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }
  if (id === 'reset' && method === 'POST') {
    await resetDailyAnalytics();
    auditDataApi(req, apiKey, 'analytics.reset', null);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// notifications: Discord webhook CRUD.
async function handleDataApiNotifications(req, res, { apiKey, method, id }) {
  if (!id) {
    if (method === 'GET') {
      sendJson(res, 200, await listDiscordWebhooks());
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const webhook = { id: typeof body?.id === 'string' && body.id ? body.id : randomUUID(), ...body };
      await createDiscordWebhook(webhook);
      auditDataApi(req, apiKey, 'notification.upsert', webhook.id);
      sendJson(res, 201, { id: webhook.id });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }
  if (method === 'DELETE') {
    await deleteDiscordWebhook(id);
    auditDataApi(req, apiKey, 'notification.delete', id);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// slicer-keys: list / mint (plaintext returned once) / revoke.
async function handleDataApiSlicerKeys(req, res, { apiKey, method, id }) {
  if (!id) {
    if (method === 'GET') {
      sendJson(res, 200, await listSlicerApiKeys());
      return true;
    }
    if (method === 'POST') {
      const { name } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const key = randomBytes(24).toString('base64url');
      const newId = randomUUID();
      await createSlicerApiKey({ id: newId, name: name.trim(), keyHash: hash(key), keyPrefix: key.slice(0, 8) });
      auditDataApi(req, apiKey, 'slicer-key.create', newId, { name: name.trim() });
      sendJson(res, 201, { id: newId, name: name.trim(), key });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }
  if (method === 'DELETE') {
    await deleteSlicerApiKey(id);
    auditDataApi(req, apiKey, 'slicer-key.delete', id);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// audit-logs: read recent entries (newest first). Append via POST.
async function handleDataApiAuditLogs(req, res, { apiKey, method, requestUrl }) {
  if (method === 'GET') {
    const limit = requestUrl.searchParams.get('limit') || '200';
    sendJson(res, 200, await listAuditLogs(limit));
    return true;
  }
  if (method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body?.action !== 'string' || !body.action.trim()) {
      sendJson(res, 400, { error: 'action is required' });
      return true;
    }
    await recordAuditLog({
      actorName: `api:${apiKey.name}`,
      actorUsername: apiKey.id,
      actorRole: 'api',
      action: body.action,
      target: typeof body.target === 'string' ? body.target : null,
      details: body.details ?? null,
      source: 'api',
      ip: getClientIp(req),
    });
    sendEmpty(res, 201);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// settings: app_settings key/value store. GET/PUT by key.
async function handleDataApiSettings(req, res, { apiKey, method, id }) {
  if (!id) {
    sendJson(res, 400, { error: 'a settings key is required: /api/v1/settings/<key>' });
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 200, { key: id, value: await getAppSetting(id) });
    return true;
  }
  if (method === 'PUT' || method === 'POST') {
    const body = await readJsonBody(req);
    // Accept either { value: <any> } or the raw value as the whole body.
    const value = body && typeof body === 'object' && 'value' in body ? body.value : body;
    await setAppSetting(id, value);
    auditDataApi(req, apiKey, 'setting.update', id);
    sendJson(res, 200, { key: id, value });
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, 'no-store');
    return true;
  }

  if (await handleDataApi(req, res, requestUrl)) {
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

  // Read path: cheap DB read, no Sheet fetch. The Sheet is pulled by the
  // background sync loop (and by the explicit POST below), so every polling tab
  // hits this instead of triggering its own fetch + full upsert.
  if (requestUrl.pathname === '/api/queue') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listQueueData());
      return true;
    }
  }

  // Explicit Sheet sync: pull + upsert + notify, then return the fresh queue.
  // Used for on-demand refresh (e.g. opening the Queue page) on top of the
  // periodic background sync.
  if (requestUrl.pathname === '/api/queue/sync' && req.method === 'POST') {
    await syncQueueFromSheet();
    sendJson(res, 200, await listQueueData());
    return true;
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

  // Staff user accounts (operators and any extra admins), persisted server-side
  // so the list survives container rebuilds and is shared across browsers. The
  // primary `admin` account is the separate credential above and is never part
  // of this list. Reads never expose password hashes.
  //   GET  /api/users          → sanitized list for the management UI.
  //   POST /api/users          → create from { name, username, role, passwordHash }.
  if (requestUrl.pathname === '/api/users') {
    if (req.method === 'GET') {
      const usersList = await readStaffUsers();
      sendJson(res, 200, usersList.map(sanitizeStaffUser));
      return true;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const username =
        typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
      const role = typeof body?.role === 'string' ? body.role : '';
      const passwordHash = body?.passwordHash;

      if (!name || !username) {
        sendJson(res, 400, { error: 'Name and username are required.' });
        return true;
      }
      if (!USER_ROLES.has(role)) {
        sendJson(res, 400, { error: 'role must be admin, operator, or viewer' });
        return true;
      }
      if (!isSha256Hex(passwordHash)) {
        sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
        return true;
      }
      if (username === RESERVED_USERNAME) {
        sendJson(res, 409, { error: 'That username is reserved.' });
        return true;
      }

      const usersList = await readStaffUsers();
      if (usersList.some((candidate) => candidate.username === username)) {
        sendJson(res, 409, { error: 'That username is already in use.' });
        return true;
      }

      const newUser = {
        id: randomUUID(),
        name,
        username,
        role,
        passwordHash: passwordHash.toLowerCase(),
      };
      await setAppSetting(STAFF_USERS_KEY, [...usersList, newUser]);
      sendJson(res, 201, sanitizeStaffUser(newUser));
      return true;
    }
  }

  // Verify a staff (non-admin) login. Returns { valid } and, on success, the
  // sanitized user record so the client can open a session. The hash is compared
  // in constant time and never echoed back.
  if (requestUrl.pathname === '/api/users/verify' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const username =
      typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const passwordHash = body?.passwordHash;
    const usersList = await readStaffUsers();
    const found = isSha256Hex(passwordHash)
      ? usersList.find(
          (candidate) =>
            candidate.username === username &&
            timingSafeEqualString(
              String(candidate.passwordHash || ''),
              passwordHash.toLowerCase(),
            ),
        )
      : undefined;
    if (!found) {
      sendJson(res, 401, { valid: false });
      return true;
    }
    sendJson(res, 200, { valid: true, user: sanitizeStaffUser(found) });
    return true;
  }

  // Per-user management, keyed by id:
  //   DELETE /api/users/:id           → remove the account.
  //   PUT    /api/users/:id/password  → set a new password ({ passwordHash }).
  if (requestUrl.pathname.startsWith('/api/users/')) {
    const [rawId, action] = requestUrl.pathname.slice('/api/users/'.length).split('/');
    const userId = decodeURIComponent(rawId || '');

    if (!userId) {
      sendJson(res, 400, { error: 'user id is required' });
      return true;
    }

    if (!action && req.method === 'DELETE') {
      const usersList = await readStaffUsers();
      if (!usersList.some((candidate) => candidate.id === userId)) {
        sendJson(res, 404, { error: 'user not found' });
        return true;
      }
      await setAppSetting(
        STAFF_USERS_KEY,
        usersList.filter((candidate) => candidate.id !== userId),
      );
      sendEmpty(res);
      return true;
    }

    if (action === 'password' && req.method === 'PUT') {
      const { passwordHash } = await readJsonBody(req);
      if (!isSha256Hex(passwordHash)) {
        sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
        return true;
      }
      const usersList = await readStaffUsers();
      const index = usersList.findIndex((candidate) => candidate.id === userId);
      if (index === -1) {
        sendJson(res, 404, { error: 'user not found' });
        return true;
      }
      const nextUsers = [...usersList];
      nextUsers[index] = { ...nextUsers[index], passwordHash: passwordHash.toLowerCase() };
      await setAppSetting(STAFF_USERS_KEY, nextUsers);
      sendEmpty(res);
      return true;
    }
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

  // Customizable site logo. GET is public (the Login/Navigation logo must render
  // before auth); PUT (admin-only in the UI) stores an uploaded image as a data
  // URL, or clears it to fall back to the bundled default.
  if (requestUrl.pathname === '/api/settings/branding') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getBranding());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const logoDataUrl = body?.logoDataUrl;
      if (typeof logoDataUrl !== 'string') {
        sendJson(res, 400, { error: 'logoDataUrl must be a string' });
        return true;
      }
      const trimmed = logoDataUrl.trim();
      if (trimmed && !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(trimmed)) {
        sendJson(res, 400, {
          error: 'logoDataUrl must be an empty string or a base64 image data URL',
        });
        return true;
      }
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_LOGO_DATA_URL_BYTES) {
        sendJson(res, 413, { error: 'Logo image is too large (max ~512 KB).' });
        return true;
      }

      const logoScale = clampLogoScale(body?.logoScale ?? 1);

      // For SVG uploads, analyze the markup and keep a theme-adaptive copy that
      // the frontend can inline; non-SVG (raster) logos render straight from the
      // data URL with no theming.
      let logoSvg = '';
      let logoAdaptive = false;
      if (trimmed.startsWith('data:image/svg+xml;base64,')) {
        const raw = decodeSvgDataUrl(trimmed);
        if (raw) {
          const analyzed = analyzeSvgForTheme(raw);
          logoSvg = analyzed.svg;
          logoAdaptive = analyzed.adaptive;
        }
      }

      await setAppSetting(BRANDING_KEY, { logoDataUrl: trimmed, logoSvg, logoAdaptive, logoScale });
      sendJson(res, 200, await getBranding());
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
    // The embeddable player (e.g. Snapmaker's /webcam/player) is an HTML page whose
    // inner <video>/<canvas> letterboxes with black bars at the iframe's 16:9 box.
    // Buffer just the HTML (streams like MJPEG/JPEG stay piped) and inject a style
    // override so the media fills and covers the frame — no black bars.
    if (contentType && contentType.includes('text/html')) {
      const html = Buffer.from(await response.arrayBuffer()).toString('utf8');
      const styleTag =
        '<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}' +
        'video,canvas,img{position:fixed!important;inset:0!important;width:100%!important;' +
        'height:100%!important;object-fit:cover!important}</style>';
      const patched = html.includes('</head>')
        ? html.replace('</head>', `${styleTag}</head>`)
        : html + styleTag;
      res.end(patched);
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

    if (await handleWebcamStream(req, res, requestUrl)) {
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

// Periodic background queue sync: one Sheet pull per interval for the whole
// server, regardless of how many tabs are polling. Kicks off shortly after
// startup (lets the schema settle) and repeats on QUEUE_SYNC_INTERVAL_MS.
if (Number.isFinite(QUEUE_SYNC_INTERVAL_MS) && QUEUE_SYNC_INTERVAL_MS > 0) {
  setTimeout(() => {
    runBackgroundQueueSync();
    setInterval(runBackgroundQueueSync, QUEUE_SYNC_INTERVAL_MS).unref();
  }, 2000).unref();
}

createServer(handleRequest).listen(port, host, () => {
  console.log(`Print Farm server listening on ${host}:${port}`);
});
