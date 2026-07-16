// Tests for the tenant request-context helper. No test runner in this project —
// run directly:  node server/tenantContext.test.mjs
import assert from 'node:assert/strict';
import { withTenantContext, normalizeTenantId, tenantContextFor, CROSS_TENANT_CONTEXT } from './tenantContext.js';

let n = 0;
const t = (fn) => { fn(); n++; };

// A fake pg client that records the queries it receives.
function fakeClient({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (failOn && text.includes(failOn)) throw new Error(`boom:${failOn}`);
      return { rows: [] };
    },
  };
}

// ── normalizeTenantId ────────────────────────────────────────────────────────
t(() => assert.equal(normalizeTenantId(null), 'default'));
t(() => assert.equal(normalizeTenantId(undefined), 'default'));
t(() => assert.equal(normalizeTenantId(''), 'default'));
t(() => assert.equal(normalizeTenantId('   '), 'default'));
t(() => assert.equal(normalizeTenantId('acme'), 'acme'));
t(() => assert.equal(normalizeTenantId('  acme  '), 'acme'));
t(() => assert.equal(normalizeTenantId('*'), '*')); // cross-tenant sentinel preserved
t(() => assert.equal(normalizeTenantId(42), '42'));

// ── tenantContextFor ─────────────────────────────────────────────────────────
t(() => assert.equal(tenantContextFor({ tenantId: 'acme' }), 'acme'));
t(() => assert.equal(tenantContextFor({ tenantId: null }), 'default'));
t(() => assert.equal(tenantContextFor({ tenantId: 'acme' }, { crossTenant: true }), '*'));
t(() => assert.equal(tenantContextFor(null), 'default'));

// ── withTenantContext: happy path sets GUC and commits ──────────────────────
t(() => {});
await (async () => {
  const c = fakeClient();
  const out = await withTenantContext(c, 'acme', async (client) => {
    await client.query('SELECT 1 FROM queue_jobs');
    return 'ok';
  });
  assert.equal(out, 'ok');
  const texts = c.calls.map((x) => x.text);
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts[1], 'SELECT set_config($1, $2, true)');
  assert.deepEqual(c.calls[1].params, ['app.tenant_id', 'acme']);
  assert.ok(texts.includes('SELECT 1 FROM queue_jobs'));
  assert.equal(texts[texts.length - 1], 'COMMIT');
  n++;
})();

// ── withTenantContext: normalizes null tenant to 'default' ──────────────────
await (async () => {
  const c = fakeClient();
  await withTenantContext(c, null, async () => {});
  assert.deepEqual(c.calls[1].params, ['app.tenant_id', 'default']);
  n++;
})();

// ── withTenantContext: cross-tenant sentinel passes through ─────────────────
await (async () => {
  const c = fakeClient();
  await withTenantContext(c, CROSS_TENANT_CONTEXT, async () => {});
  assert.deepEqual(c.calls[1].params, ['app.tenant_id', '*']);
  n++;
})();

// ── withTenantContext: rolls back and rethrows on error ─────────────────────
await (async () => {
  const c = fakeClient();
  let threw = null;
  try {
    await withTenantContext(c, 'acme', async () => { throw new Error('work failed'); });
  } catch (e) { threw = e; }
  assert.ok(threw && /work failed/.test(threw.message));
  const texts = c.calls.map((x) => x.text);
  assert.ok(texts.includes('ROLLBACK'), 'should roll back on error');
  assert.ok(!texts.includes('COMMIT'), 'must not commit on error');
  n++;
})();

console.log(`\nALL ${n} TENANT-CONTEXT TESTS PASSED ✅`);
