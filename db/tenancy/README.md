# Multi-tenant isolation (S-2 phase 2)

This directory holds the **database-layer** tenant isolation for PrintFarm. It is
the defense-in-depth layer beneath the application authorization model
(`server/rbac.js`): even a query that forgets to filter by tenant cannot leak
across organizations once RLS is on.

Because this touches the live schema and can hide all rows if mis-sequenced, it
is shipped as **operator-applied SQL** (not an auto-run migration) and is
**reviewed but not executed** in the environment it was authored in — apply and
verify it against your own database.

## Pieces

| File | What it does | Safe to apply alone? |
|------|--------------|----------------------|
| `01-schema.sql` | `tenants` registry + `tenant_id TEXT NOT NULL DEFAULT 'default'` on the 15 per-org data tables, backfilled to `default`. Additive, idempotent. | **Yes** — changes no behavior by itself. |
| `02-enable-rls.sql` | Enables + `FORCE`s RLS and installs the `tenant_isolation` policy on those tables. | **Only after the two prerequisites below.** |
| `../../server/tenantContext.js` | `withTenantContext(client, tenantId, fn)` — sets `app.tenant_id` (parameterized, transaction-scoped) so RLS sees the right tenant. Unit-tested. | app helper |

## Rollout order

1. **Apply the schema** (safe anytime):
   ```bash
   psql "$SUPERUSER_DATABASE_URL" -f db/tenancy/01-schema.sql
   ```
2. **Switch the app to non-superuser DB roles.** RLS is a **no-op for a superuser
   or a BYPASSRLS role**, so the web/poller/slicer services must connect as the
   least-privilege roles from [`../roles/least-privilege-roles.sql`](../roles/least-privilege-roles.sql)
   (`pf_web`/`pf_poller`/`pf_slicer`). Without this, `02-enable-rls.sql` appears to
   do nothing.
3. **Wire the tenant context into the query path.** Every request that reads/writes
   a tenant-scoped table must run inside `withTenantContext(client, session.tenantId, …)`
   so `app.tenant_id` is set. Until this is done, enabling RLS returns **empty
   results** for un-wired paths (fail-closed). Roll out behind a smoke test.
4. **Enable RLS:**
   ```bash
   psql "$SUPERUSER_DATABASE_URL" -f db/tenancy/02-enable-rls.sql
   ```

## Verify (run against your DB)

```sql
-- as a tenant, only that tenant's rows are visible:
SELECT set_config('app.tenant_id', 'default', false);
SELECT count(*) FROM printers;                 -- default's printers
SELECT set_config('app.tenant_id', 'other', false);
SELECT count(*) FROM printers;                 -- 0 (isolated)
SELECT set_config('app.tenant_id', '*', false);
SELECT count(*) FROM printers;                 -- all (cross-tenant / super_admin)
-- a write into the wrong tenant is rejected by WITH CHECK:
SELECT set_config('app.tenant_id', 'default', false);
INSERT INTO printers (id, name, tenant_id) VALUES ('x','x','other');  -- ERROR
```
(Run these as the **non-superuser** app role — a superuser bypasses RLS.)

## Still to do (phase 3 — needs product decisions + a DB)

- **Sessions & staff users carry a tenant.** Staff users, the admin credential,
  and branding currently live in `app_settings` (global key-value), not a table.
  Multi-tenant needs those keyed per tenant and the session to carry `tenantId`
  (then `authorizeFrontendApi` passes it to `withTenantContext`). `server/rbac.js`
  already models `super_admin` + `sameTenant`/`canAccessResource`.
- **Tenant management UI** (create/rename tenants, assign users) and tenant-scoped
  API keys.
- **Per-tenant `app_settings`** (branding/integrations) if orgs need distinct config.
- **Global tables review:** decide whether `poller_health` and any `app_settings`
  keys stay global (they currently do).

The application model (`server/rbac.js`) and the context helper
(`server/tenantContext.js`) are done and tested; this SQL is the schema + RLS to
pair with them once the phase-3 wiring lands.
