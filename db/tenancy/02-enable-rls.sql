-- ============================================================================
-- PrintFarm multi-tenant Row-Level Security  (S-2 phase 2, step 2 of 2)
-- ============================================================================
--
-- Enables Postgres RLS so every per-org data table is confined to the tenant
-- named by the `app.tenant_id` GUC that the web app sets per request
-- (server/tenantContext.js → set_config('app.tenant_id', ...)). This is the
-- defense-in-depth layer BELOW the application authz (server/rbac.js): even a
-- SQL bug that forgets a `WHERE tenant_id = ...` cannot cross tenants.
--
-- ⚠️  DO NOT enable this until BOTH are true, or the app will see zero rows:
--   1. The web/slicer/poller services connect as a NON-SUPERUSER role WITHOUT
--      BYPASSRLS (i.e. the pf_web/pf_poller/pf_slicer roles from
--      db/roles/least-privilege-roles.sql). A superuser bypasses RLS entirely,
--      so RLS silently does nothing under the default single-superuser setup.
--   2. Every query path runs inside withTenantContext() so app.tenant_id is set.
--      When it is unset, current_setting('app.tenant_id', true) is NULL and the
--      policy matches no rows (fail-closed) — correct, but it means an un-wired
--      code path returns empty. Roll this out behind a smoke test.
--
-- The cross-tenant (super_admin) context is app.tenant_id = '*', which the policy
-- grants all rows for — set it only after an rbac TENANTS_ADMIN check.
--
-- Apply as the schema owner AFTER 01-schema.sql:
--   psql "$SUPERUSER_DATABASE_URL" -f db/tenancy/02-enable-rls.sql
-- Idempotent. To roll back, see the DISABLE block at the bottom (commented).
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  t TEXT;
  scoped TEXT[] := ARRAY[
    'printers', 'queue_jobs', 'analytics_daily', 'discord_webhooks',
    'slicer_api_keys', 'slicer_print_estimates', 'audit_logs', 'manager_requests',
    'sessions', 'maintenance_schedules', 'maintenance_events',
    'maintenance_notifications', 'network_usage_daily', 'filament_spools',
    'filament_station_assignments'
  ];
BEGIN
  FOREACH t IN ARRAY scoped LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping % (does not exist)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the table OWNER is subject to RLS too (the owner otherwise
    -- bypasses it). Combined with a non-superuser app role, this makes the
    -- policy actually bind.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.tenant_id', true) = '*'
          OR tenant_id = current_setting('app.tenant_id', true)
        )
        WITH CHECK (
          current_setting('app.tenant_id', true) = '*'
          OR tenant_id = current_setting('app.tenant_id', true)
        )
    $pol$, t);
  END LOOP;
END $$;

COMMIT;

-- ── Rollback (uncomment to disable RLS on every scoped table) ────────────────
-- DO $$
-- DECLARE t TEXT; scoped TEXT[] := ARRAY['printers','queue_jobs','analytics_daily',
--   'discord_webhooks','slicer_api_keys','slicer_print_estimates','audit_logs',
--   'manager_requests','sessions','maintenance_schedules','maintenance_events',
--   'maintenance_notifications','network_usage_daily','filament_spools',
--   'filament_station_assignments'];
-- BEGIN
--   FOREACH t IN ARRAY scoped LOOP
--     IF to_regclass('public.'||t) IS NULL THEN CONTINUE; END IF;
--     EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
--     EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--   END LOOP;
-- END $$;
