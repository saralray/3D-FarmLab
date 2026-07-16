// Regression tests for the RBAC authorization model (server/rbac.js).
// No test runner in this project — run directly:  node server/rbac.test.mjs
//
// These lock in the behavior that was verified, at introduction time, to
// reproduce every decision of the previous four-tier classifier (760/760
// route×role×viewer cases). If a change here fails, the authorization surface
// has shifted — treat it as a security-relevant review, not a test to "fix".

import assert from 'node:assert/strict';
import {
  CAP, ROLE, requiredCapability, roleHasCapability, authorize, PUBLIC,
  canAccessResource, sameTenant,
} from './rbac.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };
const decide = (role, m, p, publicViewer = false) => {
  const d = authorize(role ? { role, tenantId: null } : null, m, p, { publicViewer });
  return d.allow ? 'allow' : String(d.status);
};

// ── role → capability matrix ────────────────────────────────────────────────
t('guest holds nothing', () => {
  assert.equal(roleHasCapability(ROLE.GUEST, CAP.AUTHED), false);
});
t('viewer is read-only', () => {
  assert.equal(roleHasCapability(ROLE.VIEWER, CAP.AUTHED), true);
  assert.equal(roleHasCapability(ROLE.VIEWER, CAP.PRINTERS_READ), true);
  assert.equal(roleHasCapability(ROLE.VIEWER, CAP.PRINTERS_CONTROL), false);
  assert.equal(roleHasCapability(ROLE.VIEWER, CAP.QUEUE_FILES_READ), false);
});
t('operator controls but is not admin', () => {
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.PRINTERS_CONTROL), true);
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.QUEUE_WRITE), true);
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.QUEUE_FILES_READ), true);
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.PRINTERS_ADMIN), false);
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.USERS_ADMIN), false);
  assert.equal(roleHasCapability(ROLE.OPERATOR, CAP.KEYS_ADMIN), false);
});
t('technician adds maintenance/printer admin but not user/key admin', () => {
  assert.equal(roleHasCapability(ROLE.TECHNICIAN, CAP.MAINTENANCE_ADMIN), true);
  assert.equal(roleHasCapability(ROLE.TECHNICIAN, CAP.PRINTERS_ADMIN), true);
  assert.equal(roleHasCapability(ROLE.TECHNICIAN, CAP.USERS_ADMIN), false);
});
t('admin holds every non-tenant capability', () => {
  for (const cap of [CAP.PRINTERS_ADMIN, CAP.QUEUE_ADMIN, CAP.USERS_ADMIN, CAP.KEYS_ADMIN,
    CAP.SETTINGS_ADMIN, CAP.NOTIFICATIONS_ADMIN, CAP.AUDIT_READ, CAP.ANALYTICS_ADMIN]) {
    assert.equal(roleHasCapability(ROLE.ADMIN, cap), true, `admin should hold ${cap}`);
  }
  assert.equal(roleHasCapability(ROLE.ADMIN, CAP.TENANTS_ADMIN), false);
});
t('super_admin adds cross-tenant', () => {
  assert.equal(roleHasCapability(ROLE.SUPER_ADMIN, CAP.TENANTS_ADMIN), true);
  assert.equal(roleHasCapability(ROLE.SUPER_ADMIN, CAP.USERS_ADMIN), true);
});

