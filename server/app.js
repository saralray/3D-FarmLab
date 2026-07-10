import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import busboy from 'busboy';
import { decryptSecret, encryptSecret } from './secretCrypto.js';
import {
  addEventSubscriber,
  broadcastQueueAdded,
  broadcastMaintenanceNotification,
  broadcastQueueStatus,
  broadcastMaintenanceStatus,
  broadcastFilamentStationEvent,
} from './eventStream.js';
import {
  approveManagerRequest,
  buildBackupSnapshot,
  clearManagerRequestKeySecret,
  createDiscordWebhook,
  createManagerRequest,
  createSession,
  createSlicerApiKey,
  deleteDiscordWebhook,
  deleteExpiredSessions,
  deletePrinter,
  encryptPlaintextPrinterSecrets,
  deleteSession,
  deleteSessionsForUser,
  getRedactedPrinterById,
  getSession,
  listPrintersRedacted,
  deleteQueueJob,
  deleteQueueJobs,
  deleteSlicerApiKey,
  deleteSlicerApiKeysBySession,
  denyManagerRequest,
  ensureSchema,
  exportQueueJobs,
  findSlicerApiKeyByHash,
  getAppSetting,
  getManagerRequest,
  getPrinterById,
  getPrinterByIdOrName,
  getQueueJobFileMeta,
  hasUnfinishedQueueJobs,
  listAssignmentsNeedingTrigger,
  readQueueJobFileChunk,
  importQueueJobs,
  insertQueueSubmission,
  pingDatabase,
  recordAssignmentTriggerResult,
  setQueueJobFile,
  listDailyAnalytics,
  listNetworkUsageDaily,
  getNetworkUsageByRoute,
  getNetworkUsageToday,
  getNetworkUsageMonthToDate,
  getPollerHealth,
  upsertNetworkUsageDaily,
  listDiscordWebhooks,
  listManagerRequests,
  listPrinters,
  listAuditLogs,
  listSlicerApiKeys,
  listQueueData,
  markQueueJobPrinted,
  recordAuditLog,
  resetDailyAnalytics,
  resetQueueJobs,
  deleteManagerRequest,
  setAppSetting,
  setPrinterTemperatureTarget,
  touchSlicerApiKey,
  upsertPrinter,
  upsertQueueJobs,
  getMaintenanceDefaultIntervals,
  setMaintenanceDefaultIntervals,
  listMaintenanceEvents,
  getPrinterMaintenance,
  completeMaintenanceEvent,
  getMaintenanceSummary,
  listMaintenanceNotifications,
  markMaintenanceNotificationsRead,
  getMaintenanceWorkerData,
  bulkUpdateHealthScores,
  backfillAllMaintenanceSchedules,
  createPendingMaintenanceEvent,
  createMaintenanceNotification,
  markMaintenanceEventsNotified,
  recalcHealthScore,
  healthStatusFromScore,
  reviveBackupTables,
  restoreBackupSnapshot,
} from './postgres.js';
import { createZip, readZip } from './zipArchive.js';
import { verifySlicerGrant } from './slicerGrant.js';
import { handleFilamentStation } from './filamentStation.js';
import { sendBambuCommand } from './bambuCommands.js';
import {
  isRedisEnabled,
  redisDel,
  redisGet,
  redisHGetAll,
  redisIncrWithTtl,
  redisPing,
  redisSet,
  redisTtl,
} from './redis.js';
import { logger } from './logger.js';
import {
  classifyRoute,
  getProcessStartSeconds,
  recordRequestBytes,
  recordRequestEnd,
  recordRequestStart,
  recordResponseBytes,
  renderMetrics,
  snapshotBytesByRoute,
  snapshotBytesInByRoute,
  snapshotRequestsByRoute,
} from './metrics.js';
import {
  mintAuthGrant,
  signState,
  verifyAuthGrant,
  verifyState,
} from './oauthGrant.js';
import {
  buildAuthnRequest,
  buildSpMetadata,
  isValidCertificate,
  isValidHttpUrl,
  parseAndVerifySamlResponse,
  SamlError,
} from './samlSp.js';
import {
  addCameraViewer,
  getAllCameraHealth,
  getCameraHealth,
  getCameraSnapshot,
  streamLegacyMjpeg,
} from './bambuCamera.js';

