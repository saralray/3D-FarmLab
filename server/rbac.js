// ─────────────────────────────────────────────────────────────────────────────
// RBAC authorization model (S-2).
//
// Replaces the scattered class-based checks (classifyApiRequest + isSensitiveRead
// + isViewerGatedRead + isPublicRead + isOperatorMutation + isAdminMutation) with
// ONE declarative model:
//
//   roles → capabilities   (a hierarchy: guest < viewer < student < teacher <
//                           operator < technician < admin < super_admin, plus
//                           the machine identities service/ai_agent)
//   routes → capability     (requiredCapability(): every endpoint maps to the
//                           single capability it needs; unmatched = default-deny)
//   authorize()             (the one decision function the request gate calls)
//
// It is a strict superset of the previous four-tier model: the four legacy
// session roles (viewer/student/operator/admin) resolve to capability sets that
// reproduce every prior allow/deny decision (verified by rbac.parity.test), while
// the new roles and per-resource capabilities enable finer control and, with
// tenant scoping (canAccessResource), multi-org isolation.
// ─────────────────────────────────────────────────────────────────────────────

// ── Capabilities ─────────────────────────────────────────────────────────────
// Granular verbs on resources. `authed` is the floor any signed-in role holds.
export const CAP = Object.freeze({
  AUTHED: 'authed', // any authenticated session (dashboard, audit append, tokens)
  PRINTERS_READ: 'printers:read',
  PRINTERS_CONTROL: 'printers:control', // pause/resume/cancel, upsert, proxy, command
  PRINTERS_ADMIN: 'printers:admin', // delete a printer
  QUEUE_READ: 'queue:read',
  QUEUE_SUBMIT: 'queue:submit', // student print-request intake
  QUEUE_WRITE: 'queue:write', // mark printed, upsert
  QUEUE_FILES_READ: 'queue:files:read', // download an uploaded model file
  QUEUE_ADMIN: 'queue:admin', // delete/reset
  ANALYTICS_READ: 'analytics:read',
  ANALYTICS_ADMIN: 'analytics:admin', // reset
  MAINTENANCE_READ: 'maintenance:read',
  MAINTENANCE_WRITE: 'maintenance:write', // complete tasks, mark notifications read
  MAINTENANCE_ADMIN: 'maintenance:admin',
  FILAMENT_WRITE: 'filament:write',
  FILAMENT_ADMIN: 'filament:admin', // delete, kiosk system command
  NOTIFICATIONS_ADMIN: 'notifications:admin', // Discord webhook CRUD (secret URLs)
  SETTINGS_ADMIN: 'settings:admin', // app settings, SAML/SSO, HA, backups, updates
  USERS_ADMIN: 'users:admin', // staff accounts, manager requests
  KEYS_ADMIN: 'keys:admin', // API/slicer keys
  AUDIT_READ: 'audit:read',
  TENANTS_ADMIN: 'tenants:admin', // cross-tenant administration (super admin)
});

// ── Roles ────────────────────────────────────────────────────────────────────
export const ROLE = Object.freeze({
  GUEST: 'guest', // anonymous / public-viewer mode (no session)
  VIEWER: 'viewer', // read-only signed-in
  STUDENT: 'student',
  TEACHER: 'teacher',
  OPERATOR: 'operator',
  TECHNICIAN: 'technician',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
  // Machine identities (authenticated by API key scope, not a session cookie).
  SERVICE: 'service',
  AI_AGENT: 'ai_agent',
});

// Ordering for display / "at least this role" comparisons. Machine identities are
// out-of-band (they authorize via key scope, handled in the /api/v1 path) so they
// are not ranked in the human hierarchy.
export const ROLE_RANK = Object.freeze({
  guest: 0,
  viewer: 10,
  student: 20,
  teacher: 30,
  operator: 40,
  technician: 50,
  admin: 60,
  super_admin: 70,
});

const READS = [CAP.PRINTERS_READ, CAP.QUEUE_READ, CAP.ANALYTICS_READ, CAP.MAINTENANCE_READ];