// ── route → capability ──────────────────────────────────────────────────────
t('public reads resolve to PUBLIC', () => {
  for (const p of ['/api/version', '/api/printers', '/api/queue', '/api/settings/branding',
    '/api/status-light/printers/x', '/api/analytics/daily']) {
    assert.equal(requiredCapability('GET', p), PUBLIC, p);
  }
});
t('sensitive reads resolve to their admin capability', () => {
  assert.equal(requiredCapability('GET', '/api/users'), CAP.USERS_ADMIN);
  assert.equal(requiredCapability('GET', '/api/slicer-keys'), CAP.KEYS_ADMIN);
  assert.equal(requiredCapability('GET', '/api/audit-logs'), CAP.AUDIT_READ);
  assert.equal(requiredCapability('GET', '/api/settings/saml'), CAP.SETTINGS_ADMIN);
});
t('queue file read is operator-tier', () => {
  assert.equal(requiredCapability('GET', '/api/queue/j1/file'), CAP.QUEUE_FILES_READ);
});
t('unclassified read default-denies to AUTHED', () => {
  assert.equal(requiredCapability('GET', '/api/filament-station/spools'), CAP.AUTHED);
  assert.equal(requiredCapability('GET', '/api/brand-new-read'), CAP.AUTHED);
});
t('viewer-gated read depends on viewer mode', () => {
  assert.equal(requiredCapability('GET', '/api/maintenance/summary', { publicViewer: false }), CAP.AUTHED);
  assert.equal(requiredCapability('GET', '/api/maintenance/summary', { publicViewer: true }), PUBLIC);
});
t('operator vs admin mutations', () => {
  assert.equal(requiredCapability('POST', '/api/printers/p1/command'), CAP.PRINTERS_CONTROL);
  assert.equal(requiredCapability('POST', '/api/printers'), CAP.PRINTERS_CONTROL); // upsert = operator
  assert.equal(requiredCapability('DELETE', '/api/printers/p1'), CAP.PRINTERS_ADMIN);
  assert.equal(requiredCapability('POST', '/api/queue/j1/printed'), CAP.QUEUE_WRITE);
  assert.equal(requiredCapability('POST', '/api/queue/reset'), CAP.QUEUE_ADMIN);
  assert.equal(requiredCapability('POST', '/api/users'), CAP.USERS_ADMIN);
});
t('public + authed mutations', () => {
  assert.equal(requiredCapability('POST', '/api/queue/submit'), PUBLIC);
  assert.equal(requiredCapability('POST', '/api/auth/login'), PUBLIC);
  assert.equal(requiredCapability('POST', '/api/audit-logs'), CAP.AUTHED);
});
t('unclassified mutation default-denies to admin', () => {
  assert.equal(requiredCapability('POST', '/api/totally-unknown'), CAP.SETTINGS_ADMIN);
});

// ── end-to-end authorize (matches the legacy four tiers) ────────────────────
t('anonymous: public allowed, everything else 401', () => {
  assert.equal(decide(null, 'GET', '/api/printers'), 'allow');
  assert.equal(decide(null, 'GET', '/api/users'), '401');
  assert.equal(decide(null, 'POST', '/api/printers/p1/command'), '401');
});
t('viewer: authed reads yes, control/admin no', () => {
  assert.equal(decide(ROLE.VIEWER, 'GET', '/api/filament-station/spools'), 'allow'); // authed
  assert.equal(decide(ROLE.VIEWER, 'POST', '/api/printers/p1/command'), '403');
  assert.equal(decide(ROLE.VIEWER, 'GET', '/api/users'), '403');
  assert.equal(decide(ROLE.VIEWER, 'GET', '/api/queue/j1/file'), '403');
});
t('operator: control yes, admin no', () => {
  assert.equal(decide(ROLE.OPERATOR, 'POST', '/api/printers/p1/command'), 'allow');
  assert.equal(decide(ROLE.OPERATOR, 'GET', '/api/queue/j1/file'), 'allow');
  assert.equal(decide(ROLE.OPERATOR, 'DELETE', '/api/printers/p1'), '403');
  assert.equal(decide(ROLE.OPERATOR, 'POST', '/api/users'), '403');
  assert.equal(decide(ROLE.OPERATOR, 'PUT', '/api/admin/credential'), '403');
});
t('admin: everything', () => {
  for (const [m, p] of [['POST', '/api/users'], ['DELETE', '/api/printers/p1'],
    ['PUT', '/api/settings/saml'], ['POST', '/api/slicer-keys'], ['POST', '/api/totally-unknown']]) {
    assert.equal(decide(ROLE.ADMIN, m, p), 'allow', `admin ${m} ${p}`);
  }
});

// ── tenant scoping ──────────────────────────────────────────────────────────
t('tenant isolation confines non-super roles', () => {
  const a = { role: ROLE.ADMIN, tenantId: 'A' };
  assert.equal(sameTenant(a, { tenantId: 'A' }), true);
  assert.equal(sameTenant(a, { tenantId: 'B' }), false);
  assert.equal(canAccessResource(a, CAP.QUEUE_WRITE, { tenantId: 'B' }), false);
  assert.equal(canAccessResource(a, CAP.QUEUE_WRITE, { tenantId: 'A' }), true);
});
t('super_admin crosses tenants', () => {
  const s = { role: ROLE.SUPER_ADMIN, tenantId: 'A' };
  assert.equal(sameTenant(s, { tenantId: 'B' }), true);
  assert.equal(canAccessResource(s, CAP.QUEUE_WRITE, { tenantId: 'B' }), true);
});
t('untenanted resources behave single-tenant (backward compatible)', () => {
  const a = { role: ROLE.OPERATOR, tenantId: null };
  assert.equal(sameTenant(a, { tenantId: null }), true);
  assert.equal(canAccessResource(a, CAP.QUEUE_WRITE, {}), true);
});

console.log(`\nALL ${n} RBAC TESTS PASSED ✅`);
