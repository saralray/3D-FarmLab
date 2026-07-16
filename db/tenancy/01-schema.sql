-- ============================================================================
-- PrintFarm multi-tenant schema scaffolding  (S-2 phase 2, step 1 of 2)
-- ============================================================================
--
-- Adds a `tenants` registry and a `tenant_id` column to every per-organization
-- data table, backfilling existing rows to the 'default' tenant. This is purely
-- ADDITIVE and backward-compatible: a single-tenant deployment keeps working
-- unchanged (everything lives under 'default'), and the column has a DEFAULT so
-- existing INSERTs that don't name it (e.g. the poller's printer upserts) still
-- succeed.
--
-- This step is SAFE to apply on its own and changes no behavior by itself —
-- isolation is not enforced until step 2 (02-enable-rls.sql) turns on RLS AND
-- the web app sets the per-request tenant via server/tenantContext.js. Apply as
-- the schema owner:
--
--   psql "$SUPERUSER_DATABASE_URL" -f db/tenancy/01-schema.sql
--
-- Idempotent — safe to re-run.
--
-- NOT tenant-scoped (intentionally global for now, see db/tenancy/README.md):
--   app_settings (holds staff users, admin credential, branding — global),
--   poller_health (infra), schema_migrations, tenants.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The implicit tenant every existing row belongs to.
INSERT INTO tenants (id, name)
  VALUES ('default', 'Default')
  ON CONFLICT (id) DO NOTHING;

-- Add tenant_id (NOT NULL DEFAULT 'default') + a lookup index to every per-org
-- data table. ADD COLUMN IF NOT EXISTS + a constant default is a fast,
-- metadata-only change on Postgres 12+.
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
    -- Skip a table that doesn't exist yet (defensive; the baseline creates them).
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping % (does not exist)', t;
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT %L',
      t, 'default');
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)',
      t || '_tenant_id_idx', t);
  END LOOP;
END $$;

COMMIT;
