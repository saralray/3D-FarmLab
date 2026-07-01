import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mqtt from 'mqtt';
import busboy from 'busboy';
import { decryptSecret, encryptSecret } from './secretCrypto.js';
import {
  approveManagerRequest,
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
  readQueueJobFileChunk,
  importQueueJobs,
  insertQueueSubmission,
  pingDatabase,
  setQueueJobFile,
  listDailyAnalytics,
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
} from './postgres.js';
import { verifySlicerGrant } from './slicerGrant.js';
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
  recordRequestEnd,
  recordRequestStart,
  renderMetrics,
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
} from './bambuCamera.js';

// Bambu Lab printers share one LAN integration (MQTT status/commands, port-6000
// camera), so they're grouped rather than matched by a single model id.
const BAMBU_PROFILES = new Set(['bambulab_a1_mini', 'bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

// The H2 series (like the X1) exposes its camera as an RTSP-over-TLS stream on
// port 322 (LIVE555 server, digest auth) — a different protocol from the A1/P1
// port-6000 length-prefixed JPEG socket — so its snapshots are grabbed via
// ffmpeg instead of captureBambuSnapshot.
const BAMBU_RTSP_PROFILES = new Set(['bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

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

// Best-effort client IP for the audit trail: prefer the first hop in
// X-Forwarded-For (nginx sets it) and fall back to the socket address.
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
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

// Login throttle (per client IP). Backed by Redis when REDIS_URL is set — a single
// shared counter so the limit holds across multiple web instances — and by this
// in-memory Map otherwise (or whenever Redis is unreachable). Both signals are
// consulted on check so a Redis outage mid-window can't silently reset a client's
// failure count; failures are recorded to whichever backend is live.
const LOGIN_ATTEMPTS = new Map();
const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_SECONDS = Math.floor(LOGIN_WINDOW_MS / 1000);
const loginAttemptKey = (key) => `loginfail:${key}`;

function checkLoginRateMemory(key, now = Date.now()) {
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry || now >= entry.resetAt) {
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_FAILURES) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  return { allowed: true };
}

function recordLoginFailureMemory(key, now = Date.now()) {
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry || now >= entry.resetAt) {
    LOGIN_ATTEMPTS.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

async function checkLoginRate(key) {
  if (isRedisEnabled()) {
    const raw = await redisGet(loginAttemptKey(key));
    if (raw !== null && Number(raw) >= LOGIN_MAX_FAILURES) {
      const ttl = await redisTtl(loginAttemptKey(key));
      return { allowed: false, retryAfterMs: (ttl ?? LOGIN_WINDOW_SECONDS) * 1000 };
    }
  }
  // Always honor the in-memory signal too (covers Redis-down windows).
  return checkLoginRateMemory(key);
}

async function recordLoginFailure(key) {
  if (isRedisEnabled()) {
    const count = await redisIncrWithTtl(loginAttemptKey(key), LOGIN_WINDOW_SECONDS);
    if (count !== null) {
      return; // recorded in Redis (the shared counter)
    }
  }
  recordLoginFailureMemory(key); // Redis disabled or unreachable → in-memory
}

async function clearLoginAttempts(key) {
  if (isRedisEnabled()) {
    await redisDel(loginAttemptKey(key));
  }
  LOGIN_ATTEMPTS.delete(key);
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
  if (pathname.startsWith('/api/notifications/')) return true;
  if (pathname === '/api/settings/saml' || pathname === '/api/settings/saml/test') return true;
  if (pathname.startsWith('/api/settings/') && method !== 'GET') return true;
  if (pathname === '/api/analytics/daily/reset') return true;
  if (pathname === '/api/queue/reset') return true;
  if (pathname.startsWith('/api/queue/') && method === 'DELETE') return true;
  if (pathname.startsWith('/api/printers/') && method === 'DELETE') return true;
  if (pathname.startsWith('/api/manager/requests/') && !pathname.endsWith('/status')) return true;
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
  if (pathname.startsWith('/api/maintenance/') && pathname.endsWith('/complete') && method === 'POST') return true;
  if (pathname === '/api/maintenance/notifications/read' && method === 'POST') return true;
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
    return isSensitiveRead(pathname) ? 'admin' : 'public';
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
  bambulab_h2c: ['chamber_light', 'chamber_light2'],
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
    // Optional brand/vendor label. Bambu stores it as the tray's filament setting
    // name (`tray_id_name`) and reports it back, so the card's vendor round-trips.
    // Kept short and free of control chars; empty string leaves it unset.
    const vendor = String(params.vendor || '')
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
      .slice(0, 32);
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
        tray_id_name: vendor,
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
    const { command, heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode } =
      await readJsonBody(req);
    await sendBambuCommand(printer, command, {
      heater, target, nozzleIndex, gcode, trayId, fanPort, speed, modeId, submode,
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

  if (await handleDataApi(req, res, requestUrl)) {
    return true;
  }

  // Server-side authorization gate. Runs before any frontend /api/* route so an
  // unauthenticated or under-privileged caller can no longer drive mutations the
  // React UI merely hides. Denied requests are answered here (401/403).
  if (!(await authorizeFrontendApi(req, res, requestUrl))) {
    return true;
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
      sendJson(res, 200, await overlayLiveTelemetryAll(printers));
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

  // Read path: cheap DB read of the stored queue.
  if (requestUrl.pathname === '/api/queue') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listQueueData());
      return true;
    }
  }

  // In-app print-request form. Public (no auth, like the rest of the frontend
  // /api/* surface): a student fills out /request and the model file is stored
  // directly in Postgres. Replaces the old Google Form → Sheet → CSV sync.
  if (requestUrl.pathname === '/api/queue/submit' && req.method === 'POST') {
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
    const submitterName = [firstName, lastName].filter(Boolean).join(' ').trim() || studentId;

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
    const rateKey = getClientIp(req) || 'unknown';
    const rate = await checkLoginRate(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      sendJson(res, 429, {
        error: 'Too many failed attempts. Please wait and try again.',
        retryAfterMs: rate.retryAfterMs,
      });
      return true;
    }

    const body = await readJsonBody(req);
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const passwordHash = body?.passwordHash;
    const remember = Boolean(body?.remember);

    if (!username || !isSha256Hex(passwordHash)) {
      await recordLoginFailure(rateKey);
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
      await recordLoginFailure(rateKey);
      sendJson(res, 401, { error: 'Invalid credentials.' });
      return true;
    }

    await clearLoginAttempts(rateKey);
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
  // audited. The web container is typically recreated mid-flight, so the client
  // treats a dropped response as "update started".
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
    const timer = setTimeout(() => controller.abort(), 15000);
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
      sendJson(res, 502, { error: 'Could not reach the updater service' });
    } finally {
      clearTimeout(timer);
    }
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
  // constant time; the stored hash is never echoed back.
  if (requestUrl.pathname === '/api/admin/credential/verify' && req.method === 'POST') {
    const stored = await getAppSetting(ADMIN_CREDENTIAL_KEY);
    const storedHash =
      stored && typeof stored.passwordHash === 'string' ? stored.passwordHash : '';
    const { passwordHash } = await readJsonBody(req);
    const valid = storedHash.length > 0 && (await verifyPassword(storedHash, passwordHash));
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
  // in constant time and never echoed back.
  if (requestUrl.pathname === '/api/users/verify' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const username =
      typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const passwordHash = body?.passwordHash;
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

  // Per-user management, keyed by id:
  //   DELETE /api/users/:id           → remove the account.
  //   PUT    /api/users/:id/password  → set a new password ({ passwordHash }).
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
      nextUsers[index] = { ...nextUsers[index], passwordHash: await derivePasswordHash(passwordHash) };
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
      await createMaintenanceNotification({
        printerId: printer.id,
        kind: 'overdue',
        title: `${printer.name}: maintenance overdue`,
        body: overdueToNotify.map((e) => e.maintenanceType).join(', '),
      });
      await markMaintenanceEventsNotified(overdueToNotify.map((e) => e.id), 'overdue');
    }
    if (dueToNotify.length > 0) {
      await createMaintenanceNotification({
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
      await createMaintenanceNotification({
        printerId: printer.id,
        kind: 'health',
        title: `${printer.name}: health ${score} (${healthStatusFromScore(score)})`,
        body: 'Printer health has dropped below 70.',
      });
    }
  }

  await bulkUpdateHealthScores(healthUpdates);
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

createServer(handleRequest).listen(port, host, () => {
  logger.info('Print Farm server listening', { host, port });
  // Evaluate Home Assistant ⇄ printer automation rules on a background interval.
  startHaAutomationEngine();
});
