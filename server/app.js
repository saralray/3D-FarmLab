import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import busboy from 'busboy';
import {
  approveManagerRequest,
  clearManagerRequestKeySecret,
  createDiscordWebhook,
  createManagerRequest,
  createSlicerApiKey,
  deleteDiscordWebhook,
  deletePrinter,
  deleteQueueJob,
  deleteQueueJobs,
  deleteSlicerApiKey,
  denyManagerRequest,
  ensureSchema,
  exportQueueJobs,
  findSlicerApiKeyByHash,
  getAppSetting,
  getManagerRequest,
  getPrinterById,
  getPrinterByIdOrName,
  getPublicPrinterById,
  getQueueJobFile,
  importQueueJobs,
  insertQueueSubmission,
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
} from './postgres.js';
import { verifySlicerGrant } from './slicerGrant.js';
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
const QUEUE_ALLOWED_FILE_EXT = new Set([
  '.stl',
  '.3mf',
  '.obj',
  '.step',
  '.stp',
  '.gcode',
  '.gco',
  '.g',
  '.zip',
]);

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
  return {
    provider: providerName,
    enabled: stored.enabled === true,
    clientId: typeof stored.clientId === 'string' ? stored.clientId.trim() : '',
    clientSecret: typeof stored.clientSecret === 'string' ? stored.clientSecret : '',
    tenant: typeof stored.tenant === 'string' ? stored.tenant.trim() : '',
    // On-prem AD FS authority base (e.g. https://host/adfs); blank = use cloud.
    authority: typeof stored.authority === 'string' ? stored.authority.trim() : '',
    allowedDomains,
  };
}

