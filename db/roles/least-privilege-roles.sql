-- ============================================================================
-- PrintFarm — per-service least-privilege database roles  (S-4 / HP-9, §11.4)
-- ============================================================================
--
-- Today every service connects with the single superuser in DATABASE_URL. A
-- SQL-injection bug, a leaked connection string, or a compromised container in
-- ANY service therefore grants full read/write/DDL over the whole database
-- (credentials, sessions, audit logs, connection secrets included). This script
-- provisions a dedicated, minimally-privileged login role per service so a
-- compromise is bounded to what that service legitimately does.
--
-- Roles created (idempotent — safe to re-run):
--   pf_readonly  — SELECT on everything, nothing else. For BI/monitoring/ad-hoc.
--   pf_exporter  — identical read-only grant; the Prometheus exporter is pure
--                  read (it never writes and never creates schema — verified),
--                  so this is the safest, highest-value lock-down and the
--                  recommended first role to enable.
--   pf_poller    — SELECT everything + INSERT/UPDATE only the telemetry tables
--                  the Go poller actually writes, + DELETE only on
--                  filament_station_assignments. No access to users/sessions/
--                  slicer_api_keys/audit beyond SELECT. (Grants derived from the
--                  poller's real query set.)
--   pf_slicer    — SELECT everything + INSERT audit_logs/slicer_print_estimates
--                  + UPDATE slicer_api_keys/slicer_print_estimates. (Derived from
--                  slicer-proxy's imported postgres.js helpers.)
--
-- Privilege grants cover BOTH already-existing tables AND, via ALTER DEFAULT
-- PRIVILEGES, tables the owner creates later — so a new table added by a future
-- migration inherits the right grant automatically and no service silently
-- loses access.
--
-- ── HOW TO APPLY ────────────────────────────────────────────────────────────
-- Pass each role's password as a psql variable (do NOT hard-code secrets here):
--
--   psql "$SUPERUSER_DATABASE_URL" \
--     -v pf_readonly_pw="$PF_READONLY_DB_PASSWORD" \
--     -v pf_exporter_pw="$PF_EXPORTER_DB_PASSWORD" \
--     -v pf_poller_pw="$PF_POLLER_DB_PASSWORD" \
--     -v pf_slicer_pw="$PF_SLICER_DB_PASSWORD" \
--     -f db/roles/least-privilege-roles.sql
--
-- Then point each service's DATABASE_URL at its role, e.g.
--   EXPORTER_DATABASE_URL=postgresql://pf_exporter:$PF_EXPORTER_DB_PASSWORD@db:5432/$POSTGRES_DB
-- (see docker-compose.yml comments and .env.example).
--
-- ── VERIFICATION STATUS ─────────────────────────────────────────────────────
--   pf_readonly / pf_exporter : safe to enable now. Read-only semantics are
--       standard Postgres; the exporter creates no schema.
--   pf_poller / pf_slicer     : grants are derived from the current source, but
--       ENABLE ONLY AFTER a smoke test in a real environment — the Go poller and
--       the Node slicer-proxy each run CREATE TABLE IF NOT EXISTS at startup, so
--       confirm they boot cleanly against their reduced role (the tables already
--       exist, created by web-as-owner, so the IF-NOT-EXISTS should no-op — but
--       verify, since a missing write grant surfaces only at runtime).
-- ============================================================================

\set ON_ERROR_STOP on

-- Default any password variable the caller did NOT pass with -v to an empty
-- string, so referencing :'var' never aborts the script and an unsupplied role
-- is simply skipped below. (:{?var} tests whether the variable is defined.)
\if :{?pf_readonly_pw} \else \set pf_readonly_pw '' \endif
\if :{?pf_exporter_pw} \else \set pf_exporter_pw '' \endif
\if :{?pf_poller_pw}   \else \set pf_poller_pw   '' \endif
\if :{?pf_slicer_pw}   \else \set pf_slicer_pw   '' \endif

-- Create a LOGIN role if absent and (re)set its password from the psql var.
-- Uses format(%I,%L) so identifiers/literals are quoted by Postgres itself — no
-- injection even if a password contains quotes. Skips a role whose password var
-- was not supplied (":varname" stays literal when unset → treated as "skip").
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('pf_readonly', :'pf_readonly_pw'),
      ('pf_exporter', :'pf_exporter_pw'),
      ('pf_poller',   :'pf_poller_pw'),
      ('pf_slicer',   :'pf_slicer_pw')
    ) AS v(role, pw)
  LOOP
    -- An unset psql variable renders as the literal ":varname"; skip those so a
    -- partial rollout only touches the roles you actually supplied a password for.
    CONTINUE WHEN r.pw IS NULL OR r.pw = '' OR left(r.pw, 1) = ':';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r.role);
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', r.role, r.pw);
    -- Never let a service role create databases/roles or bypass RLS.
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r.role);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r.role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r.role);
  END LOOP;
END $$;

-- ── Read-only roles (pf_readonly, pf_exporter) ──────────────────────────────
-- Only apply grants to roles that exist (a role is absent when its password var
-- was not supplied). Each block is a no-op if the role wasn't created.
DO $$
DECLARE
  ro TEXT;
BEGIN
  FOREACH ro IN ARRAY ARRAY['pf_readonly','pf_exporter'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ro) THEN
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', ro);
      EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', ro);
      -- Future tables created by the current owner inherit SELECT automatically.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',
        current_user, ro);
    END IF;
  END LOOP;
END $$;

-- ── pf_poller: SELECT all + write only the telemetry tables it upserts ───────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pf_poller') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pf_poller;
    ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
      GRANT SELECT ON TABLES TO pf_poller;
    -- Write set (from go-services/cmd/poller): telemetry upserts only.
    GRANT INSERT, UPDATE ON
      printers, poller_health, slicer_print_estimates, filament_spools,
      filament_station_assignments, analytics_daily, maintenance_events
      TO pf_poller;
    -- The poller reaps stale station assignments; that is its only DELETE.
    GRANT DELETE ON filament_station_assignments TO pf_poller;
    -- Sequences backing any SERIAL/identity columns the writes touch.
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pf_poller;
  END IF;
END $$;

-- ── pf_slicer: SELECT all + the writes slicer-proxy performs ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pf_slicer') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pf_slicer;
    ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
      GRANT SELECT ON TABLES TO pf_slicer;
    -- recordAuditLog, recordSlicerPrintEstimate, touchSlicerApiKey.
    GRANT INSERT ON audit_logs, slicer_print_estimates TO pf_slicer;
    GRANT UPDATE ON slicer_api_keys, slicer_print_estimates TO pf_slicer;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pf_slicer;
  END IF;
END $$;

-- Belt-and-braces: never let PUBLIC (hence any new role) write by default.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
