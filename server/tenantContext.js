// Tenant request context for multi-org isolation (S-2 phase 2).
//
// Postgres Row-Level Security (db/tenancy/02-enable-rls.sql) confines every
// tenant-scoped table to the tenant named by the `app.tenant_id` GUC. This helper
// sets that GUC for the duration of a transaction so the RLS policies see the
// right tenant, then runs the caller's work on the same connection.
//
//   await withTenantContext(client, session.tenantId, async (c) => {
//     return c.query('SELECT * FROM queue_jobs');   // RLS-scoped to that tenant
//   });
//
// Notes / invariants (see db/tenancy/README.md):
//   - Uses set_config(name, value, is_local=true), which is parameterized — the
//     tenant id can never be SQL-injected (SET does not accept parameters).
//   - is_local=true scopes the setting to THIS transaction, so a pooled
//     connection never leaks one tenant's context into the next request.
//   - The special value '*' is the cross-tenant (super_admin) context; the RLS
//     policy grants all rows for it. Pass it only after a TENANTS_ADMIN check.
//   - RLS only actually enforces when the web role is NOT a superuser and lacks
//     BYPASSRLS (i.e. the pf_web least-privilege role) — a superuser bypasses RLS
//     regardless. This is why phase 2 pairs with the per-service DB roles.

const CROSS_TENANT = '*';

// Normalize a tenant id to the value RLS compares against. null/undefined/empty
// → 'default' (single-tenant deployments and untenanted callers). The sentinel
// '*' is preserved for the cross-tenant context.
export function normalizeTenantId(tenantId) {
  if (tenantId === CROSS_TENANT) return CROSS_TENANT;
  const s = tenantId == null ? '' : String(tenantId).trim();
  return s === '' ? 'default' : s;
}

// Run fn(client) inside a transaction with app.tenant_id set for RLS. Commits on
// success, rolls back and rethrows on error. The client must be a dedicated
// connection (pool.connect()), not the shared query() helper, so the transaction
// and its SET LOCAL stay on one connection.
export async function withTenantContext(client, tenantId, fn) {
  const tid = normalizeTenantId(tenantId);
  await client.query('BEGIN');
  try {
    // Parameterized — no injection possible. is_local=true → transaction-scoped.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tid]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* rollback best-effort; surface the original error */
    }
    throw err;
  }
}

// Resolve the tenant a subject operates in. super_admin (rbac TENANTS_ADMIN) may
// request the cross-tenant context; everyone else is pinned to their own tenant.
export function tenantContextFor(subject, { crossTenant = false } = {}) {
  if (crossTenant) return CROSS_TENANT;
  return normalizeTenantId(subject && subject.tenantId);
}

export const CROSS_TENANT_CONTEXT = CROSS_TENANT;