// Explicit capability grant per role (not implicit rank inheritance — a technician
// is not a strict superset of an operator's every verb, so grants are stated
// directly to avoid surprises). Higher-level roles list the lower-level grants
// they include.
const ROLE_CAPS = (() => {
  const viewer = [CAP.AUTHED, ...READS];
  const student = [...viewer, CAP.QUEUE_SUBMIT];
  const teacher = [...student, CAP.QUEUE_WRITE, CAP.MAINTENANCE_WRITE];
  const operator = [
    ...student,
    CAP.PRINTERS_CONTROL,
    CAP.QUEUE_WRITE,
    CAP.QUEUE_FILES_READ,
    CAP.MAINTENANCE_WRITE,
    CAP.FILAMENT_WRITE,
  ];
  const technician = [...operator, CAP.PRINTERS_ADMIN, CAP.MAINTENANCE_ADMIN, CAP.FILAMENT_ADMIN];
  const admin = [
    CAP.AUTHED,
    ...READS,
    CAP.QUEUE_SUBMIT,
    CAP.PRINTERS_CONTROL, CAP.PRINTERS_ADMIN,
    CAP.QUEUE_WRITE, CAP.QUEUE_FILES_READ, CAP.QUEUE_ADMIN,
    CAP.ANALYTICS_ADMIN,
    CAP.MAINTENANCE_WRITE, CAP.MAINTENANCE_ADMIN,
    CAP.FILAMENT_WRITE, CAP.FILAMENT_ADMIN,
    CAP.NOTIFICATIONS_ADMIN, CAP.SETTINGS_ADMIN, CAP.USERS_ADMIN, CAP.KEYS_ADMIN, CAP.AUDIT_READ,
  ];
  const superAdmin = [...admin, CAP.TENANTS_ADMIN];
  return Object.freeze({
    guest: Object.freeze(new Set()),
    viewer: Object.freeze(new Set(viewer)),
    student: Object.freeze(new Set(student)),
    teacher: Object.freeze(new Set(teacher)),
    operator: Object.freeze(new Set(operator)),
    technician: Object.freeze(new Set(technician)),
    admin: Object.freeze(new Set(admin)),
    super_admin: Object.freeze(new Set(superAdmin)),
  });
})();

// True when `role` holds `capability`. Unknown roles hold nothing (fail closed).
export function roleHasCapability(role, capability) {
  const caps = ROLE_CAPS[role];
  return caps ? caps.has(capability) : false;
}

// The full capability set for a role (array copy, for display/debugging).
export function capabilitiesFor(role) {
  const caps = ROLE_CAPS[role];
  return caps ? [...caps] : [];
}

// ── Route → capability registry ──────────────────────────────────────────────
// Sentinels distinct from any capability string.
export const PUBLIC = 'PUBLIC'; // no session required

const QUEUE_FILE_RE = /^\/api\/queue\/[^/]+\/file$/;

// Public frontend mutations (unauthenticated intake). Kept identical to the
// previous PUBLIC_API_MUTATIONS set.
const PUBLIC_MUTATIONS = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/verify',
  'POST /api/auth/saml/acs',
  'POST /api/slicer-grant/verify',
  'POST /api/admin/credential/verify',
  'POST /api/users/verify',
  'POST /api/manager/request',
  'POST /api/queue/submit',
]);

const VIEWER_GATED_READS = new Set(['/api/maintenance/summary']);