// True only when the flow can actually run (enabled + client id + secret, plus,
// for tenant providers — Microsoft — either a cloud tenant or an AD FS authority).
function isOAuthConfigured(config) {
  if (!config || !config.enabled || !config.clientId || !config.clientSecret) {
    return false;
  }
  const provider = getOAuthProvider(config.provider);
  if (provider?.usesTenant && !config.tenant && !config.authority) {
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
  for (const candidate of [claims.email, claims.preferred_username, claims.upn]) {
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

// The dashboard sits behind nginx, so the public origin must come from the
// forwarded headers (falling back to Host). The redirect_uri must match this
// exactly and be registered with the provider (Google Cloud console / Azure app
// registration) per provider.
function resolvePublicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function oauthRedirectUri(req, providerName) {
  return `${resolvePublicOrigin(req)}/api/auth/${providerName}/callback`;
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
function defaultSamlSpEntityId(req) {
  return `${resolvePublicOrigin(req)}/api/auth/saml/metadata`;
}
function defaultSamlAcsUrl(req) {
  return `${resolvePublicOrigin(req)}/api/auth/saml/acs`;
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
  };
}

// True only when the flow can actually run: enabled, with an IdP SSO URL and a
// signing certificate to verify assertions against.
function isSamlConfigured(config) {
  return Boolean(config && config.enabled && config.idpSsoUrl && config.idpCertificate);
}

// Resolve the effective SP entity id / ACS URL, falling back to the request
// origin when an admin left them blank.
function resolveSamlEndpoints(config, req) {
  return {
    spEntityId: config.spEntityId || defaultSamlSpEntityId(req),
    acsUrl: config.acsUrl || defaultSamlAcsUrl(req),
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

// The branding PUT can carry both a logo and a background data URL at once, so
// its body limit must fit both plus the surrounding JSON envelope.
const MAX_BRANDING_BODY_BYTES =
  MAX_LOGO_DATA_URL_BYTES + MAX_BACKGROUND_DATA_URL_BYTES + 16 * 1024;

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
      const fileRecord = await getQueueJobFile(id);
      if (!fileRecord) {
        sendJson(res, 404, { error: 'File not found' });
        return true;
      }
      const safeName = (fileRecord.filename || 'model').replace(/[^\w.\- ]+/g, '_');
      res.statusCode = 200;
      res.setHeader('Content-Type', fileRecord.mime);
      res.setHeader('Content-Length', fileRecord.content.length);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(fileRecord.content);
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
      const newUser = { id: randomUUID(), name, username, role, passwordHash: passwordHash.toLowerCase() };
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
      ? usersList.find(
          (candidate) =>
            candidate.username === username &&
            timingSafeEqualString(String(candidate.passwordHash || ''), passwordHash.toLowerCase()),
        )
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
    if (!isSha256Hex(passwordHash)) {
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
    nextUsers[index] = { ...nextUsers[index], passwordHash: passwordHash.toLowerCase() };
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
    const valid =
      storedHash.length > 0 &&
      isSha256Hex(passwordHash) &&
      timingSafeEqualString(storedHash, passwordHash.toLowerCase());
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
    if (!isSha256Hex(passwordHash)) {
      sendJson(res, 400, { error: 'passwordHash must be a sha256 hex string' });
      return true;
    }
    await setAppSetting(ADMIN_CREDENTIAL_KEY, { passwordHash: passwordHash.toLowerCase() });
    auditDataApi(req, apiKey, 'admin-credential.set', null);
    sendEmpty(res, storedHash.length > 0 ? 200 : 201);
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
    if (ext && !QUEUE_ALLOWED_FILE_EXT.has(ext)) {
      sendJson(res, 415, {
        error: `Unsupported file type "${ext}". Allowed: STL, 3MF, OBJ, STEP, G-code, ZIP.`,
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
        console.error('Failed to send queue add notification', error);
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
    const fileRecord = await getQueueJobFile(jobId);
    if (!fileRecord) {
      sendJson(res, 404, { error: 'File not found' });
      return true;
    }
    const safeName = (fileRecord.filename || 'model').replace(/[^\w.\- ]+/g, '_');
    res.statusCode = 200;
    res.setHeader('Content-Type', fileRecord.mime);
    res.setHeader('Content-Length', fileRecord.content.length);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(fileRecord.content);
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
    const [google, microsoft, saml] = await Promise.all([
      getOAuthConfig('google'),
      getOAuthConfig('microsoft'),
      getSamlConfig(),
    ]);
    sendJson(res, 200, {
      google: isOAuthConfigured(google),
      microsoft: isOAuthConfigured(microsoft),
      saml: isSamlConfigured(saml),
    });
    return true;
  }

  // SAML 2.0 SSO endpoints (the dashboard is the SP).
  //   GET  /api/auth/saml/metadata → SP metadata XML (public, for IdP setup)
  //   GET  /api/auth/saml/start    → 302 to the IdP carrying a deflate AuthnRequest
  //   POST /api/auth/saml/acs      → consume the IdP's signed SAMLResponse (POST binding)
  if (requestUrl.pathname === '/api/auth/saml/metadata' && req.method === 'GET') {
    const config = await getSamlConfig();
    const { spEntityId, acsUrl } = resolveSamlEndpoints(config, req);
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
    const { spEntityId, acsUrl } = resolveSamlEndpoints(config, req);
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
    const { spEntityId, acsUrl } = resolveSamlEndpoints(config, req);
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

  const ssoMatch = requestUrl.pathname.match(
    /^\/api\/auth\/(google|microsoft)\/(config|start|callback)$/,
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
      const state = signState(secret, { n: randomUUID(), p: providerName });
      const authorizeUrl = new URL(provider.authorizeEndpoint(config));
      authorizeUrl.searchParams.set('client_id', config.clientId);
      authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri(req, providerName));
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', OAUTH_SCOPE);
      authorizeUrl.searchParams.set('state', state);
      // Force a fresh login so a shared kiosk doesn't silently reuse a session.
      // On-prem AD FS (authority set) only understands prompt=login/none/consent —
      // it rejects the Entra/Google `select_account` value with invalid_request —
      // so use `login` there and the account chooser only on cloud providers.
      authorizeUrl.searchParams.set(
        'prompt',
        config.authority ? 'login' : 'select_account',
      );
      sendRedirect(res, authorizeUrl.toString());
      return true;
    }

    // op === 'callback'
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    const stateData = verifyState(secret, state);
    if (requestUrl.searchParams.get('error') || !code || !stateData || stateData.p !== providerName) {
      sendRedirect(res, '/login?oauth_error=denied');
      return true;
    }

    try {
      const tokenResponse = await fetch(provider.tokenEndpoint(config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: oauthRedirectUri(req, providerName),
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenResponse.ok) {
        sendRedirect(res, '/login?oauth_error=exchange_failed');
        return true;
      }
      const tokens = await tokenResponse.json();
      // The id_token comes straight from the provider's token endpoint over TLS
      // using our client secret, so its claims are trusted without re-verifying
      // the signature; we only need the identity fields out of the payload.
      const claims = decodeJwtClaims(tokens.id_token);
      const email = oauthClaimEmail(claims);
      // Google sets email_verified; Microsoft omits it (work/school accounts are
      // inherently verified), so only reject when it is explicitly false.
      if (!email || claims?.email_verified === false) {
        sendRedirect(res, '/login?oauth_error=unverified_email');
        return true;
      }
      if (config.allowedDomains.length > 0) {
        const domain = email.slice(email.indexOf('@') + 1);
        if (!config.allowedDomains.includes(domain)) {
          sendRedirect(res, '/login?oauth_error=domain_not_allowed');
          return true;
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
    sendJson(res, 200, {
      user: {
        id: `${grant.provider}:${grant.sub}`,
        name: grant.name,
        username: grant.email,
        role: grant.role,
      },
    });
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

  // OAuth (SSO) sign-in config, per provider (admin-only in the UI, like the
  // integrations form above). GET never returns the client secret — only whether
  // one is stored; PUT with a blank/omitted clientSecret keeps the existing one so
  // the form can round-trip without re-entering it. `tenant` is Microsoft-only
  // (the Azure directory / tenant id); it is accepted and stored for any provider
  // but ignored where unused.
  const oauthSettingsMatch = requestUrl.pathname.match(
    /^\/api\/settings\/oauth\/(google|microsoft)$/,
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
      });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const enabled = body?.enabled === true;
      const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
      const tenant = typeof body?.tenant === 'string' ? body.tenant.trim() : '';
      const authority = typeof body?.authority === 'string' ? body.authority.trim() : '';
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
      const { spEntityId, acsUrl } = resolveSamlEndpoints(config, req);
      sendJson(res, 200, {
        ...config,
        // Surface the effective SP identifiers so the form can prefill the
        // defaults the metadata endpoint advertises when the fields are blank.
        defaultSpEntityId: defaultSamlSpEntityId(req),
        defaultAcsUrl: defaultSamlAcsUrl(req),
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
      const endpoints = resolveSamlEndpoints(saved, req);
      sendJson(res, 200, {
        ...saved,
        defaultSpEntityId: defaultSamlSpEntityId(req),
        defaultAcsUrl: defaultSamlAcsUrl(req),
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

      await setAppSetting(BRANDING_KEY, { siteName, logoDataUrl: trimmed, logoSvg, logoAdaptive, logoScale, backgroundDataUrl });
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

createServer(handleRequest).listen(port, host, () => {
  console.log(`Print Farm server listening on ${host}:${port}`);
});