// Bambu Lab printers share one LAN integration (MQTT status/commands, port-6000
// camera), so they're grouped rather than matched by a single model id.
const BAMBU_PROFILES = new Set(['bambulab_a1_mini', 'bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

// The H2 series (like the X1) exposes its camera as an RTSP-over-TLS stream on
// port 322 (LIVE555 server, digest auth) — a different protocol from the A1/P1
// port-6000 length-prefixed JPEG socket — so its snapshots are grabbed via
// ffmpeg instead of captureBambuSnapshot.
const BAMBU_RTSP_PROFILES = new Set(['bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

// Profiles the in-app player attempts an AV1 live view for (server/bambuCamera.js).
// The H2 series is a known-good RTSP transcode; the Snapmaker U1 is a
// best-effort probe against an assumed native webcam endpoint, with an
// automatic fallback to its existing native-proxy player if that assumption
// doesn't hold for a given printer (see bambuCamera.js's `mode` state). This
// is deliberately separate from the documented, unauthenticated
// camera/snapshot/stream MJPEG surface (LIVE_MJPEG_PROFILES below), which
// keeps serving MJPEG/JPEG exactly as before — AV1-in-fMP4 isn't
// <img>-embeddable, so it gets new routes instead of repurposing that contract.
const AV1_STREAM_PROFILES = new Set(['bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c', 'snapmaker_u1']);

const PRINTER_CARD_LAYOUT_KEY = 'printer_card_layout';
const PRINTER_CARD_LAYOUT_PROFILES = new Set([
  'generic',
  'snapmaker_u1',
  'bambulab_a1_mini',
  'bambulab_h2s',
  'bambulab_h2d',
  'bambulab_h2c',
]);

// Analytics page grid layout: a single shared arrangement (admins drag/resize
// the cards) stored in app_settings, like the printer-detail card layout above.
const ANALYTICS_LAYOUT_KEY = 'analytics_layout';

// In-app print-request form: the uploaded model file is read into memory and
// stored in Postgres (bytea). Cap the upload so a single submission can't exhaust
// memory; the matching nginx location lifts its body cap to the same ceiling.
const QUEUE_UPLOAD_MAX_BYTES = Number.parseInt(
  process.env.QUEUE_UPLOAD_MAX_BYTES ?? String(50 * 1024 * 1024),
  10,
);

// A restore upload is a full backup archive (every table, including every
// stored queue-job model file), so its ceiling is far higher than a single
// print-request upload; the matching nginx location lifts its body cap to
// the same value.
const BACKUP_UPLOAD_MAX_BYTES = Number.parseInt(
  process.env.BACKUP_UPLOAD_MAX_BYTES ?? String(500 * 1024 * 1024),
  10,
);
// Print-request intake only accepts printable mesh formats (STL / 3MF / OBJ).
const QUEUE_ALLOWED_FILE_EXT = new Set(['.stl', '.3mf', '.obj']);

// Google Form (print-request) URL — retained for the Settings → Integrations
// override, though the in-app form at /request is now the primary intake path.
// Configured by admins and persisted in app_settings; empty until set.
const INTEGRATION_URLS_KEY = 'integration_urls';

async function getIntegrationUrls() {
  const stored = (await getAppSetting(INTEGRATION_URLS_KEY)) || {};
  return {
    googleSheetQueueUrl: stored.googleSheetQueueUrl || '',
    googleFormUrl: stored.googleFormUrl || '',
  };
}

// Home Assistant integration: base URL + a long-lived access token (the token is
// the secret, stored encrypted at rest with the same AES-256-GCM scheme as
// printer secrets). The server holds the token and proxies every HA REST call so
// the token never reaches the browser. Admin-only (see isSensitiveRead /
// isAdminMutation gating on /api/settings/home-assistant*).
const HOME_ASSISTANT_KEY = 'home_assistant';

// Normalize a configured base URL: strip a trailing slash and a trailing /api so
// haFetch can append '/api/...' uniformly regardless of how the admin typed it.
function normalizeHaBaseUrl(raw) {
  let base = String(raw || '').trim();
  if (!base) return '';
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/api$/, '');
  return base;
}

async function getHomeAssistantConfig() {
  const stored = (await getAppSetting(HOME_ASSISTANT_KEY)) || {};
  return {
    baseUrl: normalizeHaBaseUrl(stored.baseUrl),
    token: typeof stored.token === 'string' ? decryptSecret(stored.token) : '',
    enabled: stored.enabled === true,
  };
}

// Perform an authenticated request against the configured Home Assistant REST
// API. Returns a small { ok, status, data, error } envelope rather than throwing
// so route handlers can map failures to clean JSON responses. A 10s timeout
// keeps a slow/unreachable HA from hanging the web request.
async function haFetch(config, apiPath, { method = 'GET', body } = {}) {
  if (!config.baseUrl || !config.token) {
    return { ok: false, status: 0, error: 'Home Assistant is not configured.' };
  }
  const url = `${config.baseUrl}/api/${apiPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const detail =
        data && typeof data === 'object' && data.message ? data.message : `HTTP ${response.status}`;
      return { ok: false, status: response.status, error: detail, data };
    }
    return { ok: true, status: response.status, data };
  } catch (err) {
    const message =
      err && err.name === 'AbortError'
        ? 'Home Assistant did not respond in time.'
        : `Could not reach Home Assistant: ${err && err.message ? err.message : err}`;
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// Call a Home Assistant service (e.g. switch.turn_off) on an optional target
// entity, with optional extra data. Used by the printer→HA automation rules.
async function callHaService(config, service, entity, data) {
  const dot = String(service || '').indexOf('.');
  if (dot <= 0) {
    return { ok: false, status: 0, error: `Invalid service "${service}"` };
  }
  const domain = service.slice(0, dot);
  const name = service.slice(dot + 1);
  const body = { ...(data && typeof data === 'object' ? data : {}) };
  if (entity) body.entity_id = entity;
  return haFetch(config, `/services/${domain}/${name}`, { method: 'POST', body });
}

// --- Print-farm ⇄ Home Assistant automation rules -------------------------
// Stored as an array in app_settings under HA_RULES_KEY and evaluated by the
// background engine below. Two directions, each a flat object with `direction`,
// `enabled`, a `name`, and the fields that direction needs.
const HA_RULES_KEY = 'ha_automation_rules';
const HA_RULE_DIRECTIONS = new Set(['ha_to_printer', 'printer_to_ha']);
const HA_PRINTER_COMMANDS = new Set(['pause', 'resume', 'cancel']);
const HA_PRINTER_STATUSES = new Set(['printing', 'idle', 'paused', 'error', 'offline']);

async function getHaRules() {
  const stored = await getAppSetting(HA_RULES_KEY);
  return Array.isArray(stored) ? stored : [];
}

// Validate + normalize a rule create/update body. Throws Error (message → 400) on
// invalid input; returns the clean rule fields (without id/createdAt).
function normalizeHaRuleInput(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('a rule body is required');
  }
  const direction = String(body.direction || '');
  if (!HA_RULE_DIRECTIONS.has(direction)) {
    throw new Error('direction must be ha_to_printer or printer_to_ha');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    throw new Error('name is required');
  }
  const enabled = body.enabled !== false; // default on
  const printerId = typeof body.printerId === 'string' ? body.printerId.trim() : '';
  if (!printerId) {
    throw new Error('printerId is required');
  }

  if (direction === 'ha_to_printer') {
    const triggerEntity = typeof body.triggerEntity === 'string' ? body.triggerEntity.trim() : '';
    const triggerState = typeof body.triggerState === 'string' ? body.triggerState.trim() : '';
    const printerCommand = typeof body.printerCommand === 'string' ? body.printerCommand.trim() : '';
    if (!triggerEntity || !triggerState) {
      throw new Error('triggerEntity and triggerState are required');
    }
    if (!HA_PRINTER_COMMANDS.has(printerCommand)) {
      throw new Error('printerCommand must be pause, resume, or cancel');
    }
    return { direction, name, enabled, printerId, triggerEntity, triggerState, printerCommand };
  }

  // printer_to_ha
  const printerStatus = typeof body.printerStatus === 'string' ? body.printerStatus.trim() : '';
  const actionService = typeof body.actionService === 'string' ? body.actionService.trim() : '';
  const actionEntity = typeof body.actionEntity === 'string' ? body.actionEntity.trim() : '';
  if (!HA_PRINTER_STATUSES.has(printerStatus)) {
    throw new Error('printerStatus must be printing, idle, paused, error, or offline');
  }
  if (!/^[a-z_]+\.[a-z0-9_]+$/i.test(actionService)) {
    throw new Error('actionService must look like domain.service, e.g. switch.turn_off');
  }
  let actionData = {};
  if (body.actionData !== undefined && body.actionData !== null && body.actionData !== '') {
    try {
      actionData = typeof body.actionData === 'string' ? JSON.parse(body.actionData) : body.actionData;
    } catch {
      throw new Error('actionData must be valid JSON');
    }
    if (typeof actionData !== 'object' || Array.isArray(actionData)) {
      throw new Error('actionData must be a JSON object');
    }
  }
  return { direction, name, enabled, printerId, printerStatus, actionService, actionEntity, actionData };
}

// Send a pause/resume/cancel to a printer regardless of profile: Bambu over MQTT,
// everything else (Snapmaker U1 / Moonraker) over its HTTP API at printer.url.
async function dispatchPrintControl(printer, command) {
  if (!HA_PRINTER_COMMANDS.has(command)) {
    throw new Error(`Unsupported print command: ${command}`);
  }
  if (BAMBU_PROFILES.has(printer.profile)) {
    await sendBambuCommand(printer, command, {});
    return;
  }
  const base = (printer.url || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error(`Printer ${printer.id} has no URL for HTTP control`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/printer/print/${command}`, {
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`printer responded HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Background engine: detects state transitions and fires the matching rules. It
// remembers the last-seen value per key and only acts on a transition *into* the
// target (prev !== current && current === target); a key seen for the first time
// is recorded as a baseline without firing, so adding a rule (or restarting)
// doesn't replay against the current state.
const HA_ENGINE_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.HA_AUTOMATION_INTERVAL_MS || '15000', 10) || 15000,
);
const haEngineLastPrinterStatus = new Map();
const haEngineLastEntityState = new Map();
let haEngineRunning = false;

async function evaluateHaRules() {
  if (haEngineRunning) return; // never overlap cycles
  haEngineRunning = true;
  try {
    const config = await getHomeAssistantConfig();
    if (!config.enabled || !config.baseUrl || !config.token) return;
    const rules = (await getHaRules()).filter((rule) => rule.enabled);
    if (rules.length === 0) return;

    const printerToHa = rules.filter((rule) => rule.direction === 'printer_to_ha');
    const haToPrinter = rules.filter((rule) => rule.direction === 'ha_to_printer');

    // printer → HA: read each referenced printer's current status, detect the
    // transition into the rule's target status, then call the HA service.
    if (printerToHa.length > 0) {
      const printerIds = [...new Set(printerToHa.map((rule) => rule.printerId))];
      const statusById = new Map();
      for (const printerId of printerIds) {
        const printer = await getPrinterById(printerId).catch(() => null);
        if (printer) statusById.set(printerId, printer.status || 'offline');
      }
      for (const rule of printerToHa) {
        const current = statusById.get(rule.printerId);
        if (current === undefined) continue; // printer gone
        const key = `p:${rule.printerId}`;
        const prev = haEngineLastPrinterStatus.get(key);
        haEngineLastPrinterStatus.set(key, current);
        if (prev === undefined || prev === current || current !== rule.printerStatus) continue;
        const result = await callHaService(config, rule.actionService, rule.actionEntity, rule.actionData);
        if (result.ok) {
          logger.info('ha rule fired (printer→ha)', { rule: rule.id, printer: rule.printerId, status: current });
        } else {
          logger.warn('ha rule action failed (printer→ha)', { rule: rule.id, error: result.error });
        }
      }
    }

    // HA → printer: one /states read, detect the transition into the rule's target
    // entity state, then send the printer command.
    if (haToPrinter.length > 0) {
      const result = await haFetch(config, '/states');
      if (!result.ok) {
        logger.warn('ha rule engine could not read states', { error: result.error });
        return;
      }
      const stateByEntity = new Map();
      for (const entity of Array.isArray(result.data) ? result.data : []) {
        if (entity && typeof entity.entity_id === 'string') {
          stateByEntity.set(entity.entity_id, typeof entity.state === 'string' ? entity.state : '');
        }
      }
      for (const rule of haToPrinter) {
        const current = stateByEntity.get(rule.triggerEntity);
        if (current === undefined) continue; // entity not present
        const key = `e:${rule.triggerEntity}`;
        const prev = haEngineLastEntityState.get(key);
        haEngineLastEntityState.set(key, current);
        if (prev === undefined || prev === current || current !== rule.triggerState) continue;
        const printer = await getPrinterById(rule.printerId).catch(() => null);
        if (!printer) {
          logger.warn('ha rule target printer missing (ha→printer)', { rule: rule.id, printer: rule.printerId });
          continue;
        }
        try {
          await dispatchPrintControl(printer, rule.printerCommand);
          logger.info('ha rule fired (ha→printer)', {
            rule: rule.id,
            entity: rule.triggerEntity,
            command: rule.printerCommand,
          });
        } catch (err) {
          logger.warn('ha rule command failed (ha→printer)', {
            rule: rule.id,
            error: err && err.message ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    logger.error('ha rule engine cycle failed', { error: err && err.message ? err.message : String(err) });
  } finally {
    haEngineRunning = false;
  }
}

let haEngineTimer = null;
function startHaAutomationEngine() {
  if (haEngineTimer) return;
  haEngineTimer = setInterval(() => {
    evaluateHaRules().catch(() => {});
  }, HA_ENGINE_INTERVAL_MS);
  if (typeof haEngineTimer.unref === 'function') haEngineTimer.unref();
  logger.info('home assistant automation engine started', { intervalMs: HA_ENGINE_INTERVAL_MS });
}

// Website access mode: whether an unauthenticated visitor may view the dashboard
// read-only (a "public viewer" session) or is bounced to the login screen.
// Stored in app_settings and read fresh; defaults to enabled to preserve the
// prior behavior where anonymous visitors fell back to a viewer session.
const PUBLIC_VIEWER_KEY = 'public_viewer';

async function getPublicViewerSetting() {
  const stored = (await getAppSetting(PUBLIC_VIEWER_KEY)) || {};
  return { enabled: stored.enabled !== false };
}

// Configurable window during which the public print-request form (/request)
// accepts new submissions. Stored in app_settings; defaults to disabled (queue
// always open) so existing installs aren't suddenly locked out until an admin
// opts in.
const QUEUE_AVAILABILITY_KEY = 'queue_availability';
const QUEUE_AVAILABILITY_DEFAULTS = {
  enabled: false,
  timezone: 'Asia/Bangkok',
  days: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  closedMessage: 'The print queue is currently closed. Please check back during open hours.',
};

async function getQueueAvailabilitySetting() {
  const stored = (await getAppSetting(QUEUE_AVAILABILITY_KEY)) || {};
  return { ...QUEUE_AVAILABILITY_DEFAULTS, ...stored };
}

// A short-lived manual override an operator/admin can trigger from the Queue
// page to reopen /request to everyone (e.g. students) even though the
// configured schedule above has it closed — without touching the persisted
// schedule settings. Stored separately from QUEUE_AVAILABILITY_KEY so it
// can't be clobbered by (or clobber) an admin editing the schedule.
const QUEUE_AVAILABILITY_BYPASS_KEY = 'queue_availability_bypass';
const QUEUE_AVAILABILITY_BYPASS_MS = 3 * 60 * 1000;

// Returns { until, activatedBy } while a manual bypass is active, else null.
async function getQueueAvailabilityBypass() {
  const stored = await getAppSetting(QUEUE_AVAILABILITY_BYPASS_KEY);
  const untilMs = stored?.until ? Date.parse(stored.until) : NaN;
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
    return null;
  }
  return { until: stored.until, activatedBy: stored.activatedBy || null };
}

// Combines the manual bypass with the configured schedule — the bypass wins
// (and reports `open: true`) while it's still within its window.
async function getQueueAvailabilityStatus() {
  const bypass = await getQueueAvailabilityBypass();
  if (bypass) {
    return { open: true, bypassUntil: bypass.until };
  }
  return evaluateQueueAvailability(await getQueueAvailabilitySetting());
}

// Evaluates whether the queue is currently open, computing "now" in the
// setting's configured IANA timezone rather than the container's ambient TZ
// (commonly UTC in Docker) — otherwise "9am-5pm" would silently mean UTC to
// an admin expecting local time.
function evaluateQueueAvailability(setting) {
  if (!setting.enabled) {
    return { open: true };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: setting.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[parts.find((p) => p.type === 'weekday').value];
  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  const nowMinutes = hour * 60 + minute;

  const [startH, startM] = setting.startTime.split(':').map(Number);
  const [endH, endM] = setting.endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const dayOk = setting.days.includes(weekday);
  const timeOk = nowMinutes >= startMinutes && nowMinutes < endMinutes;
  if (dayOk && timeOk) {
    return { open: true };
  }
  return { open: false, message: setting.closedMessage };
}

function isValidIanaTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// OAuth (SSO) sign-in config. Two providers are supported — Google and Microsoft
// Entra ID (Azure AD) — and each is configured independently in Settings →
// Sign-in (client id/secret, optional allowed-email-domain list, and, for
// Microsoft, the directory tenant). Config is persisted per provider in
// app_settings. Anyone who authenticates this way is granted the read-only
// `student` role. The clientSecret is never returned by a read path — only
// whether one is configured.
//
// Both providers speak OAuth 2.0 Authorization Code + OIDC, so they differ only
// in their authorize/token endpoints (Microsoft's are tenant-scoped) and in which
// id_token claim carries the email (Google: `email`; Microsoft often only
// `preferred_username`/`upn`). The registry below captures those differences.
const OAUTH_PROVIDERS = {
  google: {
    settingsKey: 'oauth_google',
    label: 'Google',
    usesTenant: false,
    authorizeEndpoint: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: () => 'https://oauth2.googleapis.com/token',
  },
  microsoft: {
    settingsKey: 'oauth_microsoft',
    label: 'Microsoft',
    usesTenant: true,
    // Two modes. With an `authority` set (on-prem AD FS, e.g.
    // https://sso.example.com/adfs) the OIDC endpoints are <authority>/oauth2/*.
    // Otherwise fall back to Microsoft cloud (Entra ID), which is tenant-scoped.
    authorizeEndpoint: (config) =>
      config.authority
        ? `${config.authority.replace(/\/+$/, '')}/oauth2/authorize`
        : `https://login.microsoftonline.com/${encodeURIComponent(
            config.tenant || 'common',
          )}/oauth2/v2.0/authorize`,
    tokenEndpoint: (config) =>
      config.authority
        ? `${config.authority.replace(/\/+$/, '')}/oauth2/token`
        : `https://login.microsoftonline.com/${encodeURIComponent(
            config.tenant || 'common',
          )}/oauth2/v2.0/token`,
  },
  // ADFS — endpoints are derived from the `authority` base URL configured in
  // Settings → Sign-in. `authority` is required; the provider is not considered
  // configured without it. The redirect_uri is the fixed path
  // /api/auth/oauth2_redirect as registered with the IdP.
  adfs: {
    settingsKey: 'oauth_adfs',
    label: 'ADFS',
    usesTenant: false,
    requiresAuthority: true,
    authorizeEndpoint: (config) =>
      config.authorizeEndpoint || `${config.authority.replace(/\/+$/, '')}/oauth2/authorize`,
    tokenEndpoint: (config) =>
      config.tokenEndpoint || `${config.authority.replace(/\/+$/, '')}/oauth2/token`,
    logoutEndpoint: (config) =>
      config.logoutEndpoint || `${config.authority.replace(/\/+$/, '')}/oauth2/logout`,
    callbackPath: '/api/auth/oauth2_redirect',
  },
};
const OAUTH_SCOPE = 'openid email profile';
const OAUTH_SIGNING_SECRET_KEY = 'oauth_signing_secret';
// The role every SSO sign-in lands on. Read-only, like the public viewer.
const OAUTH_DEFAULT_ROLE = 'student';

function getOAuthProvider(name) {
  return Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, name)
    ? OAUTH_PROVIDERS[name]
    : null;
}

async function getOAuthConfig(providerName) {
  const provider = getOAuthProvider(providerName);
  if (!provider) {
    return null;
  }
  const stored = (await getAppSetting(provider.settingsKey)) || {};
  const allowedDomains = Array.isArray(stored.allowedDomains)
    ? stored.allowedDomains
        .map((domain) => String(domain || '').trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
    : [];

  const clientId = typeof stored.clientId === 'string' ? stored.clientId.trim() : '';
  const clientSecret = typeof stored.clientSecret === 'string' ? stored.clientSecret : '';
  const enabled = stored.enabled === true;

  return {
    provider: providerName,
    enabled,
    clientId,
    clientSecret,
    tenant: typeof stored.tenant === 'string' ? stored.tenant.trim() : '',
    // On-prem AD FS authority base (e.g. https://host/adfs); blank = use cloud.
    authority: typeof stored.authority === 'string' ? stored.authority.trim() : '',
    allowedDomains,
    // Custom label shown on the login-page sign-in button (e.g. "Sign in with Satit-M").
    // Falls back to the provider's built-in label when blank.
    displayName: typeof stored.displayName === 'string' ? stored.displayName.trim() : '',
    // ADFS: the full redirect_uri pre-registered with the IdP. When set, used
    // verbatim instead of computing it from request headers (which breaks behind
    // a TLS-terminating proxy that doesn't forward X-Forwarded-Proto/Host).
    redirectUri: typeof stored.redirectUri === 'string' ? stored.redirectUri.trim() : '',
    authorizeEndpoint: typeof stored.authorizeEndpoint === 'string' ? stored.authorizeEndpoint.trim() : '',
    tokenEndpoint: typeof stored.tokenEndpoint === 'string' ? stored.tokenEndpoint.trim() : '',
    logoutEndpoint: typeof stored.logoutEndpoint === 'string' ? stored.logoutEndpoint.trim() : '',
    metadataUrl: typeof stored.metadataUrl === 'string' ? stored.metadataUrl.trim() : '',
    jwksUri: typeof stored.jwksUri === 'string' ? stored.jwksUri.trim() : '',
    relyingPartyId: typeof stored.relyingPartyId === 'string' ? stored.relyingPartyId.trim() : '',
  };
}

// True only when the flow can actually run: enabled + credentials + any
// provider-specific required fields (Microsoft needs tenant or authority; ADFS
// needs authority since its endpoints are derived from it).
function isOAuthConfigured(config) {
  if (!config || !config.enabled || !config.clientId || !config.clientSecret) {
    return false;
  }
  const provider = getOAuthProvider(config.provider);
  if (provider?.usesTenant && !config.tenant && !config.authority) {
    return false;
  }
  if (provider?.requiresAuthority && !config.authority) {
    return false;
  }
  return true;
}

// Pull the user's email out of the id_token claims. Google always populates
// `email`; Microsoft Entra ID commonly omits it and carries the address in
// `preferred_username` (or `upn`), so fall back across all three.
function oauthClaimEmail(claims) {
  if (!claims) {
    return '';
  }
  for (const candidate of [claims.email, claims.preferred_username, claims.upn, claims.unique_name]) {
    if (typeof candidate === 'string' && candidate.includes('@')) {
      return candidate.toLowerCase();
    }
  }
  return '';
}

// HMAC secret for the state/grant tokens. Kept in app_settings (not env) so the
// whole OAuth setup stays runtime-configurable; generated once on first use.
async function getOAuthSigningSecret() {
  const stored = await getAppSetting(OAUTH_SIGNING_SECRET_KEY);
  if (stored && typeof stored.secret === 'string' && stored.secret.length >= 32) {
    return stored.secret;
  }
  const secret = randomBytes(32).toString('base64url');
  await setAppSetting(OAUTH_SIGNING_SECRET_KEY, { secret });
  return secret;
}

// Admin-settable override for the site's own public origin (Settings → Sign-in).
// Takes precedence over APP_BASE_URL and header-detection below — lets an admin
// fix SSO callback URLs at runtime with no redeploy when the reverse-proxy setup
// doesn't produce a correct Host / X-Forwarded-Host.
const SSO_PUBLIC_URL_KEY = 'sso_public_url';

// Admin-settable LAN address the H2-series Bambu printers use to fetch a
// staged print file back from slicer-proxy over HTTP (see uploadToBambu /
// buildTmpFileUrl in slicer-proxy/index.js — the H2 family's firmware refuses
// FTP writes, so slicer-proxy hosts the file itself and hands the printer a
// URL instead). Auto-detecting this from request headers is unreliable: the
// slicer's Print Farm URL is often "http://localhost:8080" when it runs on the
// same machine as the farm server, which the physical printer obviously can't
// resolve to anything useful. Read directly by slicer-proxy via
// getAppSetting('printer_callback_url') — keep this key literal in sync with
// the one there if it ever changes.
const PRINTER_CALLBACK_URL_KEY = 'printer_callback_url';

function normalizePrinterCallbackUrl(raw) {
  const base = String(raw || '').trim();
  return base ? base.replace(/\/+$/, '') : '';
}

// Strip a trailing slash so callers can safely append a path (e.g.
// "/api/auth/saml/acs"). Does not validate scheme — the PUT handler does that.
function normalizeSsoPublicUrl(raw) {
  const base = String(raw || '').trim();
  return base ? base.replace(/\/+$/, '') : '';
}

async function getSsoPublicUrl() {
  const stored = await getAppSetting(SSO_PUBLIC_URL_KEY);
  return normalizeSsoPublicUrl(stored?.publicUrl);
}

// The public origin used to build OAuth redirect_uri / SAML ACS URLs, resolved in
// priority order: (1) the admin-set Settings → Sign-in value, (2) the APP_BASE_URL
// env var, (3) the request headers (X-Forwarded-Proto/-Host, Host) — which only
// work correctly when the reverse proxy forwards them. The redirect_uri must match
// this exactly and be registered with the provider (Google Cloud console / Azure
// app registration / AD FS relying-party).
async function resolvePublicOrigin(req) {
  const configured = await getSsoPublicUrl();
  if (configured) return configured;
  const envConfigured = normalizeSsoPublicUrl(process.env.APP_BASE_URL);
  if (envConfigured) return envConfigured;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

async function oauthRedirectUri(req, providerName, config = null) {
  // Use the stored redirect URI when set — avoids relying on proxy headers to
  // reconstruct the origin (required for ADFS whose URI is pre-registered).
  if (config?.redirectUri) return config.redirectUri;
  const provider = getOAuthProvider(providerName);
  const path = provider?.callbackPath ?? `/api/auth/${providerName}/callback`;
  return `${await resolvePublicOrigin(req)}${path}`;
}

// Shared Authorization Code exchange + identity extraction. Used by both the
// standard /api/auth/:provider/callback routes and the fixed
// /api/auth/oauth2_redirect path registered for ADFS.
async function oauthExchangeCallback(req, res, requestUrl, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  const config = await getOAuthConfig(providerName);
  if (!isOAuthConfigured(config)) {
    sendRedirect(res, '/login?oauth_error=not_configured');
    return;
  }
  const secret = await getOAuthSigningSecret();
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const stateData = verifyState(secret, state);
  if (requestUrl.searchParams.get('error') || !code || !stateData || stateData.p !== providerName) {
    sendRedirect(res, '/login?oauth_error=denied');
    return;
  }

  try {
    const tokenResponse = await fetch(provider.tokenEndpoint(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: await oauthRedirectUri(req, providerName, config),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) {
      sendRedirect(res, '/login?oauth_error=exchange_failed');
      return;
    }
    const tokens = await tokenResponse.json();
    // The id_token comes straight from the provider's token endpoint over TLS
    // using our client secret, so its claims are trusted without re-verifying
    // the signature; we only need the identity fields out of the payload.
    const claims = decodeJwtClaims(tokens.id_token);
    const email = oauthClaimEmail(claims);
    // Google sets email_verified; Microsoft / ADFS omit it (institutional accounts
    // are verified at directory level), so only reject when explicitly false.
    if (!email || claims?.email_verified === false) {
      sendRedirect(res, '/login?oauth_error=unverified_email');
      return;
    }
    if (config.allowedDomains.length > 0) {
      const domain = email.slice(email.indexOf('@') + 1);
      if (!config.allowedDomains.includes(domain)) {
        sendRedirect(res, '/login?oauth_error=domain_not_allowed');
        return;
      }
    }
    const grant = mintAuthGrant(secret, {
      provider: providerName,
      sub: typeof claims.sub === 'string' ? claims.sub : email,
      email,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email,
      role: OAUTH_DEFAULT_ROLE,
    });
    sendRedirect(res, `/login?oauth_grant=${encodeURIComponent(grant)}`);
  } catch {
    sendRedirect(res, '/login?oauth_error=exchange_failed');
  }
}

// SAML 2.0 SSO (the dashboard is the Service Provider). Like OAuth, config lives
// in app_settings and is read fresh on every request, so an admin can change it
// in Settings → SSO Configuration with no restart. The flow reuses the cookieless
// grant-token hand-off: the ACS verifies the signed assertion, mints the same
// HMAC auth grant OAuth uses, and redirects the browser to /login?oauth_grant=.
const SAML_SETTINGS_KEY = 'saml_sso';
// Roles an asserted `role` attribute may map onto; anything else falls back to
// the read-only `student` role (matching the OAuth default).
const SAML_ALLOWED_ROLES = new Set(['admin', 'operator', 'viewer', 'student']);
const SAML_DEFAULT_ROLE = 'student';

// Default SP identifiers derived from the public origin when an admin leaves the
// fields blank. These are also what the metadata endpoint advertises.
async function defaultSamlSpEntityId(req) {
  return `${await resolvePublicOrigin(req)}/api/auth/saml/metadata`;
}
async function defaultSamlAcsUrl(req) {
  return `${await resolvePublicOrigin(req)}/api/auth/saml/acs`;
}

async function getSamlConfig() {
  const stored = (await getAppSetting(SAML_SETTINGS_KEY)) || {};
  return {
    enabled: stored.enabled === true,
    idpEntityId: typeof stored.idpEntityId === 'string' ? stored.idpEntityId.trim() : '',
    idpSsoUrl: typeof stored.idpSsoUrl === 'string' ? stored.idpSsoUrl.trim() : '',
    idpCertificate: typeof stored.idpCertificate === 'string' ? stored.idpCertificate.trim() : '',
    spEntityId: typeof stored.spEntityId === 'string' ? stored.spEntityId.trim() : '',
    acsUrl: typeof stored.acsUrl === 'string' ? stored.acsUrl.trim() : '',
    autoProvisionUsers: stored.autoProvisionUsers === true,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    displayName: typeof stored.displayName === 'string' ? stored.displayName.trim() : '',
  };
}

// True only when the flow can actually run: enabled, with an IdP SSO URL and a
// signing certificate to verify assertions against.
function isSamlConfigured(config) {
  return Boolean(config && config.enabled && config.idpSsoUrl && config.idpCertificate);
}

// Resolve the effective SP entity id / ACS URL, falling back to the request
// origin when an admin left them blank.
async function resolveSamlEndpoints(config, req) {
  return {
    spEntityId: config.spEntityId || (await defaultSamlSpEntityId(req)),
    acsUrl: config.acsUrl || (await defaultSamlAcsUrl(req)),
  };
}

// Map an asserted role onto an allowed dashboard role; unknown/blank → student.
function normalizeSamlRole(role) {
  return SAML_ALLOWED_ROLES.has(role) ? role : SAML_DEFAULT_ROLE;
}

// Send a 302 to a path/URL on the dashboard (or the provider). Used by the OAuth
// start/callback hops, which redirect the browser rather than return JSON.
function sendRedirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// Decode the claims (middle segment) of a JWT without verifying its signature.
// Safe here because the id_token is received directly from the provider's token
// endpoint over TLS using our client secret — server-to-server, not via the
// browser — so the payload is already trusted. Returns null on malformed input.
function decodeJwtClaims(jwt) {
  if (typeof jwt !== 'string') {
    return null;
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
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

// The website background is a full-page image, so it gets a larger cap than the
// logo. ~4 MB of data URL ~= a 3 MB image after base64.
const MAX_BACKGROUND_DATA_URL_BYTES = 4 * 1024 * 1024;

// Favicons are small; ~350 KB data URL ~= a 256 KB image after base64.
const MAX_FAVICON_DATA_URL_BYTES = 350 * 1024;

// The branding PUT can carry logo, background, and favicon data URLs at once, so
// its body limit must fit all three plus the surrounding JSON envelope.
const MAX_BRANDING_BODY_BYTES =
  MAX_LOGO_DATA_URL_BYTES + MAX_BACKGROUND_DATA_URL_BYTES + MAX_FAVICON_DATA_URL_BYTES + 16 * 1024;

// Allowed logo size multiplier range (1 = the built-in default size).
const MIN_LOGO_SCALE = 0.5;
const MAX_LOGO_SCALE = 2;

// Site name shown in the browser tab and dashboard heading. Empty = the bundled
// default name. Capped so it can't bloat the row or overflow the UI.
const MAX_SITE_NAME_LENGTH = 120;

function clampLogoScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_LOGO_SCALE, Math.max(MIN_LOGO_SCALE, Math.round(scale * 100) / 100));
}

async function getBranding() {
  const stored = (await getAppSetting(BRANDING_KEY)) || {};
  return {
    siteName: typeof stored.siteName === 'string' ? stored.siteName : '',
    logoDataUrl: typeof stored.logoDataUrl === 'string' ? stored.logoDataUrl : '',
    logoSvg: typeof stored.logoSvg === 'string' ? stored.logoSvg : '',
    logoAdaptive: stored.logoAdaptive === true,
    logoScale: clampLogoScale(stored.logoScale ?? 1),
    backgroundDataUrl: typeof stored.backgroundDataUrl === 'string' ? stored.backgroundDataUrl : '',
    faviconDataUrl: typeof stored.faviconDataUrl === 'string' ? stored.faviconDataUrl : '',
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
  const hasDangerousCss = (css) =>
    /javascript:|expression\(|url\s*\(\s*['"]?\s*(?:javascript|data|https?|file|blob):/i.test(css);
  return svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // M-6 FIX: drop scripting, external-resource, and animation elements. SMIL
    // animation (<animate>/<set>/<animateTransform>/<animateMotion>) can set an
    // element's attribute (including href) to a script/navigation URL, so it is
    // an XSS vector even without an inline handler; <script>/<foreignObject>/
    // <handler>/<listener> execute directly.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<\/?(?:script|foreignObject|animate|animateTransform|animateMotion|set|handler|listener)\b[^>]*>/gi, '')
    // M-6 FIX: event-handler attributes — quoted (") or (') *and* unquoted
    // (onerror=alert(1)); the old sanitizer only stripped the quoted forms.
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    // href / xlink:href pointing at script or external/data URLs, in any quoting.
    // Local fragment refs (href="#gradient") are left intact.
    .replace(/(?:xlink:href|href)\s*=\s*"\s*(?:javascript|data|https?|file|blob):[^"]*"/gi, '')
    .replace(/(?:xlink:href|href)\s*=\s*'\s*(?:javascript|data|https?|file|blob):[^']*'/gi, '')
    .replace(/(?:xlink:href|href)\s*=\s*(?:javascript|data|https?|file|blob):[^\s>]*/gi, '')
    // M-6 FIX: CSS payloads inside style="" — javascript:, expression(), and
    // url() to a remote/script scheme. Only strip the style attribute when it
    // carries a dangerous token so legitimate url(#localGradient) refs survive.
    .replace(/style\s*=\s*"([^"]*)"/gi, (m, css) => (hasDangerousCss(css) ? '' : m))
    .replace(/style\s*=\s*'([^']*)'/gi, (m, css) => (hasDangerousCss(css) ? '' : m))
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

// Hash of dist/index.html, set once in assertProductionInputs(). Changes on
// every new deploy so the frontend's version poll can prompt users to reload.
let BUILD_ID = 'dev';

// Git commit SHA baked into the image at build time (Dockerfile.web ARG
// APP_VERSION, passed by CI as ${{ github.sha }}). This is the *running*
// version the admin update check compares against the latest published commit.
// Falls back to BUILD_ID ('dev' for local runs) when not stamped.
const APP_VERSION = (process.env.APP_VERSION || '').trim();
function runningVersion() {
  return APP_VERSION || BUILD_ID;
}

// Admin "update available" check config. UPDATE_CHECK_REPO ("owner/repo") turns
// the feature on; when unset the endpoint reports { enabled: false } and the UI
// hides the card. UPDATE_CHECK_TOKEN (optional) lifts GitHub's 60-req/hr
// unauthenticated limit / reaches private repos. The one-click apply calls a
// Watchtower sidecar's HTTP API (WATCHTOWER_URL + WATCHTOWER_TOKEN).
const UPDATE_CHECK_REPO = (process.env.UPDATE_CHECK_REPO || '').trim();
const UPDATE_CHECK_BRANCH = (process.env.UPDATE_CHECK_BRANCH || 'main').trim();
const UPDATE_CHECK_TOKEN = (process.env.UPDATE_CHECK_TOKEN || '').trim();
const UPDATE_CHECK_TTL_MS = Number.parseInt(process.env.UPDATE_CHECK_TTL_MS || String(20 * 60 * 1000), 10);
const WATCHTOWER_URL = (process.env.WATCHTOWER_URL || 'http://watchtower:8080/v1/update').trim();
const WATCHTOWER_TOKEN = (process.env.WATCHTOWER_TOKEN || '').trim();
// Cached latest-commit lookup, shared across admins so GitHub is polled at most
// once per TTL regardless of how many browsers are watching.
let updateCheckCache = null; // { latest, latestCommittedAt, checkedAt }

async function fetchLatestCommit(force = false) {
  if (!UPDATE_CHECK_REPO) return null;
  const now = Date.now();
  // A manual "Check again" (force) bypasses the TTL cache so a just-pushed
  // commit shows up immediately instead of after the cache window.
  if (!force && updateCheckCache && now - updateCheckCache.checkedAt < UPDATE_CHECK_TTL_MS) {
    return updateCheckCache;
  }
  const url = `https://api.github.com/repos/${UPDATE_CHECK_REPO}/commits/${encodeURIComponent(UPDATE_CHECK_BRANCH)}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'printfarm-update-check' };
  if (UPDATE_CHECK_TOKEN) headers.Authorization = `Bearer ${UPDATE_CHECK_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`GitHub responded ${resp.status}`);
    }
    const data = await resp.json();
    const latest = typeof data?.sha === 'string' ? data.sha : null;
    if (!latest) throw new Error('GitHub response missing sha');
    const latestCommittedAt =
      data?.commit?.committer?.date || data?.commit?.author?.date || null;
    updateCheckCache = { latest, latestCommittedAt, checkedAt: now };
    return updateCheckCache;
  } finally {
    clearTimeout(timer);
  }
}

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

// ── Password hashing at rest (server-side KDF) ───────────────────────────────
// The browser still hashes the password to a sha256 before sending it, so the
// plaintext never crosses the wire even on a plain-http :8080 deployment. The
// server then runs that sha256 through a slow, salted scrypt KDF before storing
// it. A leaked database therefore no longer yields a fast, unsalted, directly
// replayable hash — an attacker must brute-force scrypt per account. Stored
// format is a single self-describing string:
//   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
// Records created before this change are a bare 64-char sha256 hex; verifyPassword
// accepts both, and the login path lazily re-stores legacy records in the new
// format on the next successful sign-in (transparent migration).
const scryptAsync = promisify(scrypt);
const SCRYPT_N = 16384; // CPU/memory cost (~16 MB at r=8); within node's 32 MB default maxmem.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function isScryptHash(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

// A value accepted as input when storing a credential: either a fresh client
// sha256 (which we derive) or an already-derived scrypt string (host→host user
// migration through the key-gated /api/v1 surface, stored verbatim).
function isStorablePasswordHash(value) {
  return isSha256Hex(value) || isScryptHash(value);
}

// Derive the stored credential string from a client-supplied sha256 hex.
async function derivePasswordHash(clientSha256) {
  const normalized = String(clientSha256).toLowerCase();
  const salt = randomBytes(16);
  const derived = await scryptAsync(normalized, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Coerce a credential input into its stored form: derive a sha256, pass a scrypt
// string through unchanged, or return null when the input is neither.
async function toStoredPasswordHash(value) {
  if (isScryptHash(value)) {
    return value;
  }
  if (isSha256Hex(value)) {
    return derivePasswordHash(value);
  }
  return null;
}

// True when a stored credential is in the legacy bare-sha256 format and should be
// upgraded to scrypt after a successful verify.
function passwordNeedsUpgrade(stored) {
  return isSha256Hex(stored);
}

// Verify a client-supplied sha256 against a stored credential (scrypt or legacy
// bare-sha256), in constant time.
async function verifyPassword(stored, clientSha256) {
  if (typeof stored !== 'string' || !stored || !isSha256Hex(clientSha256)) {
    return false;
  }
  const normalized = clientSha256.toLowerCase();
  if (!isScryptHash(stored)) {
    // Legacy record: compare against the stored sha256 directly.
    return timingSafeEqualString(stored.toLowerCase(), normalized);
  }
  const parts = stored.split('$'); // scrypt, N, r, p, saltHex, hashHex
  if (parts.length !== 6) {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!N || !r || !p || salt.length === 0 || expected.length === 0) {
    return false;
  }
  let derived;
  try {
    derived = await scryptAsync(normalized, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// The stored staff-user list, or [] when none have been created yet.
async function readStaffUsers() {
  const stored = await getAppSetting(STAFF_USERS_KEY);
  return Array.isArray(stored) ? stored : [];
}

// Find the staff record matching a username + client sha256, verifying the
// password against either credential format (scrypt or legacy). A plain Array
// .find can't be used because verifyPassword is async.
async function findUserByCredential(usersList, username, clientSha256) {
  for (const candidate of usersList) {
    if (
      candidate.username === username &&
      (await verifyPassword(candidate.passwordHash, clientSha256))
    ) {
      return candidate;
    }
  }
  return undefined;
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

// Like sanitizeStaffUser but keeps the stored sha256 password hash. Only for the
// key-gated /api/v1 surface, where the key is the guard and secrets are not
// redacted (mirroring admin-credential). Never use on the cookieless frontend
// /api/users path, which must stay sanitized.
function staffUserWithHash(record) {
  return {
    ...sanitizeStaffUser(record),
    passwordHash: record.passwordHash || null,
  };
}

// Client IP used for the audit trail AND for login rate limiting, so it must not
// be spoofable from a client-supplied header. nginx sets X-Real-IP and replaces
// X-Forwarded-For with the real peer address ($remote_addr), so we trust, in
// order: X-Real-IP, then the RIGHTMOST X-Forwarded-For value (the hop appended by
// the trusted proxy — the leftmost is attacker-controllable on a multi-value
// header), then the socket peer. Reading the rightmost token means a client that
// injects its own `X-Forwarded-For: <fake>` can no longer mint a fresh rate-limit
// bucket per request.
function getClientIp(req) {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket?.remoteAddress || null;
}

// ── SSRF guard for admin-supplied outbound URLs ──────────────────────────────
// H-3 FIX: endpoints that fetch an admin-configured URL (e.g. the SAML "test
// connection" probe) must not be usable to reach the loopback interface, the
// LAN, or the cloud metadata endpoint (169.254.169.254). Reject any URL whose
// host resolves to a private/reserved address before making the request. This
// is DNS-resolution based (an IP literal is checked directly; a hostname is
// resolved and every A/AAAA answer is checked), which closes the common SSRF
// vectors. A determined DNS-rebinding attacker with control of an authoritative
// resolver is out of scope for this admin-only diagnostic.
function isPrivateOrReservedIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 (IMDS)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved / broadcast
    return false;
  }
  if (kind === 6) {
    let v6 = ip.toLowerCase();
    const zone = v6.indexOf('%'); // strip a scope/zone id (fe80::1%eth0)
    if (zone !== -1) v6 = v6.slice(0, zone);
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    if (v6.startsWith('fe80')) return true; // link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local fc00::/7
    // IPv4-mapped/compatible/translated forms embed an IPv4 address in the low
    // 32 bits — extract and re-check it, covering both the dotted tail
    // (::ffff:127.0.0.1) and the hex tail (::ffff:7f00:1) an attacker could use
    // to smuggle a loopback/LAN literal past a dotted-only check.
    const embedded = embeddedIpv4FromV6(v6);
    if (embedded) return isPrivateOrReservedIp(embedded);
    return false;
  }
  return true; // not a valid IP literal → refuse
}

// Extract the IPv4 address embedded in an IPv4-mapped/compatible/translated IPv6
// literal (…:a.b.c.d dotted, or …:hhhh:hhhh hex), or null if there is none.
function embeddedIpv4FromV6(v6) {
  const dotted = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(v6);
  if (dotted && isIP(dotted[1]) === 4) return dotted[1];
  // Hex tail: last two 16-bit groups encode the four octets (e.g. 7f00:0001).
  const hex = /:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex && (v6.startsWith('::ffff:') || v6.startsWith('::') || v6.startsWith('64:ff9b'))) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

// Resolve the URL's host and throw if it points at a private/reserved address.
async function assertPublicHttpTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported URL scheme');
  }
  const host = parsed.hostname;
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error('target address is not allowed');
    return;
  }
  const answers = await dnsLookup(host, { all: true });
  if (!answers.length) throw new Error('host did not resolve');
  for (const { address } of answers) {
    if (isPrivateOrReservedIp(address)) throw new Error('target address is not allowed');
  }
}

// ── Server-side sessions + RBAC ──────────────────────────────────────────────
// The frontend /api/* surface used to be entirely unauthenticated: role checks
// lived only in React state, so anyone who could reach the port could drive every
// mutation (create/delete printers, cancel prints, mint full-access API keys).
// These helpers add a real server session (opaque token in an HttpOnly cookie,
// sha256 stored in the `sessions` table) and a default-deny authorization gate in
// front of handleApi. The key-gated /api/v1 surface keeps its own auth and is not
// affected.

const SESSION_COOKIE = 'pf_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (typeof header !== 'string') {
    return out;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    if (key) {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return out;
}

// Secure cookies require HTTPS, but the default Compose deployment serves plain
// http on :8080, where a Secure cookie would silently never be stored (breaking
// login). So mark Secure only when the request actually arrived over TLS (nginx
// sets X-Forwarded-Proto) or when explicitly forced. Set SESSION_COOKIE_SECURE=
// true once the site is behind HTTPS.
function sessionCookieIsSecure(req) {
  return (
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.SESSION_COOKIE_SECURE === 'true'
  );
}

function buildSessionCookie(req, value, maxAgeSeconds) {
  // SameSite=Lax (not Strict) so the cookie survives the top-level redirect back
  // from an OAuth/SAML IdP, while still blocking cross-site POST CSRF.
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (sessionCookieIsSecure(req)) {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

async function issueSession(req, res, user, { remember = false } = {}) {
  const token = randomBytes(32).toString('base64url');
  const ttl = remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS;
  await createSession({
    tokenHash: hash(token),
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    ip: getClientIp(req),
  });
  res.setHeader('Set-Cookie', buildSessionCookie(req, token, Math.floor(ttl / 1000)));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', buildSessionCookie(req, '', 0));
}

// ── Optional Redis session read-cache ────────────────────────────────────────
// Every authenticated request resolves the session, which is a Postgres lookup by
// token hash — the hottest auth query at scale. When Redis is enabled we read it
// through a short-lived cache so most requests skip Postgres entirely, while
// Postgres stays the source of truth (a Redis miss/outage just falls back to it).
//
// Revocation safety: the cache TTL is short, single-session logout DELetes the
// exact key, and bulk revocations (account delete, role change, password reset)
// stamp a per-user revocation marker. A cached entry older than its user's marker
// is treated as stale, so a revoked cookie can never outlive the change beyond a
// failed cache check that immediately re-reads (and finds the row gone in) PG.
const SESSION_CACHE_TTL_SECONDS = 60;
const sessionCacheKey = (tokenHash) => `session:${tokenHash}`;
const userRevokeKey = (userId) => `userrevoke:${userId}`;

async function getCachedSession(tokenHash) {
  if (!isRedisEnabled()) {
    return null;
  }
  const raw = await redisGet(sessionCacheKey(tokenHash));
  if (!raw) {
    return null;
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  // Defensive expiry check (the cache TTL normally handles this).
  if (entry.expires_at && new Date(entry.expires_at).getTime() <= Date.now()) {
    await redisDel(sessionCacheKey(tokenHash));
    return null;
  }
  // Honor a bulk revocation that happened after this entry was cached.
  const revoke = await redisGet(userRevokeKey(entry.user_id));
  if (revoke && Number(revoke) >= (entry._cachedAtMs || 0)) {
    await redisDel(sessionCacheKey(tokenHash));
    return null;
  }
  delete entry._cachedAtMs;
  return entry;
}

async function cacheSession(tokenHash, session) {
  if (!isRedisEnabled() || !session) {
    return;
  }
  const remainingMs = session.expires_at
    ? new Date(session.expires_at).getTime() - Date.now()
    : SESSION_CACHE_TTL_SECONDS * 1000;
  const ttl = Math.min(SESSION_CACHE_TTL_SECONDS, Math.floor(remainingMs / 1000));
  if (ttl <= 0) {
    return;
  }
  await redisSet(
    sessionCacheKey(tokenHash),
    JSON.stringify({ ...session, _cachedAtMs: Date.now() }),
    ttl,
  );
}

// Drop one cached session (single-session logout). PG deletion is separate.
async function invalidateCachedSession(tokenHash) {
  if (isRedisEnabled()) {
    await redisDel(sessionCacheKey(tokenHash));
  }
}

// Stamp a per-user revocation marker so every cached session for the user is
// treated as stale on its next read. Kept for the maximum session lifetime so it
// outlives any cookie issued before the revocation.
async function revokeCachedUserSessions(userId) {
  if (isRedisEnabled()) {
    await redisSet(
      userRevokeKey(userId),
      String(Date.now()),
      Math.floor(SESSION_REMEMBER_TTL_MS / 1000),
    );
  }
}

// ── Optional Redis live-telemetry overlay ────────────────────────────────────
// The poller mirrors each printer's volatile telemetry to a Redis hash
// (printer:<id>:live) every cycle. When Redis is enabled, printer reads overlay
// those hot values onto the Postgres row, offloading dashboard reads from PG and
// decoupling read freshness from write frequency. Postgres is written on change
// (and on the safety interval) so it stays fresh too — if Redis is missing the
// hash (off / down / a dead poller's TTL lapsed) reads simply use the PG values,
// with no added staleness. Only volatile, non-secret fields are mirrored, so this
// can never reintroduce a connection secret into a redacted/public response.
const LIVE_TELEMETRY_FIELDS = [
  'status', 'progress', 'totalPrintTime', 'successRate', 'bedTarget',
  'chamberTarget', 'lightOn', 'airFilterOn', 'errorMessage', 'offlineSince',
  'temperature', 'currentJob', 'nozzleTemperatures', 'nozzleTargets',
  'spools', 'fanSpeeds',
];

async function overlayLiveTelemetry(printer) {
  if (!isRedisEnabled() || !printer || !printer.id) {
    return printer;
  }
  const live = await redisHGetAll(`printer:${printer.id}:live`);
  if (!live) {
    return printer;
  }
  for (const field of LIVE_TELEMETRY_FIELDS) {
    if (live[field] === undefined) {
      continue;
    }
    // The poller stores strings raw and everything else JSON-encoded, so parse
    // and fall back to the raw value for plain strings (status, offlineSince…).
    try {
      printer[field] = JSON.parse(live[field]);
    } catch {
      printer[field] = live[field];
    }
  }
  return printer;
}

async function overlayLiveTelemetryAll(printers) {
  if (!isRedisEnabled() || !Array.isArray(printers)) {
    return printers;
  }
  await Promise.all(printers.map((printer) => overlayLiveTelemetry(printer)));
  return printers;
}

// Resolve (and cache on the request) the current session from the cookie.
// Returns the session row { user_id, username, name, role } or null.
async function resolveSession(req) {
  if (req._session !== undefined) {
    return req._session;
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  let session = null;
  if (token) {
    const tokenHash = hash(token);
    try {
      session = await getCachedSession(tokenHash);
      if (!session) {
        session = await getSession(tokenHash);
        await cacheSession(tokenHash, session);
      }
    } catch {
      session = null;
    }
  }
  req._session = session;
  return session;
}

function sessionRole(session) {
  return session ? session.role : null;
}

function isPrivilegedRole(role) {
  return role === 'admin' || role === 'operator';
}

// The queue read (`GET /api/queue`) is part of the public, cookieless frontend
// surface — anyone can poll it to see farm/queue depth. But the stored jobs
// carry student PII from the print-request form (name, email, free-text notes),
// which must not leak to anonymous/viewer/student callers. Whitelist the
// operational fields the public queue view needs and drop everything else, so a
// future column added to listQueueData can't silently start leaking. An
// operator/admin session gets the full record (submitter identity + notes).
const PUBLIC_QUEUE_FIELDS = [
  'id',
  'filename',
  'fileCount',
  'printedStatus',
  'status',
  'progress',
  'estimatedTime',
  'timeRemaining',
  'filamentUsed',
  'priority',
  'stlFileUrl',
  'hasFile',
  'submittedAt',
];

function toPublicQueueJob(job) {
  const view = {};
  for (const key of PUBLIC_QUEUE_FIELDS) {
    if (key in job) view[key] = job[key];
  }
  return view;
}

function redactQueueDataForPublic({ queue, history }) {
  return {
    queue: (queue || []).map(toPublicQueueJob),
    history: (history || []).map(toPublicQueueJob),
  };
}

// Credential-attempt throttle. Every credential check (login + the two verify
// oracles) is guarded on TWO buckets so a wordlist/dictionary run can't succeed:
//   • per client IP  — a coarse limit (8 failures / 15 min) that trips regardless
//     of which account is being probed.
//   • per username   — an escalating account lockout so a wordlist aimed at one
//     account is banned even when the attacker rotates source IPs (botnet).
// Each bucket is backed by Redis when REDIS_URL is set — shared counters so the
// limit holds across multiple web instances — and by an in-memory Map otherwise
// (or whenever Redis is unreachable). Both signals are consulted on check so a
// Redis outage mid-window can't silently reset a client's failure count; failures
// are recorded to whichever backend is live. All lockouts auto-expire (temporary,
// no admin action needed).
const LOGIN_ATTEMPTS = new Map(); // bucketKey -> { count, resetAt }
const USERNAME_LOCKS = new Map(); // username    -> { lockUntil, tier, tierResetAt }

const IP_MAX_FAILURES = 8;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_WINDOW_SECONDS = Math.floor(IP_WINDOW_MS / 1000);

// Per-username: N failures inside the counting window trip a lock whose length
// doubles each time the same account is re-locked (15m → 30m → 1h … capped 6h),
// tracked by a penalty "tier" that itself decays after a day of good behaviour.
const USERNAME_MAX_FAILURES = 5;
const USERNAME_WINDOW_SECONDS = Math.floor((15 * 60 * 1000) / 1000);
const USERNAME_BASE_LOCK_MS = 15 * 60 * 1000;
const USERNAME_MAX_LOCK_MS = 6 * 60 * 60 * 1000;
const USERNAME_PENALTY_TTL_SECONDS = 24 * 60 * 60;

const ipBucketKey = (ip) => `ip:${ip}`;
const loginAttemptKey = (key) => `loginfail:${key}`;
const usernameLockKey = (name) => `loginlock:user:${name}`;
const usernamePenaltyKey = (name) => `loginpenalty:user:${name}`;

function lockWindowMsForTier(tier) {
  const ms = USERNAME_BASE_LOCK_MS * 2 ** Math.max(0, tier - 1);
  return Math.min(ms, USERNAME_MAX_LOCK_MS);
}

// ── Generic per-bucket counter (the coarse IP limiter is one caller) ─────────
function checkBucketMemory(key, maxFailures, now = Date.now()) {
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry || now >= entry.resetAt) {
    return { allowed: true };
  }
  if (entry.count >= maxFailures) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  return { allowed: true };
}

function recordBucketFailureMemory(key, windowMs, now = Date.now()) {
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry || now >= entry.resetAt) {
    LOGIN_ATTEMPTS.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
}

async function checkBucket(key, maxFailures, windowSeconds) {
  if (isRedisEnabled()) {
    const raw = await redisGet(loginAttemptKey(key));
    if (raw !== null && Number(raw) >= maxFailures) {
      const ttl = await redisTtl(loginAttemptKey(key));
      return { allowed: false, retryAfterMs: (ttl ?? windowSeconds) * 1000 };
    }
  }
  // Always honor the in-memory signal too (covers Redis-down windows).
  return checkBucketMemory(key, maxFailures);
}

async function recordBucketFailure(key, windowSeconds) {
  if (isRedisEnabled()) {
    const count = await redisIncrWithTtl(loginAttemptKey(key), windowSeconds);
    if (count !== null) {
      return count; // recorded in Redis (the shared counter)
    }
  }
  recordBucketFailureMemory(key, windowSeconds * 1000); // Redis down/disabled → memory
  const entry = LOGIN_ATTEMPTS.get(key);
  return entry ? entry.count : 1;
}

async function clearBucket(key) {
  if (isRedisEnabled()) {
    await redisDel(loginAttemptKey(key));
  }
  LOGIN_ATTEMPTS.delete(key);
}

// ── Public-intake rate limit ─────────────────────────────────────────────────
// M-2 FIX: the unauthenticated intake endpoints (queue submit — up to
// QUEUE_UPLOAD_MAX_BYTES stored in the DB per call — and manager request) had no
// throttle, so a bot could exhaust DB storage or spam requests. Apply a coarse
// per-IP limit reusing the generic Redis+memory bucket counter. Returns true
// when the request may proceed; on limit it writes a 429 (with Retry-After).
//
// The default (60/hour) is deliberately generous: the queue-submit form is the
// primary student flow and a whole class often shares ONE public IP behind
// institutional NAT (getClientIp sees that shared address), so a low cap would
// 429 legitimate submissions. It still stops runaway bots. Operators behind
// heavy shared NAT can raise PUBLIC_INTAKE_MAX_PER_WINDOW further.
const INTAKE_MAX_PER_WINDOW = Number(process.env.PUBLIC_INTAKE_MAX_PER_WINDOW) || 60;
const INTAKE_WINDOW_SECONDS = Number(process.env.PUBLIC_INTAKE_WINDOW_SECONDS) || 3600;

async function guardPublicIntake(req, res, name) {
  const ip = getClientIp(req) || 'unknown';
  const key = `intake:${name}:${ip}`;
  const rate = await checkBucket(key, INTAKE_MAX_PER_WINDOW, INTAKE_WINDOW_SECONDS);
  if (!rate.allowed) {
    const retryAfter = Math.ceil((rate.retryAfterMs || INTAKE_WINDOW_SECONDS * 1000) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
    return false;
  }
  await recordBucketFailure(key, INTAKE_WINDOW_SECONDS);
  return true;
}

// ── Per-username escalating lockout ──────────────────────────────────────────
async function checkUsernameLock(username) {
  if (!username) {
    return { allowed: true };
  }
  if (isRedisEnabled()) {
    const ttl = await redisTtl(usernameLockKey(username));
    if (ttl !== null && ttl > 0) {
      return { allowed: false, retryAfterMs: ttl * 1000 };
    }
  }
  const entry = USERNAME_LOCKS.get(username);
  if (entry && entry.lockUntil > Date.now()) {
    return { allowed: false, retryAfterMs: entry.lockUntil - Date.now() };
  }
  return { allowed: true };
}

// Record one failed attempt for a username; once the counting window collects
// USERNAME_MAX_FAILURES failures, (re)arm the escalating lock and bump the tier.
async function recordUsernameFailure(username) {
  if (!username) {
    return;
  }
  const failures = await recordBucketFailure(usernameLockKey(username), USERNAME_WINDOW_SECONDS);
  if (failures < USERNAME_MAX_FAILURES) {
    return;
  }
  // Threshold crossed → escalate. The penalty tier persists across windows so a
  // persistent attacker faces ever-longer locks, then decays after a quiet day.
  let tier = 1;
  if (isRedisEnabled()) {
    const bumped = await redisIncrWithTtl(usernamePenaltyKey(username), USERNAME_PENALTY_TTL_SECONDS);
    if (bumped !== null) {
      tier = bumped;
    }
  } else {
    const now = Date.now();
    const prev = USERNAME_LOCKS.get(username);
    tier = prev && prev.tierResetAt > now ? prev.tier + 1 : 1;
  }
  const lockMs = lockWindowMsForTier(tier);
  const lockSeconds = Math.ceil(lockMs / 1000);
  if (isRedisEnabled()) {
    await redisSet(usernameLockKey(username), '1', lockSeconds);
    // Reset the failure counter so the next window starts fresh after the lock.
    await clearBucket(usernameLockKey(username));
  }
  USERNAME_LOCKS.set(username, {
    lockUntil: Date.now() + lockMs,
    tier,
    tierResetAt: Date.now() + USERNAME_PENALTY_TTL_SECONDS * 1000,
  });
  LOGIN_ATTEMPTS.delete(usernameLockKey(username));
  logger.warn('login.lockout', { username, tier, lockSeconds });
}

async function clearUsernameLock(username) {
  if (!username) {
    return;
  }
  if (isRedisEnabled()) {
    await redisDel(usernameLockKey(username), usernamePenaltyKey(username));
  }
  USERNAME_LOCKS.delete(username);
  LOGIN_ATTEMPTS.delete(usernameLockKey(username));
}

// ── Combined guard shared by /api/auth/login and the two verify endpoints ────
// Locked when EITHER the IP bucket or the username lock trips; retryAfterMs is
// the longer of the two so the client is told the true wait.
async function guardCredentialAttempt({ ip, username }) {
  const ipKey = ipBucketKey(ip || 'unknown');
  const [ipRate, userRate] = await Promise.all([
    checkBucket(ipKey, IP_MAX_FAILURES, IP_WINDOW_SECONDS),
    checkUsernameLock(username),
  ]);
  if (ipRate.allowed && userRate.allowed) {
    return { allowed: true };
  }
  const retryAfterMs = Math.max(ipRate.retryAfterMs || 0, userRate.retryAfterMs || 0);
  return { allowed: false, retryAfterMs };
}

async function recordCredentialFailure({ ip, username }) {
  await Promise.all([
    recordBucketFailure(ipBucketKey(ip || 'unknown'), IP_WINDOW_SECONDS),
    recordUsernameFailure(username),
  ]);
}

async function clearCredentialAttempts({ ip, username }) {
  await Promise.all([clearBucket(ipBucketKey(ip || 'unknown')), clearUsernameLock(username)]);
}

// ── Authorization matrix for the frontend /api/* surface ─────────────────────
// Reads stay public (the dashboard has an anonymous viewer mode) except for the
// handful that expose secrets. Mutations are default-deny: anything not
// explicitly classified as public or operator-level requires an admin session.

const PUBLIC_API_MUTATIONS = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/verify', // OAuth grant exchange
  'POST /api/auth/saml/acs', // SAML assertion consumer
  'POST /api/slicer-grant/verify',
  'POST /api/admin/credential/verify',
  'POST /api/users/verify',
  'POST /api/manager/request', // external manager requests an access key
  'POST /api/queue/submit', // public student print-request intake
]);

// Non-sensitive reads that expose fleet/queue operational data (queue contents,
// fleet health aggregates). World-readable only when the anonymous public-viewer
// dashboard is enabled; otherwise they require a session so a non-public
// deployment doesn't leak this to unauthenticated callers.
// Note: /api/queue has been made public so that public users can always see the queue.
const VIEWER_GATED_READS = new Set([
  '/api/maintenance/summary',
]);

// The stored model file for a queue job (GET /api/queue/:id/file). Its bytes are
// the student's uploaded model.
const QUEUE_FILE_READ_RE = /^\/api\/queue\/[^/]+\/file$/;

function isViewerGatedRead(pathname) {
  return VIEWER_GATED_READS.has(pathname);
}

function publicViewerModeEnabled() {
  return process.env.VITE_PUBLIC_VIEWER_MODE === 'true';
}

// GET/HEAD endpoints that must NOT be world-readable because they expose
// credentials, account lists, audit trails, or IdP config.
function isSensitiveRead(pathname) {
  if (pathname === '/api/users' || (pathname.startsWith('/api/users/') && pathname !== '/api/users/verify')) {
    return true;
  }
  if (pathname === '/api/slicer-keys' || pathname.startsWith('/api/slicer-keys/')) {
    return true;
  }
  if (pathname === '/api/audit-logs') {
    return true;
  }
  if (pathname === '/api/admin/update-status') {
    return true; // software-update status is admin-only (not viewer-readable)
  }
  if (pathname === '/api/admin/backup/download') {
    return true; // full data backup — every connection secret and API key
  }
  if (pathname === '/api/network-usage' || pathname === '/api/network-usage/live') {
    return true; // internal traffic breakdown is admin-only, like audit logs
  }
  if (pathname.startsWith('/api/notifications/')) {
    return true; // Discord webhook URLs are secrets
  }
  if (pathname === '/api/manager/requests') {
    return true;
  }
  if (pathname.startsWith('/api/manager/requests/') && !pathname.endsWith('/status')) {
    return true;
  }
  if (pathname === '/api/settings/saml') {
    return true; // may carry IdP signing config
  }
  if (pathname.startsWith('/api/settings/home-assistant')) {
    return true; // internal HA URL + device/entity lists are not viewer-readable
  }
  return false;
}

function isAdminMutation(method, pathname) {
  if (pathname === '/api/users' && method === 'POST') return true;
  if (pathname.startsWith('/api/users/') && pathname !== '/api/users/verify') return true;
  if (pathname === '/api/slicer-keys' && method === 'POST') return true;
  if (pathname.startsWith('/api/slicer-keys/') && method === 'DELETE') return true;
  if (pathname === '/api/admin/credential' && method === 'PUT') return true;
  if (pathname === '/api/admin/update/apply' && method === 'POST') return true;
  if (pathname === '/api/admin/backup/restore' && method === 'POST') return true;
  if (pathname.startsWith('/api/notifications/')) return true;
  if (pathname === '/api/settings/saml' || pathname === '/api/settings/saml/test') return true;
  if (pathname.startsWith('/api/settings/') && method !== 'GET') return true;
  if (pathname === '/api/analytics/daily/reset') return true;
  if (pathname === '/api/queue/reset') return true;
  if (pathname.startsWith('/api/queue/') && method === 'DELETE') return true;
  if (pathname.startsWith('/api/printers/') && method === 'DELETE') return true;
  if (pathname.startsWith('/api/manager/requests/') && !pathname.endsWith('/status')) return true;
  // Filament Station: deleting a spool/device/assignment or issuing a system
  // command (reboot/shutdown/restart) to the physical kiosk — same
  // destructive-ish class as deleting a printer.
  if (pathname.startsWith('/api/filament-station/')) {
    if (method === 'DELETE') return true;
    if (pathname.endsWith('/system/command') && method === 'POST') return true;
  }
  return false;
}

// Operator-or-admin writes: live print control and queue progress. Printer
// create/edit/reorder shares one upsert endpoint that operators also use to
// reorder the dashboard, so it stays here rather than admin-only.
function isOperatorMutation(method, pathname) {
  if (pathname === '/api/printers' && method === 'POST') return true;
  if (pathname.startsWith('/api/printers/') && pathname.endsWith('/command') && method === 'POST') return true;
  if (pathname.startsWith('/api/queue/') && pathname.endsWith('/printed') && method === 'POST') return true;
  if (pathname === '/api/queue' && method === 'POST') return true;
  if (pathname === '/api/queue/availability/bypass' && method === 'POST') return true;
  if (pathname.startsWith('/api/maintenance/') && pathname.endsWith('/complete') && method === 'POST') return true;
  if (pathname === '/api/maintenance/notifications/read' && method === 'POST') return true;
  // Filament Station: spool/assignment CRUD, tag writes, and calibration/
  // display tuning — operator-level, same class as printer command/queue.
  if (pathname.startsWith('/api/filament-station/') && (method === 'POST' || method === 'PUT')) {
    if (!pathname.endsWith('/system/command')) return true;
  }
  return false;
}

// Returns the access class for a frontend API request:
//   'public'   — no session required
//   'authed'   — any valid session
//   'operator' — operator or admin session
//   'admin'    — admin session only
function classifyApiRequest(method, pathname) {
  if (method === 'OPTIONS') {
    return 'public';
  }
  if (method === 'GET' || method === 'HEAD') {
    if (isSensitiveRead(pathname)) {
      return 'admin';
    }
    if (isViewerGatedRead(pathname) && !publicViewerModeEnabled()) {
      return 'authed';
    }
    return 'public';
  }
  // Mutations
  if (PUBLIC_API_MUTATIONS.has(`${method} ${pathname}`)) {
    return 'public';
  }
  // First-run admin password setup is open, but the handler refuses (409) once a
  // credential exists, so it can't be reused to hijack the account.
  if (method === 'POST' && pathname === '/api/admin/credential') {
    return 'public';
  }
  if (pathname === '/api/audit-logs' && method === 'POST') {
    return 'authed';
  }
  // Any signed-in user may mint/revoke their own ephemeral slicer-upload token.
  if (pathname === '/api/auth/slicer-token' && (method === 'POST' || method === 'DELETE')) {
    return 'authed';
  }
  if (isOperatorMutation(method, pathname)) {
    return 'operator';
  }
  if (isAdminMutation(method, pathname)) {
    return 'admin';
  }
  // Default-deny: any unclassified mutation requires admin.
  return 'admin';
}

// True when a state-changing request demonstrably comes from our own site (or
// carries no browser origin context at all). Compares the Origin (then Referer)
// hostname against the request host. Behind nginx the proxied Host header has no
// port (proxy_set_header Host $host) while a browser Origin includes it, so we
// compare hostnames only — sufficient for CSRF (a different port on the same host
// is not the threat). When neither Origin nor Referer is present (a non-browser
// client such as curl or a server-to-server call) we allow it: CSRF is a
// browser-only attack, and the key-gated /api/v1 API is the path for automation.
function isSameOriginWrite(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) {
    return true;
  }
  let sourceHost;
  try {
    sourceHost = new URL(source).hostname.toLowerCase();
  } catch {
    return false; // malformed Origin/Referer → treat as cross-origin
  }
  const stripPort = (host) => host.split(':')[0].trim().toLowerCase();
  const allowed = new Set();
  if (typeof req.headers.host === 'string') {
    allowed.add(stripPort(req.headers.host));
  }
  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string') {
    forwardedHost.split(',').forEach((host) => allowed.add(stripPort(host)));
  }
  return allowed.has(sourceHost);
}

// Authorization gate run at the top of handleApi. Resolves the session and
// enforces the class from classifyApiRequest. On denial it writes the response
// and returns false; on success it returns true and the route ladder proceeds.
async function authorizeFrontendApi(req, res, requestUrl) {
  const { pathname } = requestUrl;
  // Only the cookie-authenticated frontend surface is gated here. The key-gated
  // /api/v1 data API authenticates itself in handleDataApi.
  if (!pathname.startsWith('/api/') || pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    return true;
  }

  const klass = classifyApiRequest(req.method || 'GET', pathname);
  if (klass === 'public') {
    return true;
  }

  // CSRF defense-in-depth for cookie-authenticated mutations. SameSite=Lax
  // already keeps the session cookie off cross-site writes; this is a second,
  // independent control — a state-changing request must originate from our own
  // site. Only non-public mutations reach here (the public intake endpoints —
  // login, SAML ACS, manager request, queue submit — returned 'public' above,
  // so the IdP's cross-origin ACS POST and the CORS manager API are unaffected).
  // GET/HEAD are exempt (not state-changing). The key-gated /api/v1 surface is
  // separate and never reaches this gate.
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !isSameOriginWrite(req)) {
    sendJson(res, 403, { error: 'Cross-origin request blocked.' });
    return false;
  }

  const session = await resolveSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Authentication required.' });
    return false;
  }
  const role = sessionRole(session);
  if (klass === 'admin' && role !== 'admin') {
    sendJson(res, 403, { error: 'Administrator access required.' });
    return false;
  }
  if (klass === 'operator' && !isPrivilegedRole(role)) {
    sendJson(res, 403, { error: 'Operator access required.' });
    return false;
  }
  return true;
}

// Content-Security-Policy. The built SPA loads only same-origin external module
// scripts (no inline <script>), so script-src 'self' is safe; styles need
// 'unsafe-inline' (React/Radix inject style attributes) and images need data:
// (branding background + inline SVG fallback) and blob: (object URLs). No
// external CDN/font hosts are used. Tunable at runtime: CONTENT_SECURITY_POLICY
// overrides the whole string ("off" disables it), and CSP_REPORT_ONLY=true emits
// it as report-only so an operator can validate a policy before enforcing.
const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

function resolveCsp() {
  const raw = process.env.CONTENT_SECURITY_POLICY;
  if (raw === undefined || raw === '') {
    return DEFAULT_CSP;
  }
  return raw.toLowerCase() === 'off' ? null : raw;
}

const CSP_VALUE = resolveCsp();
const CSP_HEADER = process.env.CSP_REPORT_ONLY === 'true'
  ? 'Content-Security-Policy-Report-Only'
  : 'Content-Security-Policy';

// The Snapmaker U1 webcam player is third-party HTML served by the printer and
// proxied onto our origin under /__printer_webcam/. It ships an inline <script>
// (a jmuxer H264 player with a snapshot fallback) and pulls jmuxer from jsDelivr
// — both of which the strict app CSP (script-src 'self', no 'unsafe-inline')
// blocks, so the player JS never runs and the camera frame stays dead. These
// responses are camera assets carrying no app data, so they get a policy scoped
// to exactly what the player needs: its own inline script, the jsdelivr CDN, and
// blob/media URLs for the muxed video. If the CDN is unreachable (offline LAN),
// jmuxer is simply undefined and the inline script falls back to snapshot.jpg —
// which the firmware's player already handles. This overrides the app CSP for
// webcam responses only; every other route keeps script-src 'self'.
const WEBCAM_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
].join('; ');

// HSTS is only meaningful over HTTPS (browsers ignore it on plain http), so it is
// emitted only when the request actually arrived over TLS (nginx sets
// X-Forwarded-Proto). HSTS_MAX_AGE=0 disables it; default is 180 days.
const HSTS_MAX_AGE = (() => {
  const value = Number.parseInt(process.env.HSTS_MAX_AGE ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 15552000;
})();

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (CSP_VALUE) {
    res.setHeader(CSP_HEADER, CSP_VALUE);
  }
  if (HSTS_MAX_AGE > 0 && req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
  }
}

function sendJson(res, statusCode, payload, cacheControl = 'no-store') {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(payload));
}

// For a GET that's polled often but whose payload frequently doesn't change
// between polls (e.g. /api/printers when the fleet is mostly idle — see
// PrintersContext.tsx's 8s poll), answer with a 304 and no body instead of
// re-sending the same JSON. Cheap: one sha1 over the already-serialized body.
function sendJsonWithEtag(req, res, statusCode, payload) {
  const body = JSON.stringify(payload);
  const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-store');
  if (statusCode === 200 && req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function sendEmpty(res, statusCode = 204) {
  res.statusCode = statusCode;
  res.end();
}

function readBody(req, maxBytes = maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

async function readJsonBody(req, maxBytes = maxBodyBytes) {
  const body = await readBody(req, maxBytes);
  return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
}

// Normalize a list of queue-job ids from either query params (repeated `?ids=`
// and/or comma-separated values) or a JSON array body, into a deduped array of
// trimmed strings. Returns null when nothing usable is present.
function parseIdList(input) {
  if (input == null) {
    return null;
  }
  const raw = Array.isArray(input) ? input : [input];
  const ids = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    for (const part of entry.split(',')) {
      const trimmed = part.trim();
      if (trimmed && !ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }
  return ids.length > 0 ? ids : null;
}

// Buffer a raw binary request body up to an explicit cap. Used by the queue
// migration file-upload route, which carries model files far larger than the
// 1 MB global readBody limit.
function readBodyBounded(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

// Bytes pulled per DB round-trip when streaming a stored model file out to the
// client. Caps resident memory per in-flight download to ~this size instead of
// the whole file; the trade-off is more (cheap) substring reads.
const QUEUE_FILE_STREAM_CHUNK_BYTES = 256 * 1024;

// Stream a stored queue-job model file to the response in fixed-size chunks,
// reading each slice straight from Postgres so the full file never sits in
// server RAM. Returns false (without touching the response) when no file
// exists, so the caller can send a 404. Honours backpressure by waiting for the
// socket to drain between chunks.
async function streamQueueJobFile(res, id, { inline = false } = {}) {
  const meta = await getQueueJobFileMeta(id);
  if (!meta) {
    return false;
  }

  const safeName = (meta.filename || 'model').replace(/[^\w.\- ]+/g, '_');
  const disposition = inline ? 'inline' : 'attachment';
  res.statusCode = 200;
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Content-Length', meta.size);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');

  for (let offset = 0; offset < meta.size; offset += QUEUE_FILE_STREAM_CHUNK_BYTES) {
    const chunk = await readQueueJobFileChunk(id, offset, QUEUE_FILE_STREAM_CHUNK_BYTES);
    if (chunk.length === 0) {
      break;
    }
    if (!res.write(chunk)) {
      await new Promise((resolve, reject) => {
        res.once('drain', resolve);
        res.once('error', reject);
      });
    }
  }

  res.end();
  return true;
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

// Discord only speaks the message `content` aloud (embeds are never read by TTS),
// and it always prepends the webhook's author name ("<name> said ..."), so make
// the spoken line carry the useful submission details — who submitted and how
// many files — rather than a generic title. The filename/URL are skipped on
// purpose so they aren't read aloud.
function ttsContentForJob(job) {
  const submitter = (job?.submitterName || '').trim();
  const count = Number(job?.fileCount ?? 1) || 1;
  const filePart = `${count} file${count === 1 ? '' : 's'}`;
  const spoken = submitter
    ? `New print request from ${submitter}, ${filePart}`
    : `New print request, ${filePart}`;
  // Discord ignores tts when content is blank, so always return a non-empty line.
  return spoken.slice(0, 2000);
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

// Pushes the current "any unfinished job?" state to every connected tab.
// Called after any mutation that can flip it (submit/printed/delete/reset) so
// the sidebar's Queue dot updates instantly in both directions, not just on
// new submissions (queue-added).
async function broadcastQueueStatusUpdate() {
  try {
    broadcastQueueStatus({ hasUnfinished: await hasUnfinishedQueueJobs() });
  } catch (error) {
    logger.error('failed to broadcast queue status', error);
  }
}

async function sendQueueAddedNotifications(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  // Push to any subscribed browser tab regardless of Discord webhook config —
  // this is what used to be discovered by polling GET /api/queue. Only a small,
  // JSON-safe subset of each job (never fileContent, which can be many MB).
  for (const job of jobs) {
    broadcastQueueAdded({
      id: job.id,
      filename: job.filename,
      fileCount: job.fileCount,
      submitterName: job.submitterName,
    });
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
            // TTS mode sends plain spoken text (Discord only reads `content` aloud,
            // never embeds); otherwise send the rich embed.
            body: JSON.stringify(
              webhook.tts
                ? {
                    username: webhook.name || 'PrintFarm Bot',
                    tts: true,
                    content: ttsContentForJob(job),
                  }
                : {
                    username: webhook.name || 'PrintFarm Bot',
                    embeds: [embed],
                  },
            ),
          }).then((response) => {
            if (!response.ok) {
              throw new Error(`Discord webhook failed with ${response.status}`);
            }
          }),
        ),
    );
  }
}

// Parse a multipart/form-data print-request submission from the in-app form.
// Buffers the single uploaded file in memory (bounded by QUEUE_UPLOAD_MAX_BYTES)
// alongside the text fields so the caller can store the file straight into the DB.
function parsePrintRequest(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: QUEUE_UPLOAD_MAX_BYTES, files: 1, fields: 20 },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const fields = {};
    let file = null;
    let fileTooLarge = false;

    bb.on('field', (name, value) => {
      fields[name] = value;
    });

    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        fileTooLarge = true;
        stream.resume();
      });
      stream.on('end', () => {
        if (!fileTooLarge && chunks.length > 0) {
          file = {
            filename: info.filename,
            mimeType: info.mimeType,
            content: Buffer.concat(chunks),
          };
        }
      });
    });

    bb.on('error', reject);
    bb.on('close', () => {
      if (fileTooLarge) {
        reject(new Error('FILE_TOO_LARGE'));
        return;
      }
      resolve({ fields, file });
    });

    req.pipe(bb);
  });
}

// Bambu MQTT command builder + sender moved to bambuCommands.js so
// filamentStation.js can reuse sendBambuCommand('set_filament', ...) (the AMS
// override, plan §2a) without app.js <-> filamentStation.js importing each
// other. See that file for buildBambuCommandPayload/sendBambuCommand.

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

// Handles both the new in-app AV1 live view (Bambu H2 + Snapmaker U1, best
// effort for the latter — see bambuCamera.js) and the documented legacy
// MJPEG/JPEG camera surface for Bambu printers (camera/stream, camera/snapshot,
// /webcam/:id). The legacy MJPEG/JPEG contract is intentionally left as-is —
// AV1-in-fMP4 isn't <img>-embeddable, so it gets new routes instead of
// repurposing that one.
async function handleCameraHubWebcam(req, res, printer, pathParts) {
  if (pathParts[0] === 'stream.mp4' && AV1_STREAM_PROFILES.has(printer.profile)) {
    addCameraViewer(printer, req, res);
    return;
  }
  // H2/X1-class printers (RTSP) can stream live MJPEG; the A1/P1 port-6000
  // camera is snapshot-only. (Snapmaker U1 never reaches this branch — its
  // legacy stream.mjpg/snapshot.jpg stay on the plain reverse-proxy path.)
  if (pathParts[0] === 'stream.mjpg' && BAMBU_RTSP_PROFILES.has(printer.profile)) {
    streamLegacyMjpeg(printer, req, res);
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
    logger.error('bambu camera capture failed', {
      profile: printer.profile,
      printer: printer.name,
      ip: printer.ipAddress,
      err: message,
    });
    sendJson(res, 502, { error: message });
  }
}

// Friendly webcam stream URL — GET /webcam/<printerId-or-name> serves the camera
// feed directly so it drops straight into an <img src> (e.g. a Grafana HTML/text
// panel) with no iframe. Live-MJPEG printers (Snapmaker U1, Bambu H2 series)
// stream multipart/x-mixed-replace; everything else returns a single JPEG
// snapshot. It just resolves the printer and delegates to the existing webcam
// proxy, so the cross-origin / no-store / Bambu handling is shared.
const LIVE_MJPEG_PROFILES = new Set(['snapmaker_u1', 'bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

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
// Per-key permission scopes. 'slicer_upload' authorizes the slicer-proxy upload
// path; 'printfarm_manage' authorizes the programmatic /api/v1 data API.
const SLICER_KEY_PERMISSIONS = ['slicer_upload', 'printfarm_manage'];

// Keep only recognized scopes, preserving a stable order.
function normalizeKeyPermissions(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return SLICER_KEY_PERMISSIONS.filter((perm) => input.includes(perm));
}

function keyHasPermission(record, perm) {
  return Array.isArray(record?.permissions) && record.permissions.includes(perm);
}

const DATA_API_PREFIX = '/api/v1/';

const DATA_API_RESOURCES = [
  'printers',
  'queue',
  'analytics',
  'notifications',
  'slicer-keys',
  'audit-logs',
  'settings',
  'users',
  'admin-credential',
  'manager-requests',
  'maintenance',
  'filament-station',
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
    logger.error('failed to stamp API key usage', error);
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
    logger.error('failed to record API audit log', error);
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
  if (!keyHasPermission(apiKey, 'printfarm_manage')) {
    sendJson(res, 403, {
      error: "This API key lacks the 'printfarm_manage' permission required for the /api/v1 data API.",
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
      return handleDataApiQueue(req, res, { apiKey, method, id, sub, requestUrl });
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
    case 'users':
      return handleDataApiUsers(req, res, { apiKey, method, id, sub });
    case 'admin-credential':
      return handleDataApiAdminCredential(req, res, { apiKey, method, id });
    case 'manager-requests':
      return handleDataApiManagerRequests(req, res, { apiKey, method, id, sub });
    case 'maintenance':
      return handleDataApiMaintenance(req, res, { apiKey, method, id, sub, requestUrl });
    case 'filament-station':
      return handleFilamentStation(req, res, { method, segments: segments.slice(1), requestUrl });
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
      sendJson(res, 200, await overlayLiveTelemetryAll(await listPrinters(true)));
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
    const {
      command,
      heater,
      target,
      nozzleIndex,
      gcode,
      trayId,
      fanPort,
      speed,
      modeId,
      submode,
      type,
      color,
      vendor,
    } = await readJsonBody(req);
    await sendBambuCommand(printer, command, {
      heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode, type, color, vendor,
    });
    auditDataApi(req, apiKey, 'printer.command', id, { command });
    sendEmpty(res);
    return true;
  }

  // ALL /printers/:id/proxy/<path...> — raw HTTP passthrough to the printer's
  // hardware API (e.g. Moonraker on Snapmaker U1). This is how the web UI drives
  // every non-Bambu control — pause/resume/cancel (printer/print/<cmd>), gcode
  // scripts, LED, temps, fans, filament macros — so exposing it here gives the
  // manager full parity with the dashboard for those profiles. Reuses the same
  // handlePrinterProxy that backs /__printer_proxy/; the segments after /proxy/
  // are decoded so handlePrinterProxy re-encodes them exactly once.
  if (sub === 'proxy') {
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    const marker = '/proxy/';
    const rawRest = requestUrl.pathname.slice(requestUrl.pathname.indexOf(marker) + marker.length);
    const restSegments = rawRest.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    // handlePrinterProxy only reads .pathname and .search; hand it decoded path
    // segments (it encodes them) and pass the query string through verbatim.
    const proxyUrl = {
      pathname: `/__printer_proxy/${printer.id}/${restSegments.join('/')}`,
      search: requestUrl.search,
    };
    // We've already authenticated; don't forward our own API credentials on to
    // the printer hardware (handlePrinterProxy relays the remaining headers).
    delete req.headers['x-api-key'];
    delete req.headers['authorization'];
    // Audit control actions, not read-only status polls (which can be frequent).
    if (method !== 'GET' && method !== 'HEAD') {
      auditDataApi(req, apiKey, 'printer.proxy', id, { method, path: `/${restSegments.join('/')}` });
    }
    return handlePrinterProxy(
      req,
      res,
      proxyUrl,
      '/__printer_proxy/',
      (p, proxyPath) => `${p.url}${proxyPath}`,
      {},
    );
  }

  // GET /printers/:id/camera/{snapshot,stream,health,av1-stream} — webcam
  // access. Snapshot and stream delegate to the same /__printer_webcam proxy
  // the friendly /webcam/<id> route uses, so every profile (Bambu port-6000
  // JPEG, H2 RTSP hub, Snapmaker live MJPEG) is handled identically. `stream`
  // serves live multipart MJPEG where the profile supports it and otherwise
  // falls back to a single snapshot. `av1-stream` is the newer, separate
  // AV1-in-fragmented-MP4 live view (not <img>-embeddable — needs a
  // MediaSource/WebCodecs-based player); it 404s where AV1 isn't attempted
  // for this profile or the best-effort Snapmaker U1 probe has fallen back to
  // its native player (check camera/health's `codec` field).
  if (sub === 'camera') {
    if (method !== 'GET') {
      return dataApiMethodNotAllowed(res);
    }
    if (action === 'health') {
      sendJson(res, 200, getCameraHealth(id), 'no-store');
      return true;
    }
    if (action !== 'snapshot' && action !== 'stream' && action !== 'av1-stream') {
      sendJson(res, 404, {
        error: 'Use /camera/snapshot, /camera/stream, /camera/av1-stream, or /camera/health.',
      });
      return true;
    }
    const printer = await getPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    if (action === 'av1-stream' && !AV1_STREAM_PROFILES.has(printer.profile)) {
      sendJson(res, 404, { error: 'AV1 live view is not available for this printer profile.' });
      return true;
    }
    const camPath =
      action === 'av1-stream'
        ? 'stream.mp4'
        : action === 'stream' && LIVE_MJPEG_PROFILES.has(printer.profile)
          ? 'stream.mjpg'
          : 'snapshot.jpg';
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
    sendJson(res, 200, await overlayLiveTelemetry(printer));
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

// queue: list stored jobs / upsert / reset / mark printed / delete, plus the
// host→host migration routes (export / import / per-job file transfer).
// GET returns the stored queue (it does NOT trigger a Google Sheet sync — that
// stays on the frontend /api/queue path).
async function handleDataApiQueue(req, res, { apiKey, method, id, sub, requestUrl }) {
  // ── Migration: export manifest ────────────────────────────────────────────
  // GET /api/v1/queue/export[?includePrinted=true][?ids=a,b,c] — metadata-only
  // manifest for a remote manager to recreate this host's queue elsewhere. Each
  // job carries hasFile/fileMime/fileSize; the bytes are pulled separately from
  // .../file. Pass `ids` (comma-separated, repeatable) to migrate only that
  // selection instead of the whole queue.
  if (id === 'export') {
    if (method !== 'GET') {
      return dataApiMethodNotAllowed(res);
    }
    const includePrinted = requestUrl.searchParams.get('includePrinted') === 'true';
    const ids = parseIdList(requestUrl.searchParams.getAll('ids'));
    const jobs = await exportQueueJobs(includePrinted, ids);
    sendJson(res, 200, { jobs }, 'no-store');
    return true;
  }

  // ── Migration: import manifest ────────────────────────────────────────────
  // POST /api/v1/queue/import { jobs: [...] } — recreate rows from an export
  // manifest, preserving ids/printedStatus/submittedAt. File bytes are attached
  // afterwards with PUT .../file.
  if (id === 'import') {
    if (method !== 'POST') {
      return dataApiMethodNotAllowed(res);
    }
    const body = await readJsonBody(req);
    const jobs = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : null;
    if (!jobs) {
      sendJson(res, 400, { error: 'expected an array of jobs or { jobs: [...] }' });
      return true;
    }
    const imported = await importQueueJobs(jobs);
    auditDataApi(req, apiKey, 'queue.import', null, { count: imported });
    sendJson(res, 200, { imported });
    return true;
  }

  // ── Migration: bulk source removal ─────────────────────────────────────────
  // POST /api/v1/queue/delete { ids: [...] } — soft-delete a set of jobs in one
  // call. Used to drop the source-side rows after migrating a selection across
  // ("migrate selection, then remove the source queue"). Returns { deleted }.
  if (id === 'delete') {
    if (method !== 'POST') {
      return dataApiMethodNotAllowed(res);
    }
    const body = await readJsonBody(req);
    const ids = parseIdList(Array.isArray(body) ? body : body?.ids);
    if (!ids) {
      sendJson(res, 400, { error: 'expected a non-empty array of ids or { ids: [...] }' });
      return true;
    }
    const deleted = await deleteQueueJobs(ids);
    broadcastQueueStatusUpdate();
    auditDataApi(req, apiKey, 'queue.delete', null, { ids, deleted });
    sendJson(res, 200, { deleted });
    return true;
  }

  // ── Migration: per-job file transfer ──────────────────────────────────────
  // GET  /api/v1/queue/:id/file — stream the stored model bytes (source side).
  // PUT  /api/v1/queue/:id/file — attach model bytes to an imported job (dest).
  if (id && sub === 'file') {
    if (method === 'GET') {
      const streamed = await streamQueueJobFile(res, id);
      if (!streamed) {
        sendJson(res, 404, { error: 'File not found' });
      }
      return true;
    }
    if (method === 'PUT') {
      let content;
      try {
        content = await readBodyBounded(req, QUEUE_UPLOAD_MAX_BYTES);
      } catch {
        const limitMb = Math.round(QUEUE_UPLOAD_MAX_BYTES / (1024 * 1024));
        sendJson(res, 413, { error: `File exceeds the ${limitMb} MB upload limit.` });
        return true;
      }
      if (content.length === 0) {
        sendJson(res, 400, { error: 'Empty request body; send the model file as the raw body.' });
        return true;
      }
      const mime = req.headers['content-type'] || 'application/octet-stream';
      const updated = await setQueueJobFile(id, content, mime);
      if (!updated) {
        sendJson(res, 404, { error: 'Queue job not found; import it before uploading its file.' });
        return true;
      }
      auditDataApi(req, apiKey, 'queue.file', id, { bytes: content.length });
      sendJson(res, 200, { id, fileSize: content.length });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

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
      broadcastQueueStatusUpdate();
      auditDataApi(req, apiKey, 'queue.upsert', null, { count: jobs.length });
      sendJson(res, 200, { added });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

  if (id === 'reset' && method === 'POST') {
    await resetQueueJobs();
    broadcastQueueStatusUpdate();
    auditDataApi(req, apiKey, 'queue.reset', null);
    sendEmpty(res);
    return true;
  }
  if (sub === 'printed' && method === 'POST') {
    await markQueueJobPrinted(id);
    broadcastQueueStatusUpdate();
    auditDataApi(req, apiKey, 'queue.printed', id);
    sendEmpty(res);
    return true;
  }
  if (method === 'DELETE') {
    await deleteQueueJob(id);
    broadcastQueueStatusUpdate();
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

// maintenance: preventive-maintenance parity over the key-gated API.
//   GET  /api/v1/maintenance[?printer=&status=&type=]  -> list events
//   GET  /api/v1/maintenance/summary                   -> fleet aggregates
//   GET  /api/v1/maintenance/printer/:printerId        -> per-printer summary
//   POST /api/v1/maintenance/:eventId/complete { notes } -> complete a task
//   GET/PUT /api/v1/settings/maintenance-intervals is handled under `settings`.
async function handleDataApiMaintenance(req, res, { apiKey, method, id, sub, requestUrl }) {
  if (!id) {
    if (method === 'GET') {
      sendJson(res, 200, await listMaintenanceEvents({
        printerId: requestUrl.searchParams.get('printer'),
        status: requestUrl.searchParams.get('status'),
        maintenanceType: requestUrl.searchParams.get('type'),
      }));
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }
  if (id === 'summary' && method === 'GET') {
    sendJson(res, 200, await getMaintenanceSummary());
    return true;
  }
  if (id === 'printer' && sub && method === 'GET') {
    const summary = await getPrinterMaintenance(sub);
    if (!summary) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    sendJson(res, 200, summary);
    return true;
  }
  if (sub === 'complete' && method === 'POST') {
    const body = await readJsonBody(req);
    const notes = typeof body?.notes === 'string' ? body.notes.trim() || null : null;
    const event = await completeMaintenanceEvent(id, notes);
    if (!event) {
      sendJson(res, 404, { error: 'Pending maintenance task not found' });
      return true;
    }
    broadcastMaintenanceStatusUpdate();
    auditDataApi(req, apiKey, 'maintenance.complete', id, { notes });
    sendJson(res, 200, event);
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
      const { name, permissions } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const scopes = normalizeKeyPermissions(permissions);
      if (scopes.length === 0) {
        sendJson(res, 400, { error: `permissions must include at least one of: ${SLICER_KEY_PERMISSIONS.join(', ')}` });
        return true;
      }
      const key = randomBytes(24).toString('base64url');
      const newId = randomUUID();
      await createSlicerApiKey({ id: newId, name: name.trim(), keyHash: hash(key), keyPrefix: key.slice(0, 8), permissions: scopes });
      auditDataApi(req, apiKey, 'slicer-key.create', newId, { name: name.trim(), permissions: scopes });
      sendJson(res, 201, { id: newId, name: name.trim(), key, permissions: scopes });
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

// users: staff account management, mirroring the frontend /api/users surface.
//   GET    /users               → list including each account's sha256 passwordHash
//                                 (the key is the guard here, like admin-credential —
//                                 unlike the cookieless frontend /api/users which redacts)
//   POST   /users               → create { name, username, role, passwordHash }
//   POST   /users/verify        → validate a login { username, passwordHash }
//   DELETE /users/:id           → remove an account
//   PUT    /users/:id/password  → set a new password { passwordHash }
//   PUT    /users/:id/role      → change the account role { role }
// The primary `admin` account is the separate admin-credential resource and is
// never part of this list.
async function handleDataApiUsers(req, res, { apiKey, method, id, sub }) {
  if (!id) {
    if (method === 'GET') {
      const usersList = await readStaffUsers();
      sendJson(res, 200, usersList.map(staffUserWithHash));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const username =
        typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
      const role = typeof body?.role === 'string' ? body.role : '';
      const { passwordHash } = body || {};
      if (!name || !username) {
        sendJson(res, 400, { error: 'Name and username are required.' });
        return true;
      }
      if (!USER_ROLES.has(role)) {
        sendJson(res, 400, { error: 'role must be admin, operator, or viewer' });
        return true;
      }
      if (!isStorablePasswordHash(passwordHash)) {
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
      const newUser = { id: randomUUID(), name, username, role, passwordHash: await toStoredPasswordHash(passwordHash) };
      await setAppSetting(STAFF_USERS_KEY, [...usersList, newUser]);
      auditDataApi(req, apiKey, 'user.create', newUser.id, { username, role });
      sendJson(res, 201, staffUserWithHash(newUser));
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

  if (id === 'verify' && method === 'POST') {
    const body = await readJsonBody(req);
    const username =
      typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const { passwordHash } = body || {};
    const usersList = await readStaffUsers();
    const found = isSha256Hex(passwordHash)
      ? await findUserByCredential(usersList, username, passwordHash)
      : undefined;
    if (!found) {
      sendJson(res, 401, { valid: false });
      return true;
    }
    sendJson(res, 200, { valid: true, user: sanitizeStaffUser(found) });
    return true;
  }

  if (sub === 'password' && method === 'PUT') {
    const { passwordHash } = await readJsonBody(req);
    if (!isStorablePasswordHash(passwordHash)) {
      sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
      return true;
    }
    const usersList = await readStaffUsers();
    const index = usersList.findIndex((candidate) => candidate.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'user not found' });
      return true;
    }
    const nextUsers = [...usersList];
    nextUsers[index] = { ...nextUsers[index], passwordHash: await toStoredPasswordHash(passwordHash) };
    await setAppSetting(STAFF_USERS_KEY, nextUsers);
    auditDataApi(req, apiKey, 'user.password', id);
    sendEmpty(res);
    return true;
  }

  if (sub === 'role' && method === 'PUT') {
    const body = await readJsonBody(req);
    const role = typeof body?.role === 'string' ? body.role : '';
    if (!USER_ROLES.has(role)) {
      sendJson(res, 400, { error: 'role must be admin, operator, or viewer' });
      return true;
    }
    const usersList = await readStaffUsers();
    const index = usersList.findIndex((candidate) => candidate.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'user not found' });
      return true;
    }
    const nextUsers = [...usersList];
    nextUsers[index] = { ...nextUsers[index], role };
    await setAppSetting(STAFF_USERS_KEY, nextUsers);
    auditDataApi(req, apiKey, 'user.role', id, { role });
    sendJson(res, 200, staffUserWithHash(nextUsers[index]));
    return true;
  }

  if (!sub && method === 'DELETE') {
    const usersList = await readStaffUsers();
    if (!usersList.some((candidate) => candidate.id === id)) {
      sendJson(res, 404, { error: 'user not found' });
      return true;
    }
    await setAppSetting(STAFF_USERS_KEY, usersList.filter((candidate) => candidate.id !== id));
    auditDataApi(req, apiKey, 'user.delete', id);
    sendEmpty(res);
    return true;
  }

  return dataApiMethodNotAllowed(res);
}

// admin-credential: the primary admin password (sha256 hash stored in
// app_settings). The key is the guard here, so — unlike the public frontend
// endpoint, which is first-run-only and otherwise needs the current password —
// a printfarm_manage key may set or reset it outright.
//   GET  /admin-credential         → { configured }
//   PUT  /admin-credential         → set/reset { passwordHash }
//   POST /admin-credential/verify  → { passwordHash } → { valid }
async function handleDataApiAdminCredential(req, res, { apiKey, method, id }) {
  const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
  const storedHash = stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';

  if (id === 'verify' && method === 'POST') {
    const { passwordHash } = await readJsonBody(req);
    const valid = storedHash.length > 0 && (await verifyPassword(storedHash, passwordHash));
    sendJson(res, valid ? 200 : 401, { valid });
    return true;
  }
  if (id) {
    sendJson(res, 404, { error: 'Use /admin-credential or /admin-credential/verify.' });
    return true;
  }

  if (method === 'GET') {
    sendJson(res, 200, { configured: storedHash.length > 0 });
    return true;
  }
  if (method === 'PUT') {
    const { passwordHash } = await readJsonBody(req);
    if (!isStorablePasswordHash(passwordHash)) {
      sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
      return true;
    }
    await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: await toStoredPasswordHash(passwordHash) });
    auditDataApi(req, apiKey, 'admin-credential.set', null);
    sendEmpty(res, storedHash.length > 0 ? 200 : 201);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

// manager-requests: the operator/manager access-request workflow that the
// frontend exposes (request access → admin approves/denies → an api key is
// minted). Mirrors the cookieless /api/manager/* routes so an external manager
// app has full parity over granting and revoking access. Unlike the frontend
// status-poll flow (which reveals the minted key once via /status), the approve
// route returns the plaintext key inline since the calling key is the guard.
async function handleDataApiManagerRequests(req, res, { apiKey, method, id, sub }) {
  if (!id) {
    if (method === 'GET') {
      sendJson(res, 200, await listManagerRequests());
      return true;
    }
    if (method === 'POST') {
      const { name, description } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const newId = randomUUID();
      await createManagerRequest({
        id: newId,
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() || null : null,
      });
      auditDataApi(req, apiKey, 'manager-request.create', newId, { name: name.trim() });
      sendJson(res, 201, { id: newId });
      return true;
    }
    return dataApiMethodNotAllowed(res);
  }

  const mgr = await getManagerRequest(id);
  if (!mgr) {
    sendJson(res, 404, { error: 'Request not found' });
    return true;
  }

  if (sub === 'approve' && method === 'POST') {
    if (mgr.status !== 'pending') {
      sendJson(res, 400, { error: 'Request is not pending' });
      return true;
    }
    const key = randomBytes(24).toString('base64url');
    const keyId = randomUUID();
    await createSlicerApiKey({
      id: keyId,
      name: `Manager: ${mgr.name}`,
      keyHash: hash(key),
      keyPrefix: key.slice(0, 8),
      permissions: ['printfarm_manage'],
    });
    await approveManagerRequest(id, { apiKeyId: keyId, keySecret: key });
    auditDataApi(req, apiKey, 'manager-request.approve', id, { apiKeyId: keyId });
    sendJson(res, 200, { ok: true, apiKeyId: keyId, key });
    return true;
  }

  if (sub === 'deny' && method === 'POST') {
    if (mgr.status !== 'pending') {
      sendJson(res, 400, { error: 'Request is not pending' });
      return true;
    }
    await denyManagerRequest(id);
    auditDataApi(req, apiKey, 'manager-request.deny', id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (sub) {
    sendJson(res, 404, { error: 'Use /manager-requests/:id, /:id/approve, or /:id/deny.' });
    return true;
  }

  if (method === 'GET') {
    sendJson(res, 200, mgr);
    return true;
  }
  if (method === 'DELETE') {
    if (mgr.api_key_id) {
      await deleteSlicerApiKey(mgr.api_key_id);
    }
    await deleteManagerRequest(id);
    auditDataApi(req, apiKey, 'manager-request.delete', id);
    sendEmpty(res);
    return true;
  }
  return dataApiMethodNotAllowed(res);
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, 'no-store');
    return true;
  }

  if (requestUrl.pathname === '/api/version') {
    sendJson(res, 200, { buildId: BUILD_ID }, 'no-store');
    return true;
  }

  // Server-push replacement for the queue/maintenance notifiers, which used to
  // poll GET /api/queue and GET /api/maintenance/notifications every 10s/30s
  // from every open tab. Public, like those reads were — see eventStream.js.
  // Maintenance events are only fanned out to a privileged (admin/operator)
  // session, matching the frontend's existing staff-only gate.
  if (requestUrl.pathname === '/api/events' && req.method === 'GET') {
    const session = await resolveSession(req);
    const privileged = isPrivilegedRole(sessionRole(session));
    // `privileged` also gates PII in queue-added (submitterName); maintenance
    // events use the same staff-only gate.
    addEventSubscriber(req, res, { wantsMaintenance: privileged, privileged });
    return true;
  }

  if (await handleDataApi(req, res, requestUrl)) {
    return true;
  }

  // Server-side authorization gate. Runs before any frontend /api/* route so an
  // unauthenticated or under-privileged caller can no longer drive mutations the
  // React UI merely hides. Denied requests are answered here (401/403).
  if (!(await authorizeFrontendApi(req, res, requestUrl))) {
    return true;
  }

  // Filament Station: the SPA's cookie-session-gated surface. Reuses the exact
  // same handler as the key-gated /api/v1/filament-station/* the physical
  // daemon calls (handleFilamentStation itself doesn't check apiKey — auth
  // already happened above, same as it does in handleDataApi) — one route
  // implementation, two auth front doors, matching the existing distinction
  // between the browser's /api/* surface and the /api/v1/* automation surface.
  if (requestUrl.pathname.startsWith('/api/filament-station/')) {
    const segments = requestUrl.pathname
      .slice('/api/filament-station/'.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    return handleFilamentStation(req, res, { method: req.method, segments, requestUrl });
  }

  // Manager access request endpoints ──────────────────────────────────────────
  // POST /api/manager/request        — public; create a pending access request.
  // GET  /api/manager/requests        — admin frontend; list all requests.
  // GET  /api/manager/requests/:id/status — public; poll status, get key once.
  // POST /api/manager/requests/:id/approve — admin; approve & issue API key.
  // POST /api/manager/requests/:id/deny    — admin; deny request.
  // DELETE /api/manager/requests/:id      — admin; revoke & remove API key.
  // The two public endpoints carry CORS headers so a manager app on a different
  // origin can submit and poll.

  if (requestUrl.pathname === '/api/manager/request') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method === 'POST') {
      if (!(await guardPublicIntake(req, res, 'manager-request'))) {
        return true;
      }
      const { name, description } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const id = randomUUID();
      await createManagerRequest({
        id,
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() || null : null,
      });
      sendJson(res, 201, { id });
      return true;
    }
  }

  if (requestUrl.pathname === '/api/manager/requests' && req.method === 'GET') {
    sendJson(res, 200, await listManagerRequests());
    return true;
  }

  if (
    requestUrl.pathname.startsWith('/api/manager/requests/') &&
    requestUrl.pathname.endsWith('/status')
  ) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method === 'GET') {
      const id = decodeURIComponent(
        requestUrl.pathname.slice('/api/manager/requests/'.length, -'/status'.length),
      );
      const mgr = await getManagerRequest(id);
      if (!mgr) {
        sendJson(res, 404, { error: 'Request not found' });
        return true;
      }
      const payload = { id: mgr.id, status: mgr.status };
      if (mgr.status === 'approved' && mgr.key_secret) {
        payload.key = mgr.key_secret;
        await clearManagerRequestKeySecret(id);
      }
      sendJson(res, 200, payload);
      return true;
    }
  }

  if (
    requestUrl.pathname.startsWith('/api/manager/requests/') &&
    requestUrl.pathname.endsWith('/approve') &&
    req.method === 'POST'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/manager/requests/'.length, -'/approve'.length),
    );
    const mgr = await getManagerRequest(id);
    if (!mgr) {
      sendJson(res, 404, { error: 'Request not found' });
      return true;
    }
    if (mgr.status !== 'pending') {
      sendJson(res, 400, { error: 'Request is not pending' });
      return true;
    }
    const key = randomBytes(24).toString('base64url');
    const keyId = randomUUID();
    await createSlicerApiKey({
      id: keyId,
      name: `Manager: ${mgr.name}`,
      keyHash: hash(key),
      keyPrefix: key.slice(0, 8),
      permissions: ['printfarm_manage'],
    });
    await approveManagerRequest(id, { apiKeyId: keyId, keySecret: key });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (
    requestUrl.pathname.startsWith('/api/manager/requests/') &&
    requestUrl.pathname.endsWith('/deny') &&
    req.method === 'POST'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/manager/requests/'.length, -'/deny'.length),
    );
    const mgr = await getManagerRequest(id);
    if (!mgr) {
      sendJson(res, 404, { error: 'Request not found' });
      return true;
    }
    if (mgr.status !== 'pending') {
      sendJson(res, 400, { error: 'Request is not pending' });
      return true;
    }
    await denyManagerRequest(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (
    requestUrl.pathname.startsWith('/api/manager/requests/') &&
    req.method === 'DELETE'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/manager/requests/'.length),
    );
    const mgr = await getManagerRequest(id);
    if (!mgr) {
      sendJson(res, 404, { error: 'Request not found' });
      return true;
    }
    if (mgr.api_key_id) {
      await deleteSlicerApiKey(mgr.api_key_id);
    }
    await deleteManagerRequest(id);
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname === '/api/printers') {
    if (req.method === 'GET') {
      // Connection secrets (IP, API key, serial, url) only go to an operator/
      // admin session; anonymous/viewer/student callers always get the redacted
      // list, regardless of PUBLIC_VIEWER_MODE.
      const privileged = isPrivilegedRole(sessionRole(await resolveSession(req)));
      const printers = privileged ? await listPrinters(true) : await listPrintersRedacted();
      sendJsonWithEtag(req, res, 200, await overlayLiveTelemetryAll(printers));
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== 'string' || !body.id.trim()) {
        sendJson(res, 400, { error: 'printer id is required' });
        return true;
      }
      await upsertPrinter(body);
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
    const {
      command,
      heater,
      target,
      nozzleIndex,
      gcode,
      trayId,
      fanPort,
      speed,
      modeId,
      submode,
      type,
      color,
      vendor,
    } = await readJsonBody(req);
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
      type,
      color,
      vendor,
    });
    // Optimistic write so the displayed target reflects what was just sent —
    // see setPrinterTemperatureTarget's comment for why this is needed
    // (chamber_target in particular can otherwise get stuck on a stale value).
    if (command === 'set_temperature') {
      await setPrinterTemperatureTarget(id, heater, target, nozzleIndex).catch((error) => {
        console.error('Failed to persist optimistic temperature target', error);
      });
    }
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

  // Per-printer maintenance summary. Must precede the generic /api/printers/:id
  // GET below so the longer path isn't swallowed by it.
  if (
    requestUrl.pathname.startsWith('/api/printers/') &&
    requestUrl.pathname.endsWith('/maintenance') &&
    req.method === 'GET'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/printers/'.length, -'/maintenance'.length),
    );
    const summary = await getPrinterMaintenance(id);
    if (!summary) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    sendJson(res, 200, summary, 'no-store');
    return true;
  }

  // Maintenance fleet-widget aggregates.
  if (requestUrl.pathname === '/api/maintenance/summary' && req.method === 'GET') {
    sendJson(res, 200, await getMaintenanceSummary(), 'no-store');
    return true;
  }

  // In-app maintenance notifications (NotificationBell feed).
  if (requestUrl.pathname === '/api/maintenance/notifications' && req.method === 'GET') {
    const unreadOnly = requestUrl.searchParams.get('unread') === 'true';
    sendJson(res, 200, await listMaintenanceNotifications({ unreadOnly }), 'no-store');
    return true;
  }
  if (requestUrl.pathname === '/api/maintenance/notifications/read' && req.method === 'POST') {
    const body = await readJsonBody(req);
    await markMaintenanceNotificationsRead(Array.isArray(body?.ids) ? body.ids : null);
    sendEmpty(res);
    return true;
  }

  // Mark a maintenance task completed (operator/admin).
  if (
    requestUrl.pathname.startsWith('/api/maintenance/') &&
    requestUrl.pathname.endsWith('/complete') &&
    req.method === 'POST'
  ) {
    const id = decodeURIComponent(
      requestUrl.pathname.slice('/api/maintenance/'.length, -'/complete'.length),
    );
    const body = await readJsonBody(req);
    const notes = typeof body?.notes === 'string' ? body.notes.trim() || null : null;
    const event = await completeMaintenanceEvent(id, notes);
    if (!event) {
      sendJson(res, 404, { error: 'Pending maintenance task not found' });
      return true;
    }
    broadcastMaintenanceStatusUpdate();
    sendJson(res, 200, event);
    return true;
  }

  // List maintenance tasks with optional printer / status / type filters.
  if (requestUrl.pathname === '/api/maintenance' && req.method === 'GET') {
    const events = await listMaintenanceEvents({
      printerId: requestUrl.searchParams.get('printer'),
      status: requestUrl.searchParams.get('status') || 'pending',
      maintenanceType: requestUrl.searchParams.get('type'),
    });
    sendJson(res, 200, events, 'no-store');
    return true;
  }

  // Global default maintenance intervals (admin-configurable; GET is public read,
  // PUT is admin-gated by the /api/settings/ rule in isAdminMutation).
  if (requestUrl.pathname === '/api/settings/maintenance-intervals') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getMaintenanceDefaultIntervals());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const intervals = Array.isArray(body) ? body : body?.intervals;
      const saved = await setMaintenanceDefaultIntervals(intervals);
      sendJson(res, 200, saved);
      return true;
    }
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
    // Full record (with connection secrets) only for an operator/admin session;
    // everyone else gets the redacted view.
    const privileged = isPrivilegedRole(sessionRole(await resolveSession(req)));
    const printer = privileged ? await getPrinterById(id) : await getRedactedPrinterById(id);
    if (!printer) {
      sendJson(res, 404, { error: 'Printer not found' });
      return true;
    }
    sendJson(res, 200, await overlayLiveTelemetry(printer));
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

  // Admin-only (see isSensitiveRead): approximate app-layer traffic by route
  // class, backing the Network Usage page. "Approximate" because it's Node
  // counting response chunk bytes, not TLS/HTTP framing or nginx-only paths.
  if (requestUrl.pathname === '/api/network-usage' && req.method === 'GET') {
    const [today, monthToDate, daily, byRoute, poller] = await Promise.all([
      getNetworkUsageToday(),
      getNetworkUsageMonthToDate(),
      listNetworkUsageDaily(30),
      getNetworkUsageByRoute(30),
      getPollerHealth(),
    ]);
    sendJson(res, 200, {
      today,
      monthToDate,
      daily,
      byRoute,
      poller,
      processStartedAt: new Date(getProcessStartSeconds() * 1000).toISOString(),
    });
    return true;
  }

  // Admin-only, cheap in-memory read (no DB query) — safe to poll every couple
  // of seconds. Returns cumulative-since-process-start totals; the frontend
  // diffs two samples over the elapsed wall-clock time to derive a live
  // bytes/sec rate, the same "diff a running counter" approach the 60s DB
  // flush below uses for history.
  if (requestUrl.pathname === '/api/network-usage/live' && req.method === 'GET') {
    const bytesOutByRoute = snapshotBytesByRoute();
    const bytesInByRoute = snapshotBytesInByRoute();
    const bytesOut = Object.values(bytesOutByRoute).reduce((sum, value) => sum + value, 0);
    const bytesIn = Object.values(bytesInByRoute).reduce((sum, value) => sum + value, 0);
    sendJson(res, 200, { bytesOut, bytesIn, timestamp: Date.now() });
    return true;
  }

  // Read path: cheap DB read of the stored queue. Submitter PII (name, email,
  // notes) is stripped for anonymous/viewer/student callers; only an operator/
  // admin session sees the full record.
  if (requestUrl.pathname === '/api/queue') {
    if (req.method === 'GET') {
      const privileged = isPrivilegedRole(sessionRole(await resolveSession(req)));
      const data = await listQueueData();
      sendJson(res, 200, privileged ? data : redactQueueDataForPublic(data));
      return true;
    }
  }

  // Public, read-only status check for the queue-availability window — lets
  // /request show a "closed" notice before a student even opens the form,
  // without duplicating the day/time logic client-side. An admin/operator
  // browsing while logged in (session cookie still present on the public
  // /request page) always sees the queue as open — staff can add jobs
  // outside the configured student-submission window. `bypassUntil` is
  // surfaced even for a staff caller (whose own `open` is already forced
  // true) so the Queue page can show a countdown for an active manual
  // bypass.
  if (requestUrl.pathname === '/api/queue/availability' && req.method === 'GET') {
    const status = await getQueueAvailabilityStatus();
    if (isPrivilegedRole(sessionRole(await resolveSession(req)))) {
      sendJson(res, 200, { ...status, open: true });
      return true;
    }
    sendJson(res, 200, status);
    return true;
  }

  // Operator/admin-only: temporarily reopens /request to everyone (students
  // included) for QUEUE_AVAILABILITY_BYPASS_MS, regardless of the configured
  // schedule — e.g. a student needs to submit right now but the window is
  // closed. Access is gated upstream by isOperatorMutation/authorizeFrontendApi.
  // Calling it again while already active just restarts the window from now.
  if (requestUrl.pathname === '/api/queue/availability/bypass' && req.method === 'POST') {
    const session = await resolveSession(req);
    const until = new Date(Date.now() + QUEUE_AVAILABILITY_BYPASS_MS).toISOString();
    await setAppSetting(QUEUE_AVAILABILITY_BYPASS_KEY, {
      until,
      activatedBy: session?.name || null,
    });
    sendJson(res, 200, { open: true, bypassUntil: until });
    return true;
  }

  // In-app print-request form. Public (no auth, like the rest of the frontend
  // /api/* surface): a student fills out /request and the model file is stored
  // directly in Postgres. Replaces the old Google Form → Sheet → CSV sync.
  if (requestUrl.pathname === '/api/queue/submit' && req.method === 'POST') {
    if (!(await guardPublicIntake(req, res, 'queue-submit'))) {
      return true;
    }
    const submitterSession = await resolveSession(req);
    const isStaffSubmitter = isPrivilegedRole(sessionRole(submitterSession));
    const availability = isStaffSubmitter ? { open: true } : await getQueueAvailabilityStatus();
    if (!availability.open) {
      sendJson(res, 403, { error: availability.message });
      return true;
    }

    let parsed;
    try {
      parsed = await parsePrintRequest(req);
    } catch (error) {
      if (error.message === 'FILE_TOO_LARGE') {
        const limitMb = Math.round(QUEUE_UPLOAD_MAX_BYTES / (1024 * 1024));
        sendJson(res, 413, { error: `File exceeds the ${limitMb} MB upload limit.` });
      } else {
        sendJson(res, 400, { error: 'Invalid form submission' });
      }
      return true;
    }

    const { fields, file } = parsed;
    const firstName = (fields.firstName || '').trim();
    const lastName = (fields.lastName || '').trim();
    const studentId = (fields.studentId || '').trim();
    const course = (fields.course || '').trim();
    const email = (fields.email || '').trim();
    const noteText = (fields.notes || '').trim();
    const quantity = Math.max(1, Number.parseInt(fields.quantity || '1', 10) || 1);
    // For a logged-in admin/operator, the sender identity is forced from the
    // session (not the submitted form fields), so an authenticated staff
    // caller — including a raw curl request carrying the session cookie —
    // can never spoof another person's name in the submitted-by field.
    const submitterName = isStaffSubmitter
      ? submitterSession.name
      : [firstName, lastName].filter(Boolean).join(' ').trim() || studentId;

    if (!submitterName) {
      sendJson(res, 400, { error: 'Please provide your name or student ID.' });
      return true;
    }
    if (!file || file.content.length === 0) {
      sendJson(res, 400, { error: 'Please attach a model file to print.' });
      return true;
    }

    const ext = path.extname(file.filename || '').toLowerCase();
    if (!QUEUE_ALLOWED_FILE_EXT.has(ext)) {
      sendJson(res, 415, {
        error: `Unsupported file type "${ext || 'unknown'}". Allowed: STL, 3MF, OBJ.`,
      });
      return true;
    }

    const submittedAt = new Date();
    const noteParts = [
      studentId ? `Student ID: ${studentId}` : '',
      course ? `Course: ${course}` : '',
      noteText,
    ].filter(Boolean);
    const estimatedTime = Math.max(30, quantity * 60);
    const id = `queue-${createHash('sha1')
      .update(`${submittedAt.toISOString()}|${studentId || submitterName}|${file.filename}`)
      .digest('hex')
      .slice(0, 16)}`;

    const job = {
      id,
      filename: file.filename || `Submission ${id}`,
      fileCount: quantity,
      submitterName,
      submitterEmail: email || null,
      notes: noteParts.join(' | ') || null,
      submittedAt,
      priority: quantity >= 3 ? 'high' : quantity >= 2 ? 'medium' : 'low',
      estimatedTime,
      fileContent: file.content,
      fileMime: file.mimeType || 'application/octet-stream',
      fileSize: file.content.length,
    };

    await insertQueueSubmission(job);
    sendQueueAddedNotifications([{ ...job, stlFileUrl: `/api/queue/${id}/file` }]).catch(
      (error) => {
        logger.error('failed to send queue add notification', error);
      },
    );
    broadcastQueueStatusUpdate();
    sendJson(res, 201, { ok: true, id });
    return true;
  }

  // Download a stored submission's model file straight from the DB.
  if (
    requestUrl.pathname.startsWith('/api/queue/') &&
    requestUrl.pathname.endsWith('/file') &&
    req.method === 'GET'
  ) {
    const jobId = decodeURIComponent(
      requestUrl.pathname.slice('/api/queue/'.length, -'/file'.length),
    );
    const inline = requestUrl.searchParams.get('open') === '1';
    const streamed = await streamQueueJobFile(res, jobId, { inline });
    if (!streamed) {
      sendJson(res, 404, { error: 'File not found' });
    }
    return true;
  }

  if (requestUrl.pathname === '/api/queue/reset' && req.method === 'POST') {
    await resetQueueJobs();
    broadcastQueueStatusUpdate();
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname.startsWith('/api/queue/') && requestUrl.pathname.endsWith('/printed') && req.method === 'POST') {
    const jobId = decodeURIComponent(requestUrl.pathname.slice('/api/queue/'.length, -'/printed'.length));
    await markQueueJobPrinted(jobId);
    broadcastQueueStatusUpdate();
    sendEmpty(res);
    return true;
  }

  if (requestUrl.pathname.startsWith('/api/queue/') && req.method === 'DELETE') {
    await deleteQueueJob(decodeURIComponent(requestUrl.pathname.slice('/api/queue/'.length)));
    broadcastQueueStatusUpdate();
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
      const { name, permissions } = await readJsonBody(req);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const scopes = normalizeKeyPermissions(permissions);
      if (scopes.length === 0) {
        sendJson(res, 400, { error: `permissions must include at least one of: ${SLICER_KEY_PERMISSIONS.join(', ')}` });
        return true;
      }
      const key = randomBytes(24).toString('base64url');
      const id = randomUUID();
      await createSlicerApiKey({
        id,
        name: name.trim(),
        keyHash: hash(key),
        keyPrefix: key.slice(0, 8),
        permissions: scopes,
      });
      sendJson(res, 201, { id, name: name.trim(), key, permissions: scopes });
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
    // A verified slicer "Device" hand-off grants an operator session (pause/
    // resume/cancel), backed by the same cookie gate as a normal login.
    await issueSession(
      req,
      res,
      { id: 'slicer-operator', name: 'Slicer Operator', username: 'slicer-operator', role: 'operator' },
      { remember: false },
    );
    sendJson(res, 200, { printerId: grant.printerId });
    return true;
  }

  // OAuth (SSO) sign-in — Google and Microsoft Entra ID. The dashboard auth is
  // cookieless, so the Authorization Code flow is bridged to the client with an
  // HMAC-signed grant token carried in a URL param — the same hand-off shape as
  // the slicer grant above. The provider rides in the path on start/callback and
  // inside the grant on verify.
  //   GET  /api/auth/providers          → { google, microsoft } : which buttons
  //   GET  /api/auth/:provider/config   → { enabled }           : single provider
  //   GET  /api/auth/:provider/start    → 302 to the provider's consent screen
  //   GET  /api/auth/:provider/callback → exchange code, 302 back with ?oauth_grant
  //   POST /api/auth/verify             → { token } → { user }  : provider-agnostic
  if (requestUrl.pathname === '/api/auth/providers' && req.method === 'GET') {
    const [google, microsoft, adfs, saml] = await Promise.all([
      getOAuthConfig('google'),
      getOAuthConfig('microsoft'),
      getOAuthConfig('adfs'),
      getSamlConfig(),
    ]);
    sendJson(res, 200, {
      google: isOAuthConfigured(google),
      microsoft: isOAuthConfigured(microsoft),
      adfs: isOAuthConfigured(adfs),
      saml: isSamlConfigured(saml),
      googleLabel: google?.displayName || '',
      microsoftLabel: microsoft?.displayName || '',
      adfsLabel: adfs?.displayName || '',
      samlLabel: saml?.displayName || '',
    });
    return true;
  }

  // SAML 2.0 SSO endpoints (the dashboard is the SP).
  //   GET  /api/auth/saml/metadata → SP metadata XML (public, for IdP setup)
  //   GET  /api/auth/saml/start    → 302 to the IdP carrying a deflate AuthnRequest
  //   POST /api/auth/saml/acs      → consume the IdP's signed SAMLResponse (POST binding)
  if (requestUrl.pathname === '/api/auth/saml/metadata' && req.method === 'GET') {
    const config = await getSamlConfig();
    const { spEntityId, acsUrl } = await resolveSamlEndpoints(config, req);
    const xml = buildSpMetadata({ spEntityId, acsUrl });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="sp-metadata.xml"');
    res.setHeader('Cache-Control', 'no-store');
    res.end(xml);
    return true;
  }

  // Friendly deep-link alias for the SSO portal. Put a "Print Farm" button on the
  // IdP portal page pointing at https://<this-host>/launch; clicking it kicks off
  // the SP-initiated SAML login (→ IdP → ACS) and lands the signed-in user on the
  // dashboard. It is a thin 302 to the canonical SAML start so there is a single
  // source of truth for the flow.
  if (requestUrl.pathname === '/launch' && req.method === 'GET') {
    sendRedirect(res, '/api/auth/saml/start');
    return true;
  }

  if (requestUrl.pathname === '/api/auth/saml/start' && req.method === 'GET') {
    const config = await getSamlConfig();
    if (!isSamlConfigured(config)) {
      sendRedirect(res, '/login?oauth_error=not_configured');
      return true;
    }
    const { spEntityId, acsUrl } = await resolveSamlEndpoints(config, req);
    const secret = await getOAuthSigningSecret();
    // Build the request first so its id can be bound into the signed RelayState;
    // the ACS then enforces InResponseTo against it (CSRF / unsolicited-response
    // protection on top of the assertion signature).
    const { url, requestId } = buildAuthnRequest({
      spEntityId,
      acsUrl,
      idpSsoUrl: config.idpSsoUrl,
      relayState: '',
    });
    const relayState = signState(secret, { n: requestId, p: 'saml' });
    const redirectUrl = new URL(url);
    redirectUrl.searchParams.set('RelayState', relayState);
    sendRedirect(res, redirectUrl.toString());
    return true;
  }

  if (requestUrl.pathname === '/api/auth/saml/acs' && req.method === 'POST') {
    const config = await getSamlConfig();
    if (!isSamlConfigured(config)) {
      sendRedirect(res, '/login?oauth_error=not_configured');
      return true;
    }
    const { spEntityId, acsUrl } = await resolveSamlEndpoints(config, req);
    const secret = await getOAuthSigningSecret();

    // The IdP POSTs an auto-submit form (application/x-www-form-urlencoded).
    let form;
    try {
      const body = await readBody(req);
      form = new URLSearchParams(body.toString('utf8'));
    } catch {
      sendRedirect(res, '/login?oauth_error=denied');
      return true;
    }
    const samlResponseB64 = form.get('SAMLResponse') || '';
    const relayState = form.get('RelayState') || '';
    // RelayState is our own signed token; recover the AuthnRequest id we issued.
    const relayData = verifyState(secret, relayState);
    const expectedInResponseTo = relayData && relayData.p === 'saml' ? relayData.n : null;

    let identity;
    try {
      identity = parseAndVerifySamlResponse({
        samlResponseB64,
        idpCertificate: config.idpCertificate,
        spEntityId,
        acsUrl,
        expectedInResponseTo,
      });
    } catch (error) {
      if (!(error instanceof SamlError)) {
        throw error;
      }
      sendRedirect(res, '/login?oauth_error=saml_invalid');
      return true;
    }

    // Auto-provision gate. When off, only users already in the staff list may
    // sign in, and they keep their assigned role (the assertion can't escalate);
    // a known account always keeps its stored role regardless. When on, an
    // unknown user is admitted with the (validated) role the assertion carries.
    const staffUsers = await readStaffUsers();
    const existing = staffUsers.find(
      (account) =>
        typeof account.username === 'string' &&
        account.username.toLowerCase() === identity.email.toLowerCase(),
    );
    if (!existing && !config.autoProvisionUsers) {
      sendRedirect(res, '/login?oauth_error=saml_not_provisioned');
      return true;
    }
    const role = existing && USER_ROLES.has(existing.role)
      ? existing.role
      : normalizeSamlRole(identity.role);

    const grant = mintAuthGrant(secret, {
      provider: 'saml',
      sub: identity.email,
      email: identity.email,
      name: identity.name || identity.email,
      role,
    });
    sendRedirect(res, `/login?oauth_grant=${encodeURIComponent(grant)}`);
    return true;
  }

  // ADFS callback lands on the fixed registered path /api/auth/oauth2_redirect.
  // response_mode=form_post → ADFS POSTs code+state in the body; fall back to
  // GET query params for any non-form_post configuration.
  if (requestUrl.pathname === '/api/auth/oauth2_redirect' &&
      (req.method === 'GET' || req.method === 'POST')) {
    let callbackUrl = requestUrl;
    if (req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      callbackUrl = new URL(requestUrl.toString());
      for (const [k, v] of params) callbackUrl.searchParams.set(k, v);
    }
    await oauthExchangeCallback(req, res, callbackUrl, 'adfs');
    return true;
  }

  const ssoMatch = requestUrl.pathname.match(
    /^\/api\/auth\/(google|microsoft|adfs)\/(config|start|callback)$/,
  );
  if (ssoMatch && req.method === 'GET') {
    const providerName = ssoMatch[1];
    const op = ssoMatch[2];
    const provider = OAUTH_PROVIDERS[providerName];
    const config = await getOAuthConfig(providerName);

    if (op === 'config') {
      sendJson(res, 200, { enabled: isOAuthConfigured(config) });
      return true;
    }

    if (!isOAuthConfigured(config)) {
      sendRedirect(res, '/login?oauth_error=not_configured');
      return true;
    }
    const secret = await getOAuthSigningSecret();

    if (op === 'start') {
      const nonce = randomUUID();
      const state = signState(secret, { n: nonce, p: providerName });
      const authorizeUrl = new URL(provider.authorizeEndpoint(config));
      authorizeUrl.searchParams.set('client_id', config.clientId);
      authorizeUrl.searchParams.set('redirect_uri', await oauthRedirectUri(req, providerName, config));
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', OAUTH_SCOPE);
      authorizeUrl.searchParams.set('state', state);
      // ADFS requires a nonce for OpenID Connect flows; without it ADFS loses
      // session state and redirects to /adfs/ls?error=state instead of our callback.
      if (providerName === 'adfs' || config.authority) {
        authorizeUrl.searchParams.set('nonce', nonce);
      }
      // form_post: ADFS POSTs code+state from its own HTML page directly to our
      // redirect_uri — avoids ADFS constructing a GET redirect using its internal
      // IP instead of the public hostname, which caused /adfs/ls?error=state.
      if (providerName === 'adfs') {
        authorizeUrl.searchParams.set('response_mode', 'form_post');
      }
      // Force a fresh login so a shared kiosk doesn't silently reuse a session.
      // ADFS and on-prem AD FS only understand prompt=login/none/consent —
      // they reject the Entra/Google `select_account` value with invalid_request.
      authorizeUrl.searchParams.set(
        'prompt',
        config.authority || providerName === 'adfs' ? 'login' : 'select_account',
      );
      sendRedirect(res, authorizeUrl.toString());
      return true;
    }

    // op === 'callback' (google / microsoft only; adfs uses the dedicated route above)
    await oauthExchangeCallback(req, res, requestUrl, providerName);
    return true;
  }

  // Username/password login → server session. Verifies against the admin
  // bootstrap credential or a staff account (same sha256-hash credential format
  // as before), then issues an HttpOnly session cookie. This is what actually
  // authorizes subsequent mutations; the client role state is presentation only.
  if (requestUrl.pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = getClientIp(req) || 'unknown';
    // Parse the body first so the username is available for the per-account lock.
    const body = await readJsonBody(req);
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const passwordHash = body?.passwordHash;
    const remember = Boolean(body?.remember);
    const rateKey = { ip, username };

    const rate = await guardCredentialAttempt(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      sendJson(res, 429, {
        error: 'Too many failed attempts. Please wait and try again.',
        retryAfterMs: rate.retryAfterMs,
      });
      return true;
    }

    if (!username || !isSha256Hex(passwordHash)) {
      await recordCredentialFailure(rateKey);
      sendJson(res, 401, { error: 'Invalid credentials.' });
      return true;
    }

    let user = null;
    if (username === RESERVED_USERNAME) {
      const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
      const storedHash = stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';
      if (storedHash && (await verifyPassword(storedHash, passwordHash))) {
        user = { id: 'admin', name: 'Print Farm Admin', username: 'admin', role: 'admin' };
        // Transparently upgrade a legacy bare-sha256 credential to scrypt.
        if (passwordNeedsUpgrade(storedHash)) {
          await setAppSetting(ADMIN_CREDENTIAL_KEY, {
            passwordHash: await derivePasswordHash(passwordHash),
          }).catch(() => {});
        }
      }
    } else {
      const usersList = await readStaffUsers();
      const found = await findUserByCredential(usersList, username, passwordHash);
      if (found) {
        user = sanitizeStaffUser(found);
        // Transparently upgrade a legacy bare-sha256 credential to scrypt.
        if (passwordNeedsUpgrade(found.passwordHash)) {
          const upgraded = await derivePasswordHash(passwordHash);
          const nextUsers = usersList.map((candidate) =>
            candidate.id === found.id ? { ...candidate, passwordHash: upgraded } : candidate,
          );
          await setAppSetting(STAFF_USERS_KEY, nextUsers).catch(() => {});
        }
      }
    }

    if (!user) {
      await recordCredentialFailure(rateKey);
      sendJson(res, 401, { error: 'Invalid credentials.' });
      return true;
    }

    await clearCredentialAttempts(rateKey);
    await issueSession(req, res, user, { remember });
    await recordAuditLog({
      actorName: user.name,
      actorUsername: user.username,
      actorRole: user.role,
      action: 'auth.login',
      source: 'web',
      ip: getClientIp(req),
    }).catch(() => {});
    sendJson(res, 200, { user });
    return true;
  }

  // Destroy the current session and clear the cookie. Idempotent.
  if (requestUrl.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      const tokenHash = hash(token);
      // Revoke any ephemeral slicer-upload key minted for this session.
      await deleteSlicerApiKeysBySession(tokenHash).catch(() => {});
      await deleteSession(tokenHash).catch(() => {});
      await invalidateCachedSession(tokenHash).catch(() => {});
    }
    clearSessionCookie(req, res);
    sendEmpty(res);
    return true;
  }

  // Mint / revoke an ephemeral slicer-upload API key bound to the caller's
  // session. The slicer requests one right after login (so the user never has to
  // create or paste a key) and revokes it on exit; it is also auto-revoked on
  // logout above. The plaintext key is returned once and only held in slicer
  // memory. Authenticated by the session cookie, not by an API key.
  if (requestUrl.pathname === '/api/auth/slicer-token') {
    const session = await resolveSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'Not signed in.' });
      return true;
    }
    const sessionTokenHash = hash(parseCookies(req)[SESSION_COOKIE]);

    if (req.method === 'POST') {
      // Re-mint is idempotent: drop any prior token for this session first.
      await deleteSlicerApiKeysBySession(sessionTokenHash).catch(() => {});
      const key = randomBytes(24).toString('base64url');
      const newId = randomUUID();
      await createSlicerApiKey({
        id: newId,
        name: `Slicer session (${session.username})`,
        keyHash: hash(key),
        keyPrefix: key.slice(0, 8),
        permissions: ['slicer_upload'],
        sessionTokenHash,
      });
      sendJson(res, 201, { id: newId, key, permissions: ['slicer_upload'] });
      return true;
    }
    if (req.method === 'DELETE') {
      await deleteSlicerApiKeysBySession(sessionTokenHash).catch(() => {});
      sendEmpty(res);
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  // Who am I? Returns the session's user (or null) so the SPA can restore auth
  // state on load from the cookie rather than trusting client-held state.
  if (requestUrl.pathname === '/api/auth/session' && req.method === 'GET') {
    const session = await resolveSession(req);
    sendJson(
      res,
      200,
      {
        user: session
          ? {
              id: session.user_id,
              name: session.name,
              username: session.username,
              role: session.role,
            }
          : null,
      },
      'no-store',
    );
    return true;
  }

  if (requestUrl.pathname === '/api/auth/verify' && req.method === 'POST') {
    const secret = await getOAuthSigningSecret();
    const { token } = await readJsonBody(req);
    const grant = verifyAuthGrant(secret, token);
    if (!grant) {
      sendJson(res, 401, { error: 'Invalid or expired sign-in' });
      return true;
    }
    const user = {
      id: `${grant.provider}:${grant.sub}`,
      name: grant.name,
      username: grant.email,
      role: grant.role,
    };
    // The OAuth/SSO hand-off establishes a real server session too, so the
    // resulting (typically read-only) browser is gated by the same cookie.
    await issueSession(req, res, user, { remember: true });
    sendJson(res, 200, { user });
    return true;
  }

  // Admin software-update check. Compares the running image's baked commit SHA
  // against the latest commit on the configured GitHub branch (cached ~20 min),
  // so an admin sees "update available" without SSH-ing into the host. Admin-only
  // (classified in isSensitiveRead); reveals no secrets.
  if (requestUrl.pathname === '/api/admin/update-status' && req.method === 'GET') {
    const current = runningVersion();
    if (!UPDATE_CHECK_REPO) {
      sendJson(res, 200, { enabled: false, current }, 'no-store');
      return true;
    }
    try {
      const force = requestUrl.searchParams.get('force') === '1';
      const info = await fetchLatestCommit(force);
      const latest = info?.latest || null;
      // Treat a commit as an update only when we know both sides and they differ.
      // A short SHA baked at build time still matches via prefix comparison.
      const updateAvailable = Boolean(
        latest && current && current !== 'dev' && !latest.startsWith(current) && !current.startsWith(latest),
      );
      sendJson(
        res,
        200,
        {
          enabled: true,
          current,
          latest,
          updateAvailable,
          latestCommittedAt: info?.latestCommittedAt || null,
          checkedAt: info ? new Date(info.checkedAt).toISOString() : null,
          canApply: WATCHTOWER_TOKEN.length > 0,
        },
        'no-store',
      );
    } catch (err) {
      sendJson(res, 200, { enabled: true, current, error: 'update check failed' }, 'no-store');
    }
    return true;
  }

  // One-click apply: trigger the Watchtower sidecar to pull the newer :latest
  // images and recreate the app containers. Admin-only (isAdminMutation) and
  // audited. Watchtower's HTTP API blocks the request until the pull+recreate
  // cycle finishes, which can take well over a minute — and it will recreate
  // this very `web` container mid-flight, killing this request outright. So
  // this handler is decoupled from both the client connection (closing the
  // browser tab has no effect — nothing here listens for the request socket
  // to close) and from waiting out Watchtower's full run: the guard timeout is
  // generous (5 min, just a backstop against a truly hung updater) and, unlike
  // a genuine connect failure, timing it out is treated as "started" rather
  // than an error, since the trigger had already reached Watchtower.
  if (requestUrl.pathname === '/api/admin/update/apply' && req.method === 'POST') {
    if (!WATCHTOWER_TOKEN) {
      sendJson(res, 503, { error: 'One-click update is not configured on this host' });
      return true;
    }
    const session = await resolveSession(req);
    await recordAuditLog({
      actorName: session ? session.name : null,
      actorUsername: session ? session.username : null,
      actorRole: session ? session.role : null,
      action: 'software.update.apply',
      target: UPDATE_CHECK_REPO || null,
      details: { current: runningVersion(), latest: updateCheckCache?.latest || null },
      source: 'web',
      ip: getClientIp(req),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const resp = await fetch(WATCHTOWER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WATCHTOWER_TOKEN}` },
        signal: controller.signal,
      });
      if (!resp.ok) {
        sendJson(res, 502, { error: `Updater responded ${resp.status}` });
        return true;
      }
      sendJson(res, 202, { started: true });
    } catch (err) {
      if (err?.name === 'AbortError') {
        // Our own backstop fired, not a connect failure — the trigger reached
        // Watchtower and the update is very likely underway.
        sendJson(res, 202, { started: true });
      } else {
        sendJson(res, 502, { error: 'Could not reach the updater service' });
      }
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  // Full-data backup. Every table the app considers "data" (printers,
  // filament inventory, queue jobs + their stored model files, app_settings —
  // branding/automation/SSO/staff users/admin credential all live there —
  // API keys, audit logs, maintenance, network usage) is serialized to one
  // JSON file per table plus a manifest.json, zipped in memory (buildZip
  // needs the whole archive assembled to know the central-directory offsets)
  // and streamed back as a download. Admin-only (isSensitiveRead); this is
  // deliberately not redacted like the public printer list, since it's the
  // whole point of a backup.
  if (requestUrl.pathname === '/api/admin/backup/download' && req.method === 'GET') {
    const { manifest, tables } = await buildBackupSnapshot();
    const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }];
    for (const [name, rows] of Object.entries(tables)) {
      entries.push({ name: `tables/${name}.json`, data: Buffer.from(JSON.stringify(rows)) });
    }
    const zip = createZip(entries);
    const timestamp = manifest.generatedAt.replace(/[:.]/g, '-');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', zip.length);
    res.setHeader('Content-Disposition', `attachment; filename="printfarm-backup-${timestamp}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(zip);
    return true;
  }

  // Restore from a backup archive produced by the endpoint above. Destructive:
  // TRUNCATEs and replaces every table named in the archive inside one
  // transaction (restoreBackupSnapshot). Admin-only (isAdminMutation) and
  // audited. The upload is the raw zip bytes as the request body (not
  // multipart) — simpler for a single-file upload, matching the
  // /api/v1/queue/:id/file PUT pattern.
  if (requestUrl.pathname === '/api/admin/backup/restore' && req.method === 'POST') {
    let archive;
    try {
      archive = await readBodyBounded(req, BACKUP_UPLOAD_MAX_BYTES);
    } catch {
      const limitMb = Math.round(BACKUP_UPLOAD_MAX_BYTES / (1024 * 1024));
      sendJson(res, 413, { error: `Backup archive exceeds the ${limitMb} MB upload limit.` });
      return true;
    }

    let entries;
    try {
      entries = readZip(archive);
    } catch (error) {
      sendJson(res, 400, { error: `Not a valid backup archive: ${error.message}` });
      return true;
    }

    const rawTables = {};
    let manifest = null;
    for (const entry of entries) {
      try {
        if (entry.name === 'manifest.json') {
          manifest = JSON.parse(entry.data.toString('utf8'));
        } else if (entry.name.startsWith('tables/') && entry.name.endsWith('.json')) {
          const tableName = entry.name.slice('tables/'.length, -'.json'.length);
          rawTables[tableName] = JSON.parse(entry.data.toString('utf8'));
        }
      } catch (error) {
        sendJson(res, 400, { error: `Corrupt backup archive entry "${entry.name}": ${error.message}` });
        return true;
      }
    }
    if (!manifest || Object.keys(rawTables).length === 0) {
      sendJson(res, 400, { error: 'Backup archive is missing manifest.json or table data.' });
      return true;
    }

    const session = await resolveSession(req);
    try {
      const tables = reviveBackupTables(rawTables);
      await restoreBackupSnapshot(tables);
    } catch (error) {
      logger.error('backup restore failed', { err: error instanceof Error ? error.message : error });
      sendJson(res, 500, { error: 'Restore failed; no changes were committed.' });
      return true;
    }

    const restoredTables = Object.entries(rawTables).map(([name, rows]) => ({
      name,
      rowCount: Array.isArray(rows) ? rows.length : 0,
    }));
    await recordAuditLog({
      actorName: session ? session.name : null,
      actorUsername: session ? session.username : null,
      actorRole: session ? session.role : null,
      action: 'backup.restore',
      target: null,
      details: { sourceGeneratedAt: manifest.generatedAt || null, tables: restoredTables },
      source: 'web',
      ip: getClientIp(req),
    });
    sendJson(res, 200, { ok: true, tables: restoredTables });
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
      await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: await derivePasswordHash(passwordHash) });
      // First-run setup signs the admin in immediately (matches the client flow).
      await issueSession(
        req,
        res,
        { id: 'admin', name: 'Print Farm Admin', username: 'admin', role: 'admin' },
        { remember: false },
      );
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
      if (!(await verifyPassword(storedHash, String(currentPasswordHash || '')))) {
        sendJson(res, 401, { error: 'Current password is incorrect' });
        return true;
      }
      await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: await derivePasswordHash(newPasswordHash) });
      // Revoke every existing admin session except the caller's, then re-issue a
      // fresh cookie so the password change instantly invalidates stale sessions.
      await deleteSessionsForUser('admin').catch(() => {});
      await revokeCachedUserSessions('admin').catch(() => {});
      await issueSession(
        req,
        res,
        { id: 'admin', name: 'Print Farm Admin', username: 'admin', role: 'admin' },
        { remember: false },
      );
      sendEmpty(res);
      return true;
    }
  }

  // Validates an admin login. Returns { valid } and an HTTP 401 on mismatch so
  // the client can branch without parsing the body. The hash is compared in
  // constant time; the stored hash is never echoed back. Brute-force throttled on
  // the same IP + username buckets as /api/auth/login, so this can't be used as an
  // unlimited oracle to sidestep the login lockout.
  if (requestUrl.pathname === '/api/admin/credential/verify' && req.method === 'POST') {
    const rateKey = { ip: getClientIp(req) || 'unknown', username: RESERVED_USERNAME };
    const rate = await guardCredentialAttempt(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      sendJson(res, 429, {
        error: 'Too many failed attempts. Please wait and try again.',
        retryAfterMs: rate.retryAfterMs,
      });
      return true;
    }
    const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
    const storedHash =
      stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';
    const { passwordHash } = await readJsonBody(req);
    const valid = storedHash.length > 0 && (await verifyPassword(storedHash, passwordHash));
    if (valid) {
      await clearCredentialAttempts(rateKey);
    } else {
      await recordCredentialFailure(rateKey);
    }
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
        passwordHash: await derivePasswordHash(passwordHash),
      };
      await setAppSetting(STAFF_USERS_KEY, [...usersList, newUser]);
      sendJson(res, 201, sanitizeStaffUser(newUser));
      return true;
    }
  }

  // Verify a staff (non-admin) login. Returns { valid } and, on success, the
  // sanitized user record so the client can open a session. The hash is compared
  // in constant time and never echoed back. Brute-force throttled on the same
  // IP + username buckets as /api/auth/login (shared lock — an attacker can't
  // dodge the login lockout by hammering this endpoint instead).
  if (requestUrl.pathname === '/api/users/verify' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const username =
      typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const passwordHash = body?.passwordHash;
    const rateKey = { ip: getClientIp(req) || 'unknown', username };
    const rate = await guardCredentialAttempt(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      sendJson(res, 429, {
        error: 'Too many failed attempts. Please wait and try again.',
        retryAfterMs: rate.retryAfterMs,
      });
      return true;
    }
    const usersList = await readStaffUsers();
    const found = isSha256Hex(passwordHash)
      ? await findUserByCredential(usersList, username, passwordHash)
      : undefined;
    if (!found) {
      await recordCredentialFailure(rateKey);
      sendJson(res, 401, { valid: false });
      return true;
    }
    await clearCredentialAttempts(rateKey);
    sendJson(res, 200, { valid: true, user: sanitizeStaffUser(found) });
    return true;
  }

  // Per-user management, keyed by id:
  //   DELETE /api/users/:id           → remove the account.
  //   PUT    /api/users/:id/password  → set a new password ({ passwordHash },
  //          plus { currentPasswordHash } when changing your own account). An
  //          admin may reset a lower-privileged account, but not another admin's
  //          password; self-change requires the current password.
  //   PUT    /api/users/:id/role      → change the account role ({ role }).
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
      // Revoke the removed account's live sessions immediately.
      await deleteSessionsForUser(userId).catch(() => {});
      await revokeCachedUserSessions(userId).catch(() => {});
      sendEmpty(res);
      return true;
    }

    if (action === 'password' && req.method === 'PUT') {
      const { passwordHash, currentPasswordHash } = await readJsonBody(req);
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
      const target = usersList[index];

      // Authorization policy (on top of the admin-only route gate): an admin may
      // RESET a lower-privileged account (operator/viewer) without its current
      // password, but MUST NOT be able to silently change another admin's
      // password — that would let one admin take over another admin's account.
      // Changing your OWN account's password requires proving knowledge of the
      // current one (so a hijacked session / CSRF can't quietly re-key it). The
      // primary `admin` account changes its own password via
      // /api/admin/credential, which already enforces the current-password check.
      const session = await resolveSession(req);
      const isSelf = !!session && session.user_id === userId;
      if (isSelf) {
        const currentOk =
          isSha256Hex(currentPasswordHash) &&
          (await verifyPassword(target.passwordHash || '', currentPasswordHash));
        if (!currentOk) {
          sendJson(res, 403, { error: 'Current password is incorrect.' });
          return true;
        }
      } else if (target.role === 'admin') {
        sendJson(res, 403, {
          error: "You cannot change another administrator's password.",
        });
        return true;
      }

      const nextUsers = [...usersList];
      nextUsers[index] = { ...target, passwordHash: await derivePasswordHash(passwordHash) };
      await setAppSetting(STAFF_USERS_KEY, nextUsers);
      // A password change invalidates the account's existing sessions.
      await deleteSessionsForUser(userId).catch(() => {});
      await revokeCachedUserSessions(userId).catch(() => {});
      sendEmpty(res);
      return true;
    }

    if (action === 'role' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const role = typeof body?.role === 'string' ? body.role : '';
      if (!USER_ROLES.has(role)) {
        sendJson(res, 400, { error: 'role must be admin, operator, or viewer' });
        return true;
      }
      const usersList = await readStaffUsers();
      const index = usersList.findIndex((candidate) => candidate.id === userId);
      if (index === -1) {
        sendJson(res, 404, { error: 'user not found' });
        return true;
      }
      const nextUsers = [...usersList];
      nextUsers[index] = { ...nextUsers[index], role };
      await setAppSetting(STAFF_USERS_KEY, nextUsers);
      // Revoke existing sessions so the new role takes effect on next sign-in
      // rather than letting a stale cookie keep the old privileges.
      await deleteSessionsForUser(userId).catch(() => {});
      await revokeCachedUserSessions(userId).catch(() => {});
      sendJson(res, 200, sanitizeStaffUser(nextUsers[index]));
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
      // The actor is taken from the server session, never from the request body,
      // so an audit entry can't be attributed to someone else. This route is
      // classified 'authed', so a session is guaranteed present here.
      const session = await resolveSession(req);
      await recordAuditLog({
        actorName: session ? session.name : null,
        actorUsername: session ? session.username : null,
        actorRole: session ? session.role : null,
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

  // Home Assistant connection config. Admin-only (isSensitiveRead gates the GET,
  // the /api/settings/ non-GET rule gates the PUT). GET never returns the token —
  // only whether one is stored; PUT with a blank/omitted token keeps the existing
  // one (so the form can round-trip without re-entering it), mirroring the OAuth
  // clientSecret handling above.
  if (requestUrl.pathname === '/api/settings/home-assistant') {
    if (req.method === 'GET') {
      const config = await getHomeAssistantConfig();
      sendJson(res, 200, {
        baseUrl: config.baseUrl,
        enabled: config.enabled,
        hasToken: config.token.length > 0,
      });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const baseUrl = normalizeHaBaseUrl(body?.baseUrl);
      const enabled = body?.enabled === true;
      if (typeof body?.baseUrl !== 'string') {
        sendJson(res, 400, { error: 'baseUrl must be a string' });
        return true;
      }
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        sendJson(res, 400, { error: 'baseUrl must start with http:// or https://' });
        return true;
      }
      const existing = await getHomeAssistantConfig();
      const token =
        typeof body?.token === 'string' && body.token.trim()
          ? body.token.trim()
          : existing.token;
      await setAppSetting(HOME_ASSISTANT_KEY, {
        baseUrl,
        token: token ? encryptSecret(token) : '',
        enabled,
      });
      const saved = await getHomeAssistantConfig();
      sendJson(res, 200, {
        baseUrl: saved.baseUrl,
        enabled: saved.enabled,
        hasToken: saved.token.length > 0,
      });
      return true;
    }
  }

  // Test the Home Assistant connection (admin-only). Hits HA's GET /api/ probe
  // which returns { message: "API running." } for a valid base URL + token.
  if (requestUrl.pathname === '/api/settings/home-assistant/test' && req.method === 'POST') {
    const config = await getHomeAssistantConfig();
    if (!config.baseUrl || !config.token) {
      sendJson(res, 400, { ok: false, error: 'Set the Home Assistant URL and token first.' });
      return true;
    }
    const result = await haFetch(config, '/');
    if (result.ok) {
      sendJson(res, 200, { ok: true, message: 'Connected to Home Assistant.' });
    } else {
      sendJson(res, 200, { ok: false, error: result.error });
    }
    return true;
  }

  // Device list: HA's REST API exposes entities/states (the full device registry
  // needs the WebSocket API). We fetch GET /api/states and return entities with a
  // friendly name, current state, and domain, plus a domain→entities grouping the
  // UI uses to render a device picker. Admin-only.
  if (requestUrl.pathname === '/api/settings/home-assistant/devices' && req.method === 'GET') {
    const config = await getHomeAssistantConfig();
    const result = await haFetch(config, '/states');
    if (!result.ok) {
      sendJson(res, 502, { error: result.error });
      return true;
    }
    const states = Array.isArray(result.data) ? result.data : [];
    const entities = states
      .map((entity) => {
        const entityId = typeof entity?.entity_id === 'string' ? entity.entity_id : '';
        const domain = entityId.includes('.') ? entityId.split('.')[0] : '';
        const attributes = entity && typeof entity.attributes === 'object' ? entity.attributes : {};
        return {
          entityId,
          domain,
          friendlyName: typeof attributes.friendly_name === 'string' ? attributes.friendly_name : entityId,
          state: typeof entity?.state === 'string' ? entity.state : '',
        };
      })
      .filter((entity) => entity.entityId)
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    const groups = {};
    for (const entity of entities) {
      (groups[entity.domain || 'other'] ||= []).push(entity);
    }
    sendJson(res, 200, { entities, groups });
    return true;
  }

  // Automation rules bridge the print farm and Home Assistant in both directions.
  // They are NOT native HA automations (those can't see our printers) — they are
  // print-farm-side rules stored in app_settings and evaluated by the background
  // engine (evaluateHaRules): a `printer_to_ha` rule calls an HA service when a
  // printer reaches a status; a `ha_to_printer` rule sends a printer command when
  // an HA entity reaches a state. All admin-only (sensitive read + settings write).
  if (requestUrl.pathname === '/api/settings/home-assistant/rules') {
    if (req.method === 'GET') {
      sendJson(res, 200, { rules: await getHaRules() });
      return true;
    }
    if (req.method === 'POST') {
      let rule;
      try {
        rule = normalizeHaRuleInput(await readJsonBody(req));
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return true;
      }
      const created = { id: randomUUID(), createdAt: new Date().toISOString(), ...rule };
      await setAppSetting(HA_RULES_KEY, [...(await getHaRules()), created]);
      sendJson(res, 201, created);
      return true;
    }
  }

  const haRuleMatch = requestUrl.pathname.match(
    /^\/api\/settings\/home-assistant\/rules\/([^/]+)$/,
  );
  if (haRuleMatch) {
    const ruleId = haRuleMatch[1];
    const rules = await getHaRules();
    const index = rules.findIndex((rule) => rule.id === ruleId);
    if (index === -1) {
      sendJson(res, 404, { error: 'rule not found' });
      return true;
    }
    if (req.method === 'DELETE') {
      await setAppSetting(HA_RULES_KEY, rules.filter((rule) => rule.id !== ruleId));
      sendEmpty(res);
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      // A bare { enabled } toggle is the common case; a full body re-validates.
      let next;
      if (body && typeof body === 'object' && Object.keys(body).length === 1 && 'enabled' in body) {
        next = { ...rules[index], enabled: body.enabled === true };
      } else {
        try {
          next = { ...rules[index], ...normalizeHaRuleInput(body) };
        } catch (err) {
          sendJson(res, 400, { error: err.message });
          return true;
        }
      }
      const updated = [...rules];
      updated[index] = next;
      await setAppSetting(HA_RULES_KEY, updated);
      sendJson(res, 200, next);
      return true;
    }
  }

  // Website access mode — does an unauthenticated visitor get a read-only viewer
  // session, or is the dashboard login-gated? GET is public (the unauthenticated
  // bootstrap reads it to decide); PUT is admin-gated by isAdminMutation's
  // /api/settings/* rule.
  if (requestUrl.pathname === '/api/settings/public-viewer') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getPublicViewerSetting());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body?.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' });
        return true;
      }
      await setAppSetting(PUBLIC_VIEWER_KEY, { enabled: body.enabled });
      sendJson(res, 200, await getPublicViewerSetting());
      return true;
    }
  }

  // Queue submission window — restricts when the public print-request form
  // (/request) accepts new submissions. GET is public (the unauthenticated
  // /request page reads it); PUT is admin-gated by isAdminMutation's
  // /api/settings/* rule.
  if (requestUrl.pathname === '/api/settings/queue-availability') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getQueueAvailabilitySetting());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (typeof body?.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' });
        return true;
      }
      if (
        !Array.isArray(body.days) ||
        body.days.length === 0 ||
        !body.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ) {
        sendJson(res, 400, { error: 'days must be a non-empty array of integers 0-6' });
        return true;
      }
      if (typeof body.startTime !== 'string' || !timeRe.test(body.startTime)) {
        sendJson(res, 400, { error: 'startTime must be an "HH:MM" string' });
        return true;
      }
      if (typeof body.endTime !== 'string' || !timeRe.test(body.endTime)) {
        sendJson(res, 400, { error: 'endTime must be an "HH:MM" string' });
        return true;
      }
      if (body.endTime <= body.startTime) {
        sendJson(res, 400, { error: 'endTime must be after startTime' });
        return true;
      }
      if (typeof body.timezone !== 'string' || !isValidIanaTimezone(body.timezone)) {
        sendJson(res, 400, { error: 'timezone must be a valid IANA timezone string' });
        return true;
      }
      if (typeof body.closedMessage !== 'string' || body.closedMessage.trim().length === 0) {
        sendJson(res, 400, { error: 'closedMessage must be a non-empty string' });
        return true;
      }
      await setAppSetting(QUEUE_AVAILABILITY_KEY, {
        enabled: body.enabled,
        timezone: body.timezone,
        days: [...new Set(body.days)].sort(),
        startTime: body.startTime,
        endTime: body.endTime,
        closedMessage: body.closedMessage.trim().slice(0, 300),
      });
      sendJson(res, 200, await getQueueAvailabilitySetting());
      return true;
    }
  }

  // Admin override for the site's own public origin (Settings → Sign-in), used as
  // the top-priority tier in resolvePublicOrigin() — see the comment there. Not
  // sensitive (it's the site's own public URL, not a secret): GET is world-readable
  // like /api/settings/integrations; PUT is admin-only via the /api/settings/*
  // catch-all in isAdminMutation.
  if (requestUrl.pathname === '/api/settings/sso-public-url') {
    if (req.method === 'GET') {
      const stored = await getAppSetting(SSO_PUBLIC_URL_KEY);
      sendJson(res, 200, {
        publicUrl: normalizeSsoPublicUrl(stored?.publicUrl),
        envFallback: normalizeSsoPublicUrl(process.env.APP_BASE_URL),
      });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body?.publicUrl !== 'string') {
        sendJson(res, 400, { error: 'publicUrl must be a string' });
        return true;
      }
      const publicUrl = normalizeSsoPublicUrl(body.publicUrl);
      if (publicUrl && !/^https?:\/\//i.test(publicUrl)) {
        sendJson(res, 400, { error: 'publicUrl must start with http:// or https://' });
        return true;
      }
      await setAppSetting(SSO_PUBLIC_URL_KEY, { publicUrl });
      sendJson(res, 200, {
        publicUrl,
        envFallback: normalizeSsoPublicUrl(process.env.APP_BASE_URL),
      });
      return true;
    }
  }

  // Admin override for the LAN address H2-series Bambu printers use to fetch a
  // staged print file back from slicer-proxy (Settings → Slicer Upload) — see
  // PRINTER_CALLBACK_URL_KEY above. Not sensitive: GET is world-readable like
  // /api/settings/sso-public-url; PUT is admin-only via the /api/settings/*
  // catch-all in isAdminMutation. slicer-proxy reads the stored value directly
  // from Postgres (getAppSetting), so no further wiring is needed there.
  if (requestUrl.pathname === '/api/settings/printer-callback-url') {
    if (req.method === 'GET') {
      const stored = await getAppSetting(PRINTER_CALLBACK_URL_KEY);
      sendJson(res, 200, { url: normalizePrinterCallbackUrl(stored?.url) });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body?.url !== 'string') {
        sendJson(res, 400, { error: 'url must be a string' });
        return true;
      }
      const url = normalizePrinterCallbackUrl(body.url);
      if (url && !/^https?:\/\//i.test(url)) {
        sendJson(res, 400, { error: 'url must start with http:// or https://' });
        return true;
      }
      await setAppSetting(PRINTER_CALLBACK_URL_KEY, { url });
      sendJson(res, 200, { url });
      return true;
    }
  }

  // OAuth (SSO) sign-in config, per provider (admin-only in the UI, like the
  // integrations form above). GET never returns the client secret — only whether
  // one is stored; PUT with a blank/omitted clientSecret keeps the existing one so
  // the form can round-trip without re-entering it. `tenant` is Microsoft-only
  // (the Azure directory / tenant id); it is accepted and stored for any provider
  // but ignored where unused.
  const oauthSettingsMatch = requestUrl.pathname.match(
    /^\/api\/settings\/oauth\/(google|microsoft|adfs)$/,
  );
  if (oauthSettingsMatch) {
    const providerName = oauthSettingsMatch[1];
    const provider = OAUTH_PROVIDERS[providerName];
    if (req.method === 'GET') {
      const config = await getOAuthConfig(providerName);
      sendJson(res, 200, {
        enabled: config.enabled,
        clientId: config.clientId,
        tenant: config.tenant,
        authority: config.authority,
        allowedDomains: config.allowedDomains,
        hasClientSecret: config.clientSecret.length > 0,
        displayName: config.displayName,
        redirectUri: config.redirectUri,
      });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const enabled = body?.enabled === true;
      const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
      const tenant = typeof body?.tenant === 'string' ? body.tenant.trim() : '';
      const authority = typeof body?.authority === 'string' ? body.authority.trim() : '';
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
      const redirectUri = typeof body?.redirectUri === 'string' ? body.redirectUri.trim() : '';
      const authorizeEndpoint = typeof body?.authorizeEndpoint === 'string' ? body.authorizeEndpoint.trim() : '';
      const tokenEndpoint = typeof body?.tokenEndpoint === 'string' ? body.tokenEndpoint.trim() : '';
      const logoutEndpoint = typeof body?.logoutEndpoint === 'string' ? body.logoutEndpoint.trim() : '';
      const metadataUrl = typeof body?.metadataUrl === 'string' ? body.metadataUrl.trim() : '';
      const jwksUri = typeof body?.jwksUri === 'string' ? body.jwksUri.trim() : '';
      const relyingPartyId = typeof body?.relyingPartyId === 'string' ? body.relyingPartyId.trim() : '';
      const allowedDomains = Array.isArray(body?.allowedDomains)
        ? body.allowedDomains
            .map((domain) => String(domain || '').trim().toLowerCase().replace(/^@/, ''))
            .filter(Boolean)
        : [];
      const existing = await getOAuthConfig(providerName);
      // Blank/omitted secret on save = keep the stored one (so the form needn't
      // echo it back); a non-empty value replaces it.
      const clientSecret =
        typeof body?.clientSecret === 'string' && body.clientSecret.trim()
          ? body.clientSecret.trim()
          : existing.clientSecret;
      await setAppSetting(provider.settingsKey, {
        enabled,
        clientId,
        clientSecret,
        tenant,
        authority,
        displayName,
        redirectUri,
        authorizeEndpoint,
        tokenEndpoint,
        logoutEndpoint,
        metadataUrl,
        jwksUri,
        relyingPartyId,
        allowedDomains,
      });
      // SSO providers are independent: Google, Microsoft/AD FS, and SAML can each
      // be enabled at the same time, and the login page renders one button per
      // enabled provider. Enabling one no longer disables the others.
      const saved = await getOAuthConfig(providerName);
      sendJson(res, 200, {
        enabled: saved.enabled,
        clientId: saved.clientId,
        tenant: saved.tenant,
        authority: saved.authority,
        allowedDomains: saved.allowedDomains,
        hasClientSecret: saved.clientSecret.length > 0,
        displayName: saved.displayName,
        redirectUri: saved.redirectUri,
        authorizeEndpoint: saved.authorizeEndpoint,
        tokenEndpoint: saved.tokenEndpoint,
        logoutEndpoint: saved.logoutEndpoint,
        metadataUrl: saved.metadataUrl,
        jwksUri: saved.jwksUri,
        relyingPartyId: saved.relyingPartyId,
      });
      return true;
    }
  }

  // SAML 2.0 SSO configuration (Settings → SSO Configuration). GET returns the
  // saved config (the certificate is a public signing cert, so it is returned in
  // full so the form can round-trip). PUT validates URLs and the cert before
  // persisting, stamps updatedAt, and — when enabling SAML — disables any OAuth
  // provider so only one SSO mechanism is active at a time. Admin-only is enforced
  // in the UI (the cookieless frontend /api/* surface, like the OAuth settings
  // routes, has no server-side session to gate on; the key-gated /api/v1 surface
  // is the authenticated path).
  if (requestUrl.pathname === '/api/settings/saml') {
    if (req.method === 'GET') {
      const config = await getSamlConfig();
      const { spEntityId, acsUrl } = await resolveSamlEndpoints(config, req);
      sendJson(res, 200, {
        ...config,
        // Surface the effective SP identifiers so the form can prefill the
        // defaults the metadata endpoint advertises when the fields are blank.
        defaultSpEntityId: await defaultSamlSpEntityId(req),
        defaultAcsUrl: await defaultSamlAcsUrl(req),
        effectiveSpEntityId: spEntityId,
        effectiveAcsUrl: acsUrl,
      });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const enabled = body?.enabled === true;
      const idpEntityId = typeof body?.idpEntityId === 'string' ? body.idpEntityId.trim() : '';
      const idpSsoUrl = typeof body?.idpSsoUrl === 'string' ? body.idpSsoUrl.trim() : '';
      const idpCertificate =
        typeof body?.idpCertificate === 'string' ? body.idpCertificate.trim() : '';
      const spEntityId = typeof body?.spEntityId === 'string' ? body.spEntityId.trim() : '';
      const acsUrl = typeof body?.acsUrl === 'string' ? body.acsUrl.trim() : '';
      const autoProvisionUsers = body?.autoProvisionUsers === true;
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';

      // URL + certificate validation. URLs, when provided, must be absolute
      // http(s); the IdP SSO URL and certificate are required to enable the flow.
      for (const [label, value] of [
        ['IdP SSO URL', idpSsoUrl],
        ['SP entity ID', spEntityId],
        ['ACS URL', acsUrl],
      ]) {
        if (value && !isValidHttpUrl(value)) {
          sendJson(res, 400, { error: `${label} must be a valid http(s) URL` });
          return true;
        }
      }
      if (idpCertificate && !isValidCertificate(idpCertificate)) {
        sendJson(res, 400, { error: 'IdP certificate is not a valid X.509 PEM certificate' });
        return true;
      }
      if (enabled && (!idpSsoUrl || !idpCertificate)) {
        sendJson(res, 400, {
          error: 'An IdP SSO URL and certificate are required to enable SAML SSO',
        });
        return true;
      }

      await setAppSetting(SAML_SETTINGS_KEY, {
        enabled,
        idpEntityId,
        idpSsoUrl,
        idpCertificate,
        spEntityId,
        acsUrl,
        autoProvisionUsers,
        displayName,
        updatedAt: new Date().toISOString(),
      });
      // SSO providers are independent: SAML can be enabled alongside the OAuth
      // providers (Google, Microsoft/AD FS). Enabling SAML no longer disables them.
      await recordAuditLog({
        action: 'settings.saml.update',
        target: 'saml_sso',
        details: { enabled, autoProvisionUsers },
        source: 'web',
        ip: getClientIp(req),
      });
      const saved = await getSamlConfig();
      const endpoints = await resolveSamlEndpoints(saved, req);
      sendJson(res, 200, {
        ...saved,
        defaultSpEntityId: await defaultSamlSpEntityId(req),
        defaultAcsUrl: await defaultSamlAcsUrl(req),
        effectiveSpEntityId: endpoints.spEntityId,
        effectiveAcsUrl: endpoints.acsUrl,
      });
      return true;
    }
  }

  // Test the SAML configuration without committing it: validates the submitted
  // (or stored) values and probes the IdP SSO URL for reachability. Returns a
  // list of checks the UI renders, plus an overall ok flag.
  if (requestUrl.pathname === '/api/settings/saml/test' && req.method === 'POST') {
    const stored = await getSamlConfig();
    const body = await readJsonBody(req).catch(() => ({}));
    const idpSsoUrl =
      typeof body?.idpSsoUrl === 'string' && body.idpSsoUrl.trim()
        ? body.idpSsoUrl.trim()
        : stored.idpSsoUrl;
    const idpCertificate =
      typeof body?.idpCertificate === 'string' && body.idpCertificate.trim()
        ? body.idpCertificate.trim()
        : stored.idpCertificate;

    const checks = [];
    const urlOk = isValidHttpUrl(idpSsoUrl);
    checks.push({
      label: 'IdP SSO URL is a valid http(s) URL',
      ok: urlOk,
    });
    checks.push({
      label: 'IdP certificate is a valid X.509 certificate',
      ok: isValidCertificate(idpCertificate),
    });

    if (urlOk) {
      // Probe the IdP endpoint. Many IdP SSO endpoints reject a bare GET (they
      // expect a SAMLRequest), so any HTTP response — even 4xx — proves it is
      // reachable; only a network/timeout failure counts as unreachable.
      let reachable = false;
      let detail = '';
      try {
        // H-3: refuse to probe a URL that resolves to a private/reserved address
        // (loopback, LAN, cloud metadata) so this admin diagnostic can't be used
        // as an SSRF primitive.
        await assertPublicHttpTarget(idpSsoUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const probe = await fetch(idpSsoUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          });
          reachable = true;
          detail = `HTTP ${probe.status}`;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : 'unreachable';
      }
      checks.push({
        label: 'IdP SSO URL is reachable',
        ok: reachable,
        detail,
      });
    }

    sendJson(res, 200, { ok: checks.every((check) => check.ok), checks });
    return true;
  }

  // Customizable site branding (logo + optional full-page background). GET is
  // public (the Login/Navigation logo must render before auth); PUT (admin-only
  // in the UI) stores uploaded images as data URLs, or clears either to fall back
  // to the bundled default logo / built-in theme background.
  if (requestUrl.pathname === '/api/settings/branding') {
    if (req.method === 'GET') {
      sendJson(res, 200, await getBranding());
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req, MAX_BRANDING_BODY_BYTES);
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

      // Optional full-page website background. An empty string falls back to the
      // built-in theme background.
      const backgroundRaw = body?.backgroundDataUrl;
      if (backgroundRaw !== undefined && typeof backgroundRaw !== 'string') {
        sendJson(res, 400, { error: 'backgroundDataUrl must be a string' });
        return true;
      }
      const backgroundDataUrl = typeof backgroundRaw === 'string' ? backgroundRaw.trim() : '';
      if (backgroundDataUrl && !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(backgroundDataUrl)) {
        sendJson(res, 400, {
          error: 'backgroundDataUrl must be an empty string or a base64 image data URL',
        });
        return true;
      }
      if (Buffer.byteLength(backgroundDataUrl, 'utf8') > MAX_BACKGROUND_DATA_URL_BYTES) {
        sendJson(res, 413, { error: 'Background image is too large (max ~3 MB).' });
        return true;
      }

      const logoScale = clampLogoScale(body?.logoScale ?? 1);

      // Optional site name (browser tab + dashboard heading). Empty falls back
      // to the bundled default name.
      const siteNameRaw = body?.siteName;
      if (siteNameRaw !== undefined && typeof siteNameRaw !== 'string') {
        sendJson(res, 400, { error: 'siteName must be a string' });
        return true;
      }
      const siteName =
        typeof siteNameRaw === 'string' ? siteNameRaw.trim().slice(0, MAX_SITE_NAME_LENGTH) : '';

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

      // Optional favicon. An empty string falls back to the bundled default icon.
      const faviconRaw = body?.faviconDataUrl;
      if (faviconRaw !== undefined && typeof faviconRaw !== 'string') {
        sendJson(res, 400, { error: 'faviconDataUrl must be a string' });
        return true;
      }
      const faviconDataUrl = typeof faviconRaw === 'string' ? faviconRaw.trim() : '';
      if (faviconDataUrl && !/^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/.test(faviconDataUrl)) {
        sendJson(res, 400, {
          error: 'faviconDataUrl must be an empty string or a base64 image data URL',
        });
        return true;
      }
      if (Buffer.byteLength(faviconDataUrl, 'utf8') > MAX_FAVICON_DATA_URL_BYTES) {
        sendJson(res, 413, { error: 'Favicon image is too large (max ~256 KB).' });
        return true;
      }

      await setAppSetting(BRANDING_KEY, { siteName, logoDataUrl: trimmed, logoSvg, logoAdaptive, logoScale, backgroundDataUrl, faviconDataUrl });
      sendJson(res, 200, await getBranding());
      return true;
    }
  }

  // Serves the custom favicon as a raw image so the PWA manifest can reference
  // it as a URL. Returns 404 when no custom favicon is configured.
  if (requestUrl.pathname === '/api/settings/favicon' && req.method === 'GET') {
    const { faviconDataUrl } = await getBranding();
    if (!faviconDataUrl) {
      sendJson(res, 404, { error: 'No custom favicon configured' });
      return true;
    }
    const match = /^data:(image\/[^;]+);base64,(.*)$/.exec(faviconDataUrl);
    if (!match) {
      sendJson(res, 500, { error: 'Stored favicon is malformed' });
      return true;
    }
    const mimeType = match[1];
    const imageBytes = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(imageBytes);
    return true;
  }

  return false;
}

async function handlePrinterProxy(req, res, requestUrl, prefix, makeTargetUrl, extraHeaders = {}) {
  if (!requestUrl.pathname.startsWith(prefix)) {
    return false;
  }

  // C-1 FIX: the printer-control proxy (/__printer_proxy/) is a raw passthrough
  // to the printer hardware API (Moonraker for Snapmaker), which executes
  // gcode/pause/resume/cancel — including via GET (`/printer/gcode/script?script=`).
  // It is dispatched outside the /api/ auth gate, so without this check any
  // anonymous caller reaching the site could drive every printer. Require an
  // operator/admin session here, matching the RBAC on /api/printers/:id/command.
  // The webcam prefix (/__printer_webcam/) is a read-only camera feed embedded in
  // the dashboard (and used in public viewer mode), so it stays unauthenticated.
  if (prefix === '/__printer_proxy/') {
    const isControlGet = req.method === 'GET' && (
      requestUrl.pathname.includes('/gcode') ||
      requestUrl.pathname.includes('/print/') ||
      requestUrl.pathname.includes('/system/')
    );
    if (req.method !== 'GET' && req.method !== 'HEAD' || isControlGet) {
      const session = await resolveSession(req);
      if (!session) {
        sendJson(res, 401, { error: 'Authentication required.' });
        return true;
      }
      if (!isPrivilegedRole(sessionRole(session))) {
        sendJson(res, 403, { error: 'Operator access required.' });
        return true;
      }
    }
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

  // Bambu's chamber camera isn't an HTTP endpoint — capture it over its TLS
  // socket/RTSP hub. The Snapmaker U1 only needs this handler for its new
  // AV1 stream.mp4 path (best effort); every other U1 webcam path (player,
  // snapshot.jpg, legacy stream.mjpg) stays on the generic reverse-proxy
  // fall-through below, untouched.
  if (
    prefix === '/__printer_webcam/' &&
    (BAMBU_PROFILES.has(printer.profile) ||
      (printer.profile === 'snapmaker_u1' && pathParts[0] === 'stream.mp4'))
  ) {
    await handleCameraHubWebcam(req, res, printer, pathParts);
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
    // The proxied camera player ships an inline script + a jmuxer CDN reference
    // the strict app CSP would block, killing the live view. Swap in the
    // webcam-scoped policy (and drop any report-only variant) so it can run.
    res.setHeader('Content-Security-Policy', WEBCAM_CSP);
    res.removeHeader('Content-Security-Policy-Report-Only');
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

// The installable PWA's name comes from the web manifest's `name`/`short_name`.
// Those must follow the admin-configured branding `siteName` — the same name
// shown in the browser tab and dashboard heading — rather than a baked-in
// string, so the home-screen icon a user downloads matches what's configured.
// We serve the manifest dynamically: read the built template from dist (to keep
// its icons/colors/start_url) and override the names with the configured
// siteName, falling back to the template's own names when branding is unset.
// Served no-cache so a rename propagates on the next install/refresh.
const MANIFEST_PATH = path.join(distDir, 'manifest.webmanifest');

async function serveManifest(req, res) {
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    logger.warn('manifest read failed', error);
  }

  try {
    const branding = await getBranding();
    if (branding.siteName.trim()) {
      manifest.name = branding.siteName.trim();
      manifest.short_name = branding.siteName.trim();
    }
    if (branding.faviconDataUrl) {
      const mimeMatch = /^data:(image\/[^;]+);base64,/.exec(branding.faviconDataUrl);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
      const isSvg = mimeType === 'image/svg+xml';
      // Chrome on Android requires at least one PNG icon with an explicit pixel
      // size (≥192×192) to show the install prompt. SVG-only manifests are
      // silently skipped. For raster uploads declare the favicon at both sizes
      // Chrome needs; it scales the actual image. For SVG uploads, keep the
      // static PNG fallbacks so the install prompt still appears.
      manifest.icons = isSvg
        ? [
            { src: '/api/settings/favicon', sizes: 'any', type: mimeType, purpose: 'any' },
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ]
        : [
            { src: '/api/settings/favicon', sizes: '192x192', type: mimeType, purpose: 'any' },
            { src: '/api/settings/favicon', sizes: '512x512', type: mimeType, purpose: 'any' },
            { src: '/api/settings/favicon', sizes: '512x512', type: mimeType, purpose: 'maskable' },
          ];
    }
  } catch (error) {
    logger.warn('manifest branding read failed', error);
  }

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify(manifest));
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

// Readiness probe backing /readyz. Unlike /healthz (a cheap, dependency-free
// liveness signal), this reports whether the process can actually serve traffic:
// the database must be reachable. Redis is optional — when configured it is
// reported, but a Redis outage is "degraded", not "not ready", because the app
// falls back to Postgres/in-memory. Returns { ok, status, checks }.
async function checkReadiness() {
  const checks = {};
  let ok = true;

  try {
    await pingDatabase();
    checks.database = 'ok';
  } catch (error) {
    checks.database = 'error';
    ok = false;
    logger.warn('readiness: database check failed', error);
  }

  if (isRedisEnabled()) {
    checks.redis = (await redisPing()) ? 'ok' : 'degraded';
  }

  return { ok, status: ok ? 'ready' : 'unavailable', checks };
}

// Access logging. To stay useful at scale (constant frontend polling + scrapes
// would drown an info-per-request log), the default samples: every 4xx/5xx is
// logged, but successful reads are not. LOG_HTTP=all logs every request;
// LOG_HTTP=off disables access logging entirely. Probe/scrape endpoints are
// always skipped from the sampled log.
const LOG_HTTP_MODE = (process.env.LOG_HTTP || 'sample').toLowerCase();
const QUIET_ROUTES = new Set(['healthz', 'readyz', 'metrics', 'version']);

function logHttp(req, res, route, durationMs, requestId) {
  if (LOG_HTTP_MODE === 'off') {
    return;
  }
  const status = res.statusCode;
  const fields = {
    method: req.method,
    route,
    status,
    durationMs: Math.round(durationMs),
    reqId: requestId,
  };
  if (status >= 500) {
    logger.error('http request', fields);
    return;
  }
  if (status >= 400) {
    logger.warn('http request', fields);
    return;
  }
  if (LOG_HTTP_MODE === 'all' && !QUIET_ROUTES.has(route)) {
    logger.info('http request', fields);
  }
}

async function handleRequest(req, res) {
  setSecurityHeaders(req, res);

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = classifyRoute(requestUrl.pathname);

  // Per-request instrumentation: a short request id (echoed back so it can be
  // correlated across logs and a client report), and timing/metrics recorded
  // once the response finishes. recordRequestStart/End bracket the in-flight
  // gauge; the listener fires for every response path including early returns.
  const requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 64);
  res.setHeader('X-Request-Id', requestId);
  const startedAt = process.hrtime.bigint();
  recordRequestStart();

  // Inbound bytes: intercept req's own 'data' emissions rather than adding our
  // own listener. Adding a listener would switch the stream into flowing mode
  // immediately, which — if it happens before downstream body parsing (busboy
  // for uploads, a JSON body reader) attaches its listener — can drop chunks
  // before the real consumer ever sees them. Wrapping emit only *observes*
  // bytes as they flow past whatever the real consumer triggers, so this is
  // exact (actual bytes read) with zero risk of interfering with parsing.
  const originalReqEmit = req.emit.bind(req);
  req.emit = (event, ...rest) => {
    if (event === 'data' && rest[0]) {
      recordRequestBytes(route, Buffer.byteLength(rest[0]));
    }
    return originalReqEmit(event, ...rest);
  };

  // Tally response bytes per chunk (not just once at the end) so a long-lived
  // stream — the webcam MJPEG feed above all — shows up in the network-usage
  // page in near-real time rather than only once the connection closes.
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk) {
      recordResponseBytes(route, Buffer.byteLength(chunk, typeof rest[0] === 'string' ? rest[0] : 'utf8'));
    }
    return originalWrite(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk) {
      recordResponseBytes(route, Buffer.byteLength(chunk, typeof rest[0] === 'string' ? rest[0] : 'utf8'));
    }
    return originalEnd(chunk, ...rest);
  };
  // Settle exactly once, on whichever ends the response first: 'finish' (body
  // fully flushed) or 'close' (connection torn down — the only one that fires
  // for some proxied Connection: close responses, and for client aborts). The
  // guard keeps the in-flight gauge balanced and avoids double-counting.
  let settled = false;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    recordRequestEnd(req.method, res.statusCode, route, durationMs);
    logHttp(req, res, route, durationMs, requestId);
  };
  res.on('finish', settle);
  res.on('close', settle);

  if (requestUrl.pathname === '/healthz') {
    // Liveness probe: keep this cheap and DB-independent so a brief database
    // blip never cascades into web containers being killed and restarted.
    sendJson(res, 200, { ok: true }, 'no-store');
    return;
  }

  if (requestUrl.pathname === '/readyz') {
    // Readiness probe: reports dependency health (DB required, Redis optional).
    // 503 when the database is unreachable so a load balancer can route away.
    const readiness = await checkReadiness();
    sendJson(res, readiness.ok ? 200 : 503, readiness, 'no-store');
    return;
  }

  if (requestUrl.pathname === '/metrics') {
    // Prometheus scrape of the web tier's own request metrics. Intentionally
    // internal — nginx returns 404 for /metrics; Prometheus scrapes web:5173
    // directly over the compose network. Carries no secrets.
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderMetrics());
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

    if (requestUrl.pathname === '/manifest.webmanifest') {
      await serveManifest(req, res);
      return;
    }

    await serveStatic(req, res, requestUrl);
  } catch (error) {
    logger.error('unhandled request error', { route, reqId: requestId, err: error });
    if (!res.headersSent) {
      // M-7 FIX: the full error string can carry internal detail (a printer's
      // LAN IP/port/hostname from a failed proxy fetch, DB DSN fragments, etc.).
      // Log it server-side (above) but return only a generic message to the
      // client. The body-too-large case is a known, safe, actionable 413.
      if (error && error.message === 'Request body is too large') {
        sendJson(res, 413, { error: 'Request body is too large' });
      } else {
        sendJson(res, 500, { error: 'Internal server error', requestId });
      }
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

  const indexHtml = await readFile(path.join(distDir, 'index.html'));
  BUILD_ID = createHash('sha256').update(indexHtml).digest('hex').slice(0, 16);
}

await assertProductionInputs();

// Ensure the schema proactively, but do not block startup on the database:
// the SPA must still be served (and the liveness probe stay green) if the
// database is briefly unavailable. Query paths also call ensureSchema lazily.
ensureSchema()
  .then(() =>
    // Encrypt any printer secrets still stored in plaintext now that a key is set
    // (no-op when PRINTER_SECRET_KEY is unset or every row is already encrypted).
    encryptPlaintextPrinterSecrets().then((count) => {
      if (count > 0) {
        logger.info('encrypted plaintext printer secrets at rest', { count });
      }
    }),
  )
  .catch((error) => {
    logger.error('initial schema setup failed; will retry on first database request', error);
  });

// Periodically sweep expired login sessions so the table doesn't accumulate dead
// rows (getSession already ignores expired rows, so this is pure housekeeping).
setInterval(() => {
  deleteExpiredSessions().catch((error) => {
    logger.error('expired-session sweep failed', error);
  });
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Network-usage flush worker
// ---------------------------------------------------------------------------
// metrics.js keeps cumulative-since-process-start byte/request counters per
// route in memory (cheap, but lost on restart). This worker periodically
// diffs those against the last-seen snapshot and persists just the delta into
// network_usage_daily, so the Network Usage page has history that survives a
// restart/redeploy. Diffing (rather than writing the running total) also
// means a stale/duplicate flush is harmless — it just adds zero.
const lastFlushedBytesOutByRoute = new Map();
const lastFlushedBytesInByRoute = new Map();
const lastFlushedRequestsByRoute = new Map();

// A counter smaller than what was last flushed means the process restarted
// (metrics.js resets to 0) — treat the current value as the whole delta
// rather than going negative.
function deltaSince(current, previous) {
  return current >= previous ? current - previous : current;
}

async function flushNetworkUsagePass() {
  const bytesOutNow = snapshotBytesByRoute();
  const bytesInNow = snapshotBytesInByRoute();
  const requestsNow = snapshotRequestsByRoute();
  const routes = new Set([
    ...Object.keys(bytesOutNow),
    ...Object.keys(bytesInNow),
    ...Object.keys(requestsNow),
  ]);

  const deltas = [];
  for (const route of routes) {
    const bytesOut = bytesOutNow[route] || 0;
    const bytesIn = bytesInNow[route] || 0;
    const requests = requestsNow[route] || 0;
    const deltaBytesOut = deltaSince(bytesOut, lastFlushedBytesOutByRoute.get(route) || 0);
    const deltaBytesIn = deltaSince(bytesIn, lastFlushedBytesInByRoute.get(route) || 0);
    const deltaRequests = deltaSince(requests, lastFlushedRequestsByRoute.get(route) || 0);
    lastFlushedBytesOutByRoute.set(route, bytesOut);
    lastFlushedBytesInByRoute.set(route, bytesIn);
    lastFlushedRequestsByRoute.set(route, requests);
    if (deltaBytesOut > 0 || deltaBytesIn > 0 || deltaRequests > 0) {
      deltas.push({ route, bytesOut: deltaBytesOut, bytesIn: deltaBytesIn, requests: deltaRequests });
    }
  }

  if (deltas.length > 0) {
    await upsertNetworkUsageDaily(deltas);
  }
}

const NETWORK_USAGE_FLUSH_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  flushNetworkUsagePass().catch((error) => {
    logger.error('network usage flush failed', error);
  });
}, NETWORK_USAGE_FLUSH_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Preventive-maintenance background worker
// ---------------------------------------------------------------------------
// Runs fleet-wide every MAINTENANCE_WORKER_INTERVAL_MS (default 5 min). The poller
// is the primary path for hour accrual + event creation (it sees job transitions);
// this worker is the single, un-sharded place that recomputes health scores and
// acts as a defensive backstop: it backfills schedules for pre-existing printers,
// creates any pending event the poller might have missed, and raises in-app
// notifications. Everything is idempotent (partial unique indexes), so re-running
// every 5 minutes never duplicates work.
const MAINTENANCE_WORKER_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.MAINTENANCE_WORKER_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 10000 ? raw : 5 * 60 * 1000;
})();

function maintenanceOverdueGrace(intervalHours) {
  return Math.max((Number(intervalHours) || 0) * 0.1, 10);
}

// Create the notification row and, if one was actually inserted (the partial
// unique index de-dupes a still-open condition to DO NOTHING), push it to any
// connected staff tab immediately — the existing GET /api/maintenance/notifications
// poll (now much less frequent, see MaintenanceNotifier.tsx) remains the backstop
// for a tab that was disconnected when this fired.
async function createAndBroadcastMaintenanceNotification({ printerId, kind, title, body }) {
  const created = await createMaintenanceNotification({ printerId, kind, title, body });
  if (created) {
    broadcastMaintenanceNotification({
      id: created.id,
      printerId,
      kind,
      title,
      body,
      read: false,
      createdAt: new Date().toISOString(),
    });
  }
}

// Pushes the current "any printer needs maintenance?" state to privileged
// tabs. Called after a task is completed (can turn the dot off) and at the
// end of a worker pass (can turn it on from newly-created pending tasks).
async function broadcastMaintenanceStatusUpdate() {
  try {
    const summary = await getMaintenanceSummary();
    broadcastMaintenanceStatus({ hasPending: summary.printersRequiringMaintenance > 0 });
  } catch (error) {
    logger.error('failed to broadcast maintenance status', error);
  }
}

async function runMaintenanceWorkerPass() {
  // Seed schedules for any printer that predates this feature (set-based, cheap).
  await backfillAllMaintenanceSchedules();

  const { printers, schedules, pending, completedCounts } = await getMaintenanceWorkerData();

  // Index the bulk reads by printer for an O(1) join in JS.
  const schedulesByPrinter = new Map();
  for (const s of schedules) {
    if (!schedulesByPrinter.has(s.printerId)) schedulesByPrinter.set(s.printerId, []);
    schedulesByPrinter.get(s.printerId).push(s);
  }
  const pendingByPrinter = new Map();
  for (const e of pending) {
    if (!pendingByPrinter.has(e.printerId)) pendingByPrinter.set(e.printerId, []);
    pendingByPrinter.get(e.printerId).push(e);
  }
  const completedKey = (printerId, type, interval) => `${printerId}|${type}|${interval}`;
  const completedMap = new Map();
  for (const c of completedCounts) {
    completedMap.set(completedKey(c.printerId, c.maintenanceType, c.intervalHours), Number(c.count) || 0);
  }

  const healthUpdates = [];

  for (const printer of printers) {
    const totalHours = Number(printer.totalPrintHours) || 0;
    const printerSchedules = schedulesByPrinter.get(printer.id) || [];
    const pendingList = (pendingByPrinter.get(printer.id) || []).slice();
    const pendingSet = new Set(pendingList.map((e) => `${e.maintenanceType}|${e.intervalHours}`));

    // Backstop: create any pending event the printer is due for but doesn't have.
    for (const s of printerSchedules) {
      const interval = Number(s.intervalHours) || 0;
      if (interval <= 0) continue;
      const servicesExpected = Math.floor(totalHours / interval);
      if (servicesExpected < 1) continue;
      const servicesDone = completedMap.get(completedKey(printer.id, s.maintenanceType, interval)) || 0;
      if (servicesExpected > servicesDone && !pendingSet.has(`${s.maintenanceType}|${interval}`)) {
        const triggeredAtHours = (servicesDone + 1) * interval;
        const created = await createPendingMaintenanceEvent({
          printerId: printer.id,
          maintenanceType: s.maintenanceType,
          intervalHours: interval,
          triggeredAtHours,
        });
        if (created) {
          pendingList.push({ maintenanceType: s.maintenanceType, intervalHours: interval, triggeredAtHours });
          pendingSet.add(`${s.maintenanceType}|${interval}`);
        }
      }
    }

    // Classify pending tasks as due / overdue from current hours.
    const overduePending = pendingList.filter(
      (e) => totalHours >= (Number(e.triggeredAtHours) || 0) + maintenanceOverdueGrace(e.intervalHours),
    );
    const lubricationOverdue = overduePending.some((e) => /lubric/i.test(e.maintenanceType));
    const nozzleOverdue = (Number(printer.currentNozzleHours) || 0) > 1000;
    const anyTaskOverdue = overduePending.length > 0;
    const highFailureRate = 100 - (Number(printer.successRate) || 0) > 10;
    const score = recalcHealthScore({ lubricationOverdue, nozzleOverdue, anyTaskOverdue, highFailureRate });

    const previousScore = Number(printer.healthScore);
    if (score !== previousScore) {
      healthUpdates.push({ id: printer.id, healthScore: score });
    }

    // Notify once per task, not once per worker pass. Each pending event carries the
    // notification kind we last raised for it (notifiedKind); we only alert when a
    // task first comes due (null → 'due') and once more if it escalates to overdue
    // ('due'/null → 'overdue'). Servicing the task completes the row; its next
    // routine is a fresh event with notifiedKind = null, so it alerts again.
    const overdueToNotify = [];
    const dueToNotify = [];
    for (const e of pendingList) {
      const overdue = totalHours >= (Number(e.triggeredAtHours) || 0) + maintenanceOverdueGrace(e.intervalHours);
      if (overdue) {
        if (e.notifiedKind !== 'overdue') overdueToNotify.push(e);
      } else if (!e.notifiedKind) {
        dueToNotify.push(e);
      }
    }
    if (overdueToNotify.length > 0) {
      await createAndBroadcastMaintenanceNotification({
        printerId: printer.id,
        kind: 'overdue',
        title: `${printer.name}: maintenance overdue`,
        body: overdueToNotify.map((e) => e.maintenanceType).join(', '),
      });
      await markMaintenanceEventsNotified(overdueToNotify.map((e) => e.id), 'overdue');
    }
    if (dueToNotify.length > 0) {
      await createAndBroadcastMaintenanceNotification({
        printerId: printer.id,
        kind: 'due',
        title: `${printer.name}: maintenance due`,
        body: dueToNotify.map((e) => e.maintenanceType).join(', '),
      });
      await markMaintenanceEventsNotified(dueToNotify.map((e) => e.id), 'due');
    }
    // Health alerts fire once per low-health episode: only on the transition below 70
    // (previous score was healthy), not every pass while it stays low. It re-alerts
    // after recovering to >= 70 and dropping again.
    if (score < 70 && (!Number.isFinite(previousScore) || previousScore >= 70)) {
      await createAndBroadcastMaintenanceNotification({
        printerId: printer.id,
        kind: 'health',
        title: `${printer.name}: health ${score} (${healthStatusFromScore(score)})`,
        body: 'Printer health has dropped below 70.',
      });
    }
  }

  await bulkUpdateHealthScores(healthUpdates);
  broadcastMaintenanceStatusUpdate();
}

let maintenanceWorkerRunning = false;
function scheduleMaintenanceWorker() {
  setInterval(() => {
    if (maintenanceWorkerRunning) return; // never overlap passes
    maintenanceWorkerRunning = true;
    runMaintenanceWorkerPass()
      .catch((error) => logger.error('maintenance worker pass failed', error))
      .finally(() => {
        maintenanceWorkerRunning = false;
      });
  }, MAINTENANCE_WORKER_INTERVAL_MS).unref();
}
scheduleMaintenanceWorker();

// ---------------------------------------------------------------------------
// Filament Station deferred-assignment replay worker (plan §4, actuation half)
// ---------------------------------------------------------------------------
// The Go poller (go-services/cmd/poller/assignments.go) detects a
// pending_config assignment's slot transitioning from empty to loaded and
// sets needs_trigger_at — it never publishes MQTT itself (its Bambu client is
// subscribe-only, see bambu.go). This worker is the actuation half: it owns
// the same ephemeral-MQTT-publish path as the /command endpoint
// (server/bambuCommands.js), so it's the one place in the stack that pushes
// the §2a ams_filament_setting override. Short interval (default 5s, vs the
// maintenance worker's 5 minutes) since "spool physically inserted" is a
// user-facing, latency-sensitive moment — mirrors Bambuddy's "SpoolBuddy
// pre-config replay" (bambuddy/backend/app/main.py:1231-1281).
const FILAMENT_REPLAY_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.FILAMENT_REPLAY_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 5000;
})();

async function runFilamentAssignmentReplayPass() {
  const pending = await listAssignmentsNeedingTrigger();
  for (const assignment of pending) {
    const printer = await getPrinterById(assignment.printerId).catch(() => null);
    if (!printer || !BAMBU_PROFILES.has(printer.profile)) {
      // Not (or no longer) a Bambu printer — nothing safe to actuate yet
      // (Snapmaker's gcode fallback isn't wired in until its macros are
      // verified against real firmware, plan §3b/§8). Clear the trigger so
      // it doesn't spin forever; the assignment itself is left in place.
      await recordAssignmentTriggerResult(assignment.id, {
        success: false,
        message: 'No printer or non-Bambu profile — nothing to actuate',
      });
      continue;
    }

    const globalTrayId = assignment.amsId === 255 ? 254 : assignment.amsId * 4 + assignment.trayId;
    try {
      await sendBambuCommand(printer, 'set_filament', {
        trayId: globalTrayId,
        type: assignment.spoolMaterial,
        color: assignment.spoolRgba,
        vendor: assignment.spoolBrand,
      });
      await recordAssignmentTriggerResult(assignment.id, { success: true });
      broadcastFilamentStationEvent('filament-station-assignment-triggered', {
        assignmentId: assignment.id,
        printerId: assignment.printerId,
        spoolId: assignment.spoolId,
        success: true,
      });
    } catch (error) {
      logger.warn(`Filament assignment replay failed for printer ${printer.id}: ${error.message}`);
      await recordAssignmentTriggerResult(assignment.id, { success: false, message: error.message });
      broadcastFilamentStationEvent('filament-station-assignment-triggered', {
        assignmentId: assignment.id,
        printerId: assignment.printerId,
        spoolId: assignment.spoolId,
        success: false,
        message: error.message,
      });
    }
  }
}

let filamentReplayWorkerRunning = false;
function scheduleFilamentAssignmentReplayWorker() {
  setInterval(() => {
    if (filamentReplayWorkerRunning) return; // never overlap passes
    filamentReplayWorkerRunning = true;
    runFilamentAssignmentReplayPass()
      .catch((error) => logger.error('filament assignment replay pass failed', error))
      .finally(() => {
        filamentReplayWorkerRunning = false;
      });
  }, FILAMENT_REPLAY_INTERVAL_MS).unref();
}
scheduleFilamentAssignmentReplayWorker();

createServer(handleRequest).listen(port, host, () => {
  logger.info('Print Farm server listening', { host, port });
  // Evaluate Home Assistant ⇄ printer automation rules on a background interval.
  startHaAutomationEngine();
});