// Secret-bearing GET reads → their admin capability. Only admin/super_admin hold
// these caps, so the legacy "admin-only read" behavior is preserved exactly.
function sensitiveReadCapability(p) {
  if (p === '/api/users' || (p.startsWith('/api/users/') && p !== '/api/users/verify')) return CAP.USERS_ADMIN;
  if (p === '/api/slicer-keys' || p.startsWith('/api/slicer-keys/')) return CAP.KEYS_ADMIN;
  if (p === '/api/audit-logs') return CAP.AUDIT_READ;
  if (p === '/api/admin/update-status') return CAP.SETTINGS_ADMIN;
  if (p === '/api/admin/backup/download') return CAP.SETTINGS_ADMIN;
  if (p === '/api/network-usage' || p === '/api/network-usage/live') return CAP.AUDIT_READ;
  if (p.startsWith('/api/notifications/')) return CAP.NOTIFICATIONS_ADMIN;
  if (p === '/api/manager/requests') return CAP.USERS_ADMIN;
  if (p.startsWith('/api/manager/requests/') && !p.endsWith('/status')) return CAP.USERS_ADMIN;
  if (p === '/api/settings/saml') return CAP.SETTINGS_ADMIN;
  if (p.startsWith('/api/settings/home-assistant')) return CAP.SETTINGS_ADMIN;
  // The printer callback URL is the SERVER's own LAN address (e.g.
  // http://192.168.x.x:8080) that H2 printers call back to — an infrastructure
  // detail. Only the admin Settings form reads it over HTTP (the poller/slicer
  // read it from the DB directly), so gate it to admin instead of leaving it in
  // the world-readable /api/settings/* family. (Was an unauthenticated LAN-IP leak.)
  if (p === '/api/settings/printer-callback-url') return CAP.SETTINGS_ADMIN;
  if (p === '/api/status-light/provisioning') return CAP.SETTINGS_ADMIN;
  return null;
}

// Explicitly public reads (the anonymous viewer/intake/bootstrap surface).
function isPublicRead(p) {
  if (p === '/api' || p === '/api/' || p === '/api/version') return true;
  if (p === '/api/auth/session' || p.startsWith('/api/auth/')) return true;
  if (p === '/api/admin/credential') return true;
  if (p === '/api/printers' || p.startsWith('/api/printers/')) return true;
  if (p === '/api/cameras/health') return true;
  if (p === '/api/queue' || p.startsWith('/api/queue/')) return true;
  if (p.startsWith('/api/analytics/')) return true;
  if (p === '/api/maintenance' || p.startsWith('/api/maintenance/')) return true;
  if (p.startsWith('/api/settings/')) return true;
  if (p === '/api/status-light/devices' || p.startsWith('/api/status-light/printers/')) return true;
  if (p.startsWith('/api/manager/requests/') && p.endsWith('/status')) return true;
  return false;
}

function operatorMutationCapability(method, p) {
  if (p === '/api/printers' && method === 'POST') return CAP.PRINTERS_CONTROL;
  if (p.startsWith('/api/printers/') && p.endsWith('/command') && method === 'POST') return CAP.PRINTERS_CONTROL;
  if (p.startsWith('/api/queue/') && p.endsWith('/printed') && method === 'POST') return CAP.QUEUE_WRITE;
  if (p === '/api/queue' && method === 'POST') return CAP.QUEUE_WRITE;
  if (p === '/api/queue/availability/bypass' && method === 'POST') return CAP.QUEUE_WRITE;
  if (p.startsWith('/api/maintenance/') && p.endsWith('/complete') && method === 'POST') return CAP.MAINTENANCE_WRITE;
  if (p === '/api/maintenance/notifications/read' && method === 'POST') return CAP.MAINTENANCE_WRITE;
  if (p.startsWith('/api/filament-station/') && (method === 'POST' || method === 'PUT') && !p.endsWith('/system/command')) {
    return CAP.FILAMENT_WRITE;
  }
  return null;
}

function adminMutationCapability(method, p) {
  if (p === '/api/users' && method === 'POST') return CAP.USERS_ADMIN;
  if (p.startsWith('/api/users/') && p !== '/api/users/verify') return CAP.USERS_ADMIN;
  if (p === '/api/slicer-keys' && method === 'POST') return CAP.KEYS_ADMIN;
  if (p.startsWith('/api/slicer-keys/') && method === 'DELETE') return CAP.KEYS_ADMIN;
  if (p === '/api/admin/credential' && method === 'PUT') return CAP.SETTINGS_ADMIN;
  if (p === '/api/admin/update/apply' && method === 'POST') return CAP.SETTINGS_ADMIN;
  if (p === '/api/admin/backup/restore' && method === 'POST') return CAP.SETTINGS_ADMIN;
  if (p.startsWith('/api/notifications/')) return CAP.NOTIFICATIONS_ADMIN;
  if (p === '/api/settings/saml' || p === '/api/settings/saml/test') return CAP.SETTINGS_ADMIN;
  if (p.startsWith('/api/settings/') && method !== 'GET') return CAP.SETTINGS_ADMIN;
  if (p === '/api/analytics/daily/reset') return CAP.ANALYTICS_ADMIN;
  if (p === '/api/queue/reset') return CAP.QUEUE_ADMIN;
  if (p.startsWith('/api/queue/') && method === 'DELETE') return CAP.QUEUE_ADMIN;
  if (p.startsWith('/api/printers/') && method === 'DELETE') return CAP.PRINTERS_ADMIN;
  if (p.startsWith('/api/manager/requests/') && !p.endsWith('/status')) return CAP.USERS_ADMIN;
  if (p.startsWith('/api/filament-station/')) {
    if (method === 'DELETE') return CAP.FILAMENT_ADMIN;
    if (p.endsWith('/system/command') && method === 'POST') return CAP.FILAMENT_ADMIN;
  }
  return null;
}

// The single route policy resolver. Returns PUBLIC (no session) or the one
// capability the caller must hold. `publicViewer` toggles viewer-gated reads.
// Default-deny: an unclassified read requires AUTHED; an unclassified mutation
// requires the highest admin capability.
export function requiredCapability(method, pathname, { publicViewer = false } = {}) {
  const m = (method || 'GET').toUpperCase();
  if (m === 'OPTIONS') return PUBLIC;

  if (m === 'GET' || m === 'HEAD') {
    const sens = sensitiveReadCapability(pathname);
    if (sens) return sens;
    if (VIEWER_GATED_READS.has(pathname) && !publicViewer) return CAP.AUTHED;
    if (QUEUE_FILE_RE.test(pathname)) return CAP.QUEUE_FILES_READ;
    if (isPublicRead(pathname)) return PUBLIC;
    return CAP.AUTHED; // default-deny reads to a session
  }

  // Mutations
  if (PUBLIC_MUTATIONS.has(`${m} ${pathname}`)) return PUBLIC;
  if (m === 'POST' && pathname === '/api/admin/credential') return PUBLIC; // first-run (handler 409s once set)
  if (pathname === '/api/audit-logs' && m === 'POST') return CAP.AUTHED;
  if (pathname === '/api/auth/slicer-token' && (m === 'POST' || m === 'DELETE')) return CAP.AUTHED;
  const op = operatorMutationCapability(m, pathname);
  if (op) return op;
  const ad = adminMutationCapability(m, pathname);
  if (ad) return ad;
  return CAP.SETTINGS_ADMIN; // default-deny mutations to admin
}

// ── The authorization decision ───────────────────────────────────────────────
// subject = { role, tenantId } | null (anonymous). Returns:
//   { allow: true }                       — permitted
//   { allow: false, status: 401 }         — needs a session
//   { allow: false, status: 403, capability } — session lacks the capability
export function authorize(subject, method, pathname, opts = {}) {
  const cap = requiredCapability(method, pathname, opts);
  if (cap === PUBLIC) return { allow: true };
  if (!subject || !subject.role) return { allow: false, status: 401 };
  if (roleHasCapability(subject.role, cap)) return { allow: true };
  return { allow: false, status: 403, capability: cap };
}

// ── Tenant scoping (multi-org isolation, S-2) ────────────────────────────────
// A capability check answers "may this role do X?"; tenant scoping answers "on
// WHOSE data?". super_admin (TENANTS_ADMIN) crosses tenants; everyone else is
// confined to their own. Enforced in the app layer here and, once the migration
// lands, defense-in-depth via Postgres RLS. resource = { tenantId, ownerId }.
export function sameTenant(subject, resource) {
  if (!subject) return false;
  if (roleHasCapability(subject.role, CAP.TENANTS_ADMIN)) return true; // super admin
  if (!resource || resource.tenantId == null || subject.tenantId == null) return true; // untenanted → single-tenant behavior
  return String(subject.tenantId) === String(resource.tenantId);
}

// Full object-level check: capability AND tenant scope. Use for per-record access
// (e.g. a teacher acting on a queue job) once resources carry tenant/owner ids.
export function canAccessResource(subject, capability, resource) {
  if (!subject || !subject.role) return false;
  if (!roleHasCapability(subject.role, capability)) return false;
  return sameTenant(subject, resource);
}
