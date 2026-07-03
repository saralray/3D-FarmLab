import pg from 'pg';
import { decryptSecret, encryptSecret, isEncryptionEnabled } from './secretCrypto.js';

const { Pool } = pg;

// Printer connection secrets (the api_key_header LAN access code / API key) are
// encrypted at rest. SQL reads return the stored value; we decrypt it on the JS
// object before handing it to a caller, and encrypt it on the write path. When
// PRINTER_SECRET_KEY is unset these are no-ops (plaintext passthrough), so an
// existing deployment is unaffected until a key is provisioned.
function decryptPrinterSecrets(printer) {
  if (printer && typeof printer.apiKeyHeader === 'string' && printer.apiKeyHeader) {
    printer.apiKeyHeader = decryptSecret(printer.apiKeyHeader);
  }
  return printer;
}

const SCHEMA_SQL = `
SELECT pg_advisory_lock(90210);
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  profile TEXT NOT NULL,
  url TEXT NOT NULL,
  ip_address TEXT NOT NULL UNIQUE,
  api_key_header TEXT NOT NULL,
  serial TEXT,
  status TEXT NOT NULL,
  temperature_nozzle DOUBLE PRECISION NOT NULL DEFAULT 0,
  temperature_bed DOUBLE PRECISION NOT NULL DEFAULT 0,
  temperature_chamber DOUBLE PRECISION NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  last_maintenance TEXT NOT NULL,
  total_print_time DOUBLE PRECISION NOT NULL DEFAULT 0,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_job JSONB,
  nozzle_temperatures JSONB,
  spools JSONB,
  fan_speeds JSONB,
  offline_since DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE printers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS nozzle_temperatures JSONB;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS offline_since DOUBLE PRECISION;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS serial TEXT;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS light_on BOOLEAN;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS nozzle_targets JSONB;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS bed_target DOUBLE PRECISION;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS fan_speeds JSONB;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS temperature_chamber DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS chamber_target DOUBLE PRECISION;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS air_filter_on BOOLEAN;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS error_message TEXT;
-- Preventive-maintenance accounting. total_print_hours is the printer's lifetime
-- accumulated print time (hours), current_nozzle_hours resets when the nozzle is
-- serviced, last_maintenance_at is the timestamp of the most recently completed
-- maintenance event, and health_score (0-100) is a rolling fitness figure the
-- 5-minute web worker recomputes. The poller accrues the hour columns when a job
-- finishes (finalize_job_analytics); the web side owns health_score.
ALTER TABLE printers ADD COLUMN IF NOT EXISTS total_print_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS current_nozzle_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS last_maintenance_at TIMESTAMPTZ;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS health_score INTEGER NOT NULL DEFAULT 100;
CREATE TABLE IF NOT EXISTS analytics_daily (
  analytics_date DATE PRIMARY KEY,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  print_time_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  filament_used_grams DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 1,
  stl_file_url TEXT,
  submitter_name TEXT,
  submitter_email TEXT,
  notes TEXT,
  submitted_at TIMESTAMPTZ,
  priority TEXT NOT NULL DEFAULT 'low',
  estimated_time INTEGER NOT NULL DEFAULT 0,
  form_type TEXT NOT NULL,
  printed_status INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS file_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT '';
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS printed_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- In-app print-request form: the uploaded model file is stored directly in the
-- DB (bytea) rather than as a Google Drive link, so the queue is self-contained.
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS file_content BYTEA;
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS file_mime TEXT;
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER NOT NULL DEFAULT 0;
-- Supports the queue/history reads, which filter on (form_type, printed_status)
-- among non-deleted rows. Partial index keeps it small and skips soft-deleted jobs.
CREATE INDEX IF NOT EXISTS queue_jobs_active_idx
  ON queue_jobs (form_type, printed_status)
  WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS discord_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-webhook event subscription. NULL means "all events enabled" (historical
-- behaviour); a JSON array of event keys restricts the webhook to those events.
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS events JSONB;
-- Master on/off switch per webhook. TRUE means notifications are sent (the
-- historical default); FALSE mutes the webhook entirely.
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- When TRUE, notifications are sent as Discord text-to-speech (tts=true with a
-- spoken content line); FALSE (default) sends a silent embed only.
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS tts BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS slicer_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-key permission scopes (array of scope strings). 'slicer_upload' lets the
-- key push prints through the slicer-proxy; 'printfarm_manage' grants the key
-- the programmatic /api/v1 data API. Legacy keys (created before scopes
-- existed) backfill to both so existing integrations keep working.
ALTER TABLE slicer_api_keys
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL
  DEFAULT '["slicer_upload","printfarm_manage"]'::jsonb;
-- Ephemeral keys minted for a logged-in slicer session carry the hash of the
-- session token that owns them. They are auto-deleted when that session logs out
-- or the slicer revokes them on exit; named admin keys leave this NULL.
ALTER TABLE slicer_api_keys
  ADD COLUMN IF NOT EXISTS session_token_hash TEXT;
-- Slicer-derived filament estimate per print. When a .3mf is uploaded through
-- the slicer-proxy we parse its Metadata/slice_info.config (plate weight =
-- grams) and store the job total here, keyed by printer + the subtask name the
-- print is started with. The poller reads it to show a real per-job filament
-- figure, since Bambu's MQTT report carries no filament weight and the H2-series
-- firmware blocks FTP file access (so the 3MF can't be fetched back off the printer).
CREATE TABLE IF NOT EXISTS slicer_print_estimates (
  printer_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  filament_grams DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (printer_id, job_name)
);
-- Audit trail: one row per staff/operator action (printer control, queue,
-- user/key/webhook management, logins) and per slicer-proxy API key use. The
-- actor identity travels from the client (auth is client-side); the source
-- column distinguishes web actions from slicer-proxy uploads. Connection
-- secrets are never written here, only descriptions of the action.
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_name TEXT,
  actor_username TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB,
  source TEXT NOT NULL DEFAULT 'web',
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC, id DESC);
-- Manager access requests: external tools/apps request a printfarm_manage API key.
-- Admin approves or denies in the notification bell / Settings → API Keys.
-- key_secret holds the plaintext key temporarily until the requester retrieves it
-- (one-time delivery via the status endpoint), then is cleared.
CREATE TABLE IF NOT EXISTS manager_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  api_key_id TEXT,
  key_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Server-side login sessions. The browser holds an opaque random token in an
-- HttpOnly cookie; only its sha256 hash is stored here, so a database leak can
-- never be replayed as a live session. Identity (username/name/role) is copied
-- in at issue time so authorization checks need a single indexed lookup and no
-- join. Rows are deleted on logout, on credential/role change (revocation), and
-- swept once expired. This is the server-enforced half of auth — the React role
-- state is presentation only.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
-- Poller liveness/lag, one row per shard, written each cycle by the poller (which
-- also defines this table) and read by the exporter. Defined here too so the
-- baseline owns every table the migrations below tune, regardless of start order.
CREATE TABLE IF NOT EXISTS poller_health (
  shard_index INTEGER PRIMARY KEY,
  shard_count INTEGER NOT NULL DEFAULT 1,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cycle_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  printers_polled INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  refresh_failures INTEGER NOT NULL DEFAULT 0
);
-- Bytes to/from the printers themselves the shard's last cycle (HTTP polling,
-- Bambu MQTT, Bambu FTP — see go-services/cmd/poller/netbytes.go).
ALTER TABLE poller_health ADD COLUMN IF NOT EXISTS bytes_out BIGINT NOT NULL DEFAULT 0;
ALTER TABLE poller_health ADD COLUMN IF NOT EXISTS bytes_in BIGINT NOT NULL DEFAULT 0;
-- Preventive maintenance: per-printer service schedules. Each printer is seeded
-- (seedMaintenanceSchedules) with a set of interval-based tasks derived from the
-- global default-intervals app_setting. interval_hours is the print-hour cadence
-- at which the task recurs; enabled lets an operator silence a task without
-- deleting it. The unique key makes seeding/backfill idempotent.
CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  printer_id TEXT NOT NULL,
  maintenance_type TEXT NOT NULL,
  interval_hours DOUBLE PRECISION NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS maintenance_schedules_printer_idx
  ON maintenance_schedules (printer_id);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_schedules_unique_idx
  ON maintenance_schedules (printer_id, maintenance_type, interval_hours);
-- One generated maintenance task. A pending event is created when total_print_hours
-- crosses an interval multiple; status moves to 'completed' when an operator marks
-- it done. triggered_at_hours is the printer's total hours at creation;
-- completed_at_hours the hours at completion. The PARTIAL UNIQUE INDEX below is the
-- authoritative "no duplicate pending events" guard — a second create for the same
-- (printer, type, interval) while one is still pending is a no-op (ON CONFLICT).
CREATE TABLE IF NOT EXISTS maintenance_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  printer_id TEXT NOT NULL,
  maintenance_type TEXT NOT NULL,
  interval_hours DOUBLE PRECISION,
  triggered_at_hours DOUBLE PRECISION,
  completed_at_hours DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_events_pending_unique_idx
  ON maintenance_events (printer_id, maintenance_type, interval_hours)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS maintenance_events_printer_status_idx
  ON maintenance_events (printer_id, status);
CREATE INDEX IF NOT EXISTS maintenance_events_status_created_idx
  ON maintenance_events (status, created_at DESC);
-- In-app maintenance notifications surfaced in the NotificationBell. kind is one of
-- 'due' | 'overdue' | 'health' (level derives from it in the UI). The partial unique
-- index keeps at most one unread row per (printer, kind) so the worker can re-run
-- every 5 minutes without spamming duplicates while a condition persists.
CREATE TABLE IF NOT EXISTS maintenance_notifications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  printer_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS maintenance_notifications_unread_idx
  ON maintenance_notifications (read, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_notifications_open_unique_idx
  ON maintenance_notifications (printer_id, kind)
  WHERE read = FALSE;
-- Daily response-byte/request rollups by route class (see server/metrics.js
-- classifyRoute), fed by a periodic in-process flush so the Network Usage page
-- has history that survives a web-container restart. bytes are approximate —
-- measured at the app layer (Node writing response chunks), not including TLS/
-- HTTP framing overhead or any nginx-only traffic (e.g. the Prometheus UI).
CREATE TABLE IF NOT EXISTS network_usage_daily (
  usage_date DATE NOT NULL,
  route TEXT NOT NULL,
  bytes BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usage_date, route)
);
-- 'bytes' above is outbound (response) traffic. Added after the initial
-- release once inbound (request/upload) tracking was added; kept as a
-- separate column rather than renaming 'bytes' so existing rows don't need a
-- backfill.
ALTER TABLE network_usage_daily ADD COLUMN IF NOT EXISTS bytes_in BIGINT NOT NULL DEFAULT 0;
-- Versioned migrations applied after this idempotent baseline (see MIGRATIONS).
-- This baseline schema is the forward-only "version 0"; ordered migrations record
-- their version here so each runs exactly once and the DB's schema level is visible.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT pg_advisory_unlock(90210);
`;

// Ordered, versioned migrations applied once each, after the idempotent baseline
// schema above. Use this for changes that benefit from ordering/visibility or
// that aren't naturally expressible as CREATE/ALTER ... IF NOT EXISTS (data
// backfills, type changes, storage tuning). Each migration's SQL must be safe to
// run inside a single transaction. Append new migrations with the next version;
// never edit or renumber an applied one.
const MIGRATIONS = [
  {
    version: 1,
    name: 'autovacuum-tuning-high-churn-tables',
    // printers is updated on telemetry change, queue_jobs churns large bytea
    // blobs (insert / soft-delete / printed updates), sessions churns on
    // login/logout/expiry, and poller_health is updated every poll cycle. Make
    // autovacuum/analyze trigger well before the 20% default so dead tuples and
    // bloat are reclaimed instead of accumulating under sustained write load.
    sql: `
      ALTER TABLE printers SET (
        autovacuum_vacuum_scale_factor = 0.05,
        autovacuum_analyze_scale_factor = 0.05
      );
      ALTER TABLE queue_jobs SET (
        autovacuum_vacuum_scale_factor = 0.05,
        autovacuum_analyze_scale_factor = 0.05,
        toast.autovacuum_vacuum_scale_factor = 0.05
      );
      ALTER TABLE sessions SET (
        autovacuum_vacuum_scale_factor = 0.05
      );
      ALTER TABLE poller_health SET (
        autovacuum_vacuum_scale_factor = 0,
        autovacuum_vacuum_threshold = 25
      );
    `,
  },
  {
    version: 2,
    name: 'queue-jobs-photo-columns',
    sql: `
      ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS photo_content BYTEA;
      ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS photo_mime TEXT;
    `,
  },
  {
    version: 3,
    name: 'maintenance-events-notified-kind',
    // Tracks the last notification kind ('due' | 'overdue') raised for each pending
    // maintenance event so the 5-minute worker alerts once per task (escalating to
    // 'overdue' once) instead of re-toasting every pass. A completed task's next
    // routine is a fresh row with NULL notified_kind, so it alerts again.
    sql: `
      ALTER TABLE maintenance_events ADD COLUMN IF NOT EXISTS notified_kind TEXT;
    `,
  },
];

// Advisory lock id for the migration run (distinct from the baseline's 90210), so
// concurrent web/slicer-proxy startups serialize on a single dedicated connection
// rather than racing the same migration.
const MIGRATION_LOCK_ID = 90211;

async function runMigrations() {
  const client = await getPool().connect();
  try {
    // Session-scoped advisory lock must live on one connection for the whole run,
    // hence a dedicated client rather than the pooled query() helper.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
        console.log(`[migrate] applied #${migration.version} ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

const QUEUE_FORM_TYPE = 'สั่งพิมพ์งาน 3D Print';

let pool;

// Read a non-negative integer env var, falling back when unset/invalid.
function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// The pool is created lazily so importing this module never fails when
// DATABASE_URL is absent; the connection is only needed once a query runs.
// Pool size and the safety timeouts are env-tunable so a deployment can size the
// pool to its web-replica count and Postgres max_connections. The timeouts are
// real production guards: statement_timeout caps a runaway query rather than
// letting it pin a pooled connection forever; idle_in_transaction_session_timeout
// reaps a connection left mid-transaction (e.g. after an error path) so it can't
// hold locks; keepAlive lets a dead TCP connection (DB restart/failover) be
// detected and replaced instead of hanging. Set a timeout to 0 to disable it.
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }

    pool = new Pool({
      connectionString,
      max: intFromEnv('DATABASE_POOL_MAX', 10),
      idleTimeoutMillis: intFromEnv('DATABASE_POOL_IDLE_MS', 30000),
      connectionTimeoutMillis: intFromEnv('DATABASE_CONNECT_TIMEOUT_MS', 5000),
      // Generous default so the schema/migration advisory-lock wait at startup
      // (web + slicer-proxy contending) is never killed, while still bounding a
      // genuinely runaway query.
      statement_timeout: intFromEnv('DATABASE_STATEMENT_TIMEOUT_MS', 30000),
      idle_in_transaction_session_timeout: intFromEnv('DATABASE_IDLE_TX_TIMEOUT_MS', 60000),
      keepAlive: true,
    });

    // Without a listener, an error on an idle pooled client crashes the
    // process. Log it instead and let the pool replace the client.
    pool.on('error', (error) => {
      console.error('Unexpected PostgreSQL pool error', error);
    });
  }

  return pool;
}

// All queries are parameterized: values travel via `params` ($1, $2, ...),
// never string-interpolated into SQL.
function query(text, params) {
  return getPool().query(text, params);
}

function isPublicViewerMode() {
  return process.env.VITE_PUBLIC_VIEWER_MODE === 'true';
}

// Cheap connectivity check for the readiness probe. Runs a trivial query through
// the pool so it exercises connect + round-trip (bounded by the pool's connect /
// statement timeouts). Throws on failure so the caller can report "not ready".
export async function pingDatabase() {
  await query('SELECT 1;');
}

function buildPrinterListSelect(includeSensitive = true) {
  return `
    json_build_object(
      'id', id,
      'name', name,
      'model', model,
      'sortOrder', sort_order,
      'profile', profile,
      'url', ${includeSensitive ? 'url' : "''"},
      'ipAddress', ${includeSensitive ? 'ip_address' : "''"},
      'apiKeyHeader', ${includeSensitive ? 'api_key_header' : "''"},
      'serial', ${includeSensitive ? 'serial' : "''"},
      'status', status,
      'temperature', json_build_object(
        'nozzle', ROUND(temperature_nozzle::numeric, 2),
        'bed', ROUND(temperature_bed::numeric, 2),
        'chamber', ROUND(temperature_chamber::numeric, 2)
      ),
      'progress', progress,
      'lastMaintenance', last_maintenance,
      'totalPrintTime', ROUND(total_print_time::numeric, 2),
      'successRate', ROUND(success_rate::numeric, 2),
      'currentJob', current_job,
      'nozzleTemperatures', nozzle_temperatures,
      'nozzleTargets', nozzle_targets,
      'bedTarget', ROUND(bed_target::numeric, 2),
      'chamberTarget', ROUND(chamber_target::numeric, 2),
      'spools', spools,
      'fanSpeeds', fan_speeds,
      'lightOn', light_on,
      'airFilterOn', air_filter_on,
      'errorMessage', error_message,
      'totalPrintHours', ROUND(total_print_hours::numeric, 2),
      'currentNozzleHours', ROUND(current_nozzle_hours::numeric, 2),
      'healthScore', health_score,
      'lastMaintenanceAt', last_maintenance_at
    )
  `;
}

let schemaReadyPromise;

export async function ensureSchema() {
  if (!schemaReadyPromise) {
    // Baseline (idempotent) first, then the ordered versioned migrations. Reset
    // the memo on failure so a transient error doesn't permanently wedge schema
    // setup for the process.
    schemaReadyPromise = query(SCHEMA_SQL)
      .then(() => runMigrations())
      .catch((error) => {
        schemaReadyPromise = undefined;
        throw error;
      });
  }

  await schemaReadyPromise;
}

export async function listPrinters(forceSensitive = false) {
  await ensureSchema();
  const includeSensitive = forceSensitive || !isPublicViewerMode();

  const result = await query(`
    SELECT COALESCE(
      json_agg(
        ${buildPrinterListSelect(includeSensitive)}
        ORDER BY sort_order ASC, created_at DESC
      ),
      '[]'::json
    ) AS data
    FROM printers;
  `);

  const printers = result.rows[0].data;
  // Redacted lists carry '' for apiKeyHeader, so decrypt is a no-op there.
  if (includeSensitive && Array.isArray(printers)) {
    printers.forEach(decryptPrinterSecrets);
  }
  return printers;
}

// Always-redacted printer list for non-privileged (anonymous / viewer / student)
// callers. Unlike listPrinters(), which only redacts in PUBLIC_VIEWER_MODE, this
// forces redaction regardless of mode, so connection secrets (IP, API key,
// serial, url) never reach a session that isn't operator/admin.
export async function listPrintersRedacted() {
  await ensureSchema();
  const result = await query(`
    SELECT COALESCE(
      json_agg(
        ${buildPrinterListSelect(false)}
        ORDER BY sort_order ASC, created_at DESC
      ),
      '[]'::json
    ) AS data
    FROM printers;
  `);

  return result.rows[0].data;
}

// Always-redacted single-printer read, the per-id counterpart to
// listPrintersRedacted (used for non-privileged GET /api/printers/:id).
export async function getRedactedPrinterById(id) {
  await ensureSchema();
  const result = await query(
    `SELECT ${buildPrinterListSelect(false)} AS printer FROM printers WHERE id = $1;`,
    [id],
  );
  return result.rows[0]?.printer ?? null;
}

export async function getPrinterById(id) {
  await ensureSchema();

  const result = await query(
    `
    SELECT json_build_object(
      'id', id,
      'name', name,
      'model', model,
      'sortOrder', sort_order,
      'profile', profile,
      'url', url,
      'ipAddress', ip_address,
      'apiKeyHeader', api_key_header,
      'serial', serial,
      'status', status,
      'temperature', json_build_object(
        'nozzle', ROUND(temperature_nozzle::numeric, 2),
        'bed', ROUND(temperature_bed::numeric, 2),
        'chamber', ROUND(temperature_chamber::numeric, 2)
      ),
      'progress', progress,
      'lastMaintenance', last_maintenance,
      'totalPrintTime', ROUND(total_print_time::numeric, 2),
      'successRate', ROUND(success_rate::numeric, 2),
      'currentJob', current_job,
      'nozzleTemperatures', nozzle_temperatures,
      'nozzleTargets', nozzle_targets,
      'bedTarget', ROUND(bed_target::numeric, 2),
      'chamberTarget', ROUND(chamber_target::numeric, 2),
      'spools', spools,
      'fanSpeeds', fan_speeds,
      'lightOn', light_on,
      'airFilterOn', air_filter_on,
      'errorMessage', error_message,
      'totalPrintHours', ROUND(total_print_hours::numeric, 2),
      'currentNozzleHours', ROUND(current_nozzle_hours::numeric, 2),
      'healthScore', health_score,
      'lastMaintenanceAt', last_maintenance_at
    ) AS printer
    FROM printers
    WHERE id = $1;
  `,
    [id],
  );

  return decryptPrinterSecrets(result.rows[0]?.printer ?? null);
}

// Resolve a printer by its id or, failing that, its (case-insensitive) name —
// used by the friendly /webcam/<name> stream URL. Returns the same full record
// as getPrinterById (connection details included) so the proxy can reach the
// camera. An exact id match wins over a name match.
export async function getPrinterByIdOrName(identifier) {
  await ensureSchema();

  const result = await query(
    `
    SELECT id FROM printers
    WHERE id = $1 OR lower(name) = lower($1)
    ORDER BY (id = $1) DESC
    LIMIT 1;
  `,
    [identifier],
  );

  const id = result.rows[0]?.id;
  return id ? getPrinterById(id) : null;
}

// Public-facing single-printer read for the API. Unlike getPrinterById (which
// always returns the connection secrets the proxy/command paths need), this
// redacts sensitive fields in public viewer mode, matching listPrinters.
export async function getPublicPrinterById(id) {
  await ensureSchema();
  const includeSensitive = !isPublicViewerMode();

  const result = await query(
    `SELECT ${buildPrinterListSelect(includeSensitive)} AS printer FROM printers WHERE id = $1;`,
    [id],
  );

  const printer = result.rows[0]?.printer ?? null;
  return includeSensitive ? decryptPrinterSecrets(printer) : printer;
}

export async function upsertPrinter(printer) {
  await ensureSchema();

  // Encrypt the connection secret at rest (no-op when PRINTER_SECRET_KEY is
  // unset). Copy rather than mutate the caller's object.
  const stored = { ...printer, apiKeyHeader: encryptSecret(printer.apiKeyHeader) };

  await query(
    `
    WITH input AS (
      SELECT $1::jsonb AS data
    )
    INSERT INTO printers (
      id,
      name,
      model,
      sort_order,
      profile,
      url,
      ip_address,
      api_key_header,
      serial,
      status,
      temperature_nozzle,
      temperature_bed,
      progress,
      last_maintenance,
      total_print_time,
      success_rate,
      total_print_hours,
      current_nozzle_hours,
      current_job,
      nozzle_temperatures,
      spools,
      offline_since
    )
    SELECT
      data->>'id',
      data->>'name',
      data->>'model',
      COALESCE((data->>'sortOrder')::integer, 0),
      data->>'profile',
      data->>'url',
      data->>'ipAddress',
      data->>'apiKeyHeader',
      data->>'serial',
      data->>'status',
      COALESCE((data->'temperature'->>'nozzle')::double precision, 0),
      COALESCE((data->'temperature'->>'bed')::double precision, 0),
      COALESCE((data->>'progress')::integer, 0),
      data->>'lastMaintenance',
      COALESCE((data->>'totalPrintTime')::double precision, 0),
      COALESCE((data->>'successRate')::double precision, 0),
      -- Optional seed for an already-used printer's maintenance clock. Honored on
      -- INSERT only (see the ON CONFLICT note below); defaults to 0 for a new
      -- machine or a payload that omits them.
      COALESCE((data->>'totalPrintHours')::double precision, 0),
      COALESCE((data->>'currentNozzleHours')::double precision, 0),
      data->'currentJob',
      data->'nozzleTemperatures',
      data->'spools',
      (data->>'offlineSince')::double precision
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      -- This INSERT path is the web API's only writer (admin create/edit, dashboard
      -- reorder). It updates configuration fields only. Live telemetry — status,
      -- temperatures, progress, success_rate, current_job, nozzle_temperatures,
      -- spools, offline_since, total_print_time — is owned by the poller and is
      -- deliberately NOT overwritten here: the browser's payload can be several
      -- seconds stale (or API-rounded), so writing it back would clobber the
      -- poller's fresh values and flicker the UI until the next poll corrects it.
      -- total_print_hours / current_nozzle_hours are likewise omitted here: they
      -- are seeded only on the create path (an admin recording an already-used
      -- printer's starting hours) and are otherwise accrued by the poller, so an
      -- edit/reorder must not reset them.
      name = EXCLUDED.name,
      model = EXCLUDED.model,
      sort_order = EXCLUDED.sort_order,
      profile = EXCLUDED.profile,
      url = EXCLUDED.url,
      ip_address = EXCLUDED.ip_address,
      api_key_header = EXCLUDED.api_key_header,
      serial = EXCLUDED.serial,
      last_maintenance = EXCLUDED.last_maintenance;
  `,
    [JSON.stringify(stored)],
  );

  // Ensure the printer has its preventive-maintenance schedules (idempotent; the
  // unique index makes a repeat a no-op). Best-effort: a seeding failure must not
  // block creating/editing the printer.
  if (printer?.id) {
    await seedMaintenanceSchedules(printer.id).catch(() => {});
  }
}

export async function deletePrinter(id) {
  await ensureSchema();
  await query('DELETE FROM printers WHERE id = $1;', [id]);
}

// One-time migration: encrypt any printer api_key_header still stored in
// plaintext, once a PRINTER_SECRET_KEY is configured. No-op when encryption is
// disabled or every row is already encrypted, so it is safe to run on every boot.
// (The poller would also re-encrypt each row on its next write, but this covers a
// web-only deployment and closes the window immediately.) Returns the row count.
export async function encryptPlaintextPrinterSecrets() {
  await ensureSchema();
  if (!isEncryptionEnabled()) {
    return 0;
  }
  const result = await query(
    `SELECT id, api_key_header FROM printers
     WHERE api_key_header <> '' AND api_key_header NOT LIKE 'enc:v1:%';`,
  );
  for (const row of result.rows) {
    await query('UPDATE printers SET api_key_header = $2 WHERE id = $1;', [
      row.id,
      encryptSecret(row.api_key_header),
    ]);
  }
  return result.rows.length;
}

export async function listDailyAnalytics(days = 7) {
  await ensureSchema();

  const result = await query(
    `
    WITH dates AS (
      SELECT generate_series(
        CURRENT_DATE - (($1::integer - 1) * INTERVAL '1 day'),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS analytics_date
    )
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'date', to_char(d.analytics_date, 'YYYY-MM-DD'),
          'completedJobs', COALESCE(a.completed_jobs, 0),
          'failedJobs', COALESCE(a.failed_jobs, 0),
          'printTime', ROUND(COALESCE(a.print_time_hours, 0)::numeric, 2),
          'filamentUsed', ROUND(COALESCE(a.filament_used_grams, 0)::numeric, 0)
        )
        ORDER BY d.analytics_date ASC
      ),
      '[]'::json
    ) AS data
    FROM dates d
    LEFT JOIN analytics_daily a
      ON a.analytics_date = d.analytics_date;
  `,
    [Number(days)],
  );

  return result.rows[0].data;
}

export async function resetDailyAnalytics() {
  await ensureSchema();
  await query('TRUNCATE TABLE analytics_daily;');
}

// Applies in-process byte/request deltas (see server/app.js's periodic flush
// worker) to today's row per route. Deltas are additive, so a flush that
// double-runs or races another instance is harmless.
export async function upsertNetworkUsageDaily(deltas) {
  if (!Array.isArray(deltas) || deltas.length === 0) {
    return;
  }
  await ensureSchema();
  for (const { route, bytesOut, bytesIn, requests } of deltas) {
    await query(
      `
      INSERT INTO network_usage_daily (usage_date, route, bytes, bytes_in, requests, updated_at)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, NOW())
      ON CONFLICT (usage_date, route) DO UPDATE SET
        bytes = network_usage_daily.bytes + EXCLUDED.bytes,
        bytes_in = network_usage_daily.bytes_in + EXCLUDED.bytes_in,
        requests = network_usage_daily.requests + EXCLUDED.requests,
        updated_at = NOW();
    `,
      [route, bytesOut, bytesIn, requests],
    );
  }
}

export async function listNetworkUsageDaily(days = 30) {
  await ensureSchema();

  const result = await query(
    `
    WITH dates AS (
      SELECT generate_series(
        CURRENT_DATE - (($1::integer - 1) * INTERVAL '1 day'),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS usage_date
    ),
    totals AS (
      SELECT usage_date, SUM(bytes) AS bytes_out, SUM(bytes_in) AS bytes_in, SUM(requests) AS requests
      FROM network_usage_daily
      GROUP BY usage_date
    )
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'date', to_char(d.usage_date, 'YYYY-MM-DD'),
          'bytesOut', COALESCE(t.bytes_out, 0),
          'bytesIn', COALESCE(t.bytes_in, 0),
          'requests', COALESCE(t.requests, 0)
        )
        ORDER BY d.usage_date ASC
      ),
      '[]'::json
    ) AS data
    FROM dates d
    LEFT JOIN totals t ON t.usage_date = d.usage_date;
  `,
    [Number(days)],
  );

  return result.rows[0].data;
}

export async function getNetworkUsageByRoute(days = 30) {
  await ensureSchema();

  const result = await query(
    `
    SELECT route, SUM(bytes)::bigint AS bytes_out, SUM(bytes_in)::bigint AS bytes_in, SUM(requests)::bigint AS requests
    FROM network_usage_daily
    WHERE usage_date >= CURRENT_DATE - (($1::integer - 1) * INTERVAL '1 day')
    GROUP BY route
    ORDER BY bytes_out DESC;
  `,
    [Number(days)],
  );

  return result.rows.map((row) => ({
    route: row.route,
    bytesOut: Number(row.bytes_out),
    bytesIn: Number(row.bytes_in),
    requests: Number(row.requests),
  }));
}

function toUsageTotal(row) {
  return {
    bytesOut: Number(row.bytes_out),
    bytesIn: Number(row.bytes_in),
    requests: Number(row.requests),
  };
}

export async function getNetworkUsageToday() {
  await ensureSchema();
  const result = await query(`
    SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes_out,
           COALESCE(SUM(bytes_in), 0)::bigint AS bytes_in,
           COALESCE(SUM(requests), 0)::bigint AS requests
    FROM network_usage_daily
    WHERE usage_date = CURRENT_DATE;
  `);
  return toUsageTotal(result.rows[0]);
}

export async function getNetworkUsageMonthToDate() {
  await ensureSchema();
  const result = await query(`
    SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes_out,
           COALESCE(SUM(bytes_in), 0)::bigint AS bytes_in,
           COALESCE(SUM(requests), 0)::bigint AS requests
    FROM network_usage_daily
    WHERE usage_date >= date_trunc('month', CURRENT_DATE)::date;
  `);
  return toUsageTotal(result.rows[0]);
}

// The poller's own traffic to/from the printers (HTTP polling, Bambu
// MQTT/FTP) — distinct from the network_usage_daily reads above, which are
// the web tier's traffic to browsers/clients. One row per shard, overwritten
// each poll cycle (no history — "last cycle" only, like the table's other
// columns), so unlike network_usage_daily there's no daily rollup to show.
export async function getPollerHealth() {
  await ensureSchema();
  const result = await query(`
    SELECT shard_index, shard_count,
           EXTRACT(EPOCH FROM last_run_at) * 1000 AS last_run_at_ms,
           cycle_duration_ms, printers_polled, rows_written, refresh_failures,
           bytes_out, bytes_in
    FROM poller_health
    ORDER BY shard_index ASC;
  `);
  return result.rows.map((row) => ({
    shard: row.shard_index,
    shardCount: row.shard_count,
    lastRunAt: new Date(Number(row.last_run_at_ms)).toISOString(),
    cycleDurationMs: Number(row.cycle_duration_ms),
    printersPolled: row.printers_polled,
    rowsWritten: row.rows_written,
    refreshFailures: row.refresh_failures,
    bytesOut: Number(row.bytes_out),
    bytesIn: Number(row.bytes_in),
  }));
}

export async function upsertQueueJobs(jobs) {
  await ensureSchema();

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }

  const result = await query(
    `
    WITH input AS (
      SELECT jsonb_array_elements($1::jsonb) AS data
    ),
    normalized AS (
      SELECT
        data->>'id' AS id,
        COALESCE(data->>'filename', '') AS filename,
        COALESCE((data->>'fileCount')::integer, 1) AS file_count,
        NULLIF(data->>'stlFileUrl', '') AS stl_file_url,
        NULLIF(data->>'submitterName', '') AS submitter_name,
        NULLIF(data->>'submitterEmail', '') AS submitter_email,
        NULLIF(data->>'notes', '') AS notes,
        CASE
          WHEN COALESCE(data->>'submittedAt', '') = '' THEN NULL
          ELSE (data->>'submittedAt')::timestamptz
        END AS submitted_at,
        COALESCE(data->>'priority', 'low') AS priority,
        COALESCE((data->>'estimatedTime')::integer, 0) AS estimated_time,
        COALESCE(data->>'formType', '') AS form_type,
        COALESCE((data->>'printedStatus')::integer, 0) AS printed_status
      FROM input
    ),
    existing AS (
      SELECT id
      FROM queue_jobs
      WHERE id IN (SELECT id FROM normalized)
    ),
    upserted AS (
    INSERT INTO queue_jobs (
      id,
      filename,
      file_count,
      stl_file_url,
      submitter_name,
      submitter_email,
      notes,
      submitted_at,
      priority,
      estimated_time,
      form_type,
      printed_status
    )
    SELECT
      id,
      filename,
      file_count,
      stl_file_url,
      submitter_name,
      submitter_email,
      notes,
      submitted_at,
      priority,
      estimated_time,
      form_type,
      printed_status
    FROM normalized
    ON CONFLICT (id) DO UPDATE SET
      filename = EXCLUDED.filename,
      file_count = EXCLUDED.file_count,
      stl_file_url = EXCLUDED.stl_file_url,
      submitter_name = EXCLUDED.submitter_name,
      submitter_email = EXCLUDED.submitter_email,
      notes = EXCLUDED.notes,
      submitted_at = EXCLUDED.submitted_at,
      priority = EXCLUDED.priority,
      estimated_time = EXCLUDED.estimated_time,
      form_type = EXCLUDED.form_type,
      updated_at = NOW()
    RETURNING
      id,
      filename,
      file_count,
      stl_file_url,
      submitter_name,
      submitter_email,
      notes,
      submitted_at,
      priority,
      estimated_time,
      form_type,
      printed_status
    )
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'filename', filename,
          'fileCount', file_count,
          'printedStatus', printed_status,
          'status', CASE WHEN printed_status = 1 THEN 'completed' ELSE 'queued' END,
          'progress', 0,
          'estimatedTime', estimated_time,
          'timeRemaining', estimated_time,
          'filamentUsed', 0,
          'priority', priority,
          'stlFileUrl', stl_file_url,
          'submitterName', submitter_name,
          'submitterEmail', submitter_email,
          'notes', notes,
          'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
        )
        ORDER BY submitted_at ASC NULLS LAST
      ),
      '[]'::json
    ) AS data
    FROM upserted
    WHERE id NOT IN (SELECT id FROM existing);
  `,
    [JSON.stringify(jobs)],
  );

  return result.rows[0].data;
}

// ── Login sessions ───────────────────────────────────────────────────────────

// Store a freshly issued session. `tokenHash` is sha256(token); the plaintext
// token only ever lives in the client's HttpOnly cookie.
export async function createSession({ tokenHash, userId, username, name, role, expiresAt, ip }) {
  await ensureSchema();
  await query(
    `INSERT INTO sessions (token_hash, user_id, username, name, role, expires_at, created_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token_hash) DO NOTHING;`,
    [tokenHash, userId, username, name, role, expiresAt, ip || null],
  );
}

// Resolve a session by token hash, returning the identity row only when it is
// still valid. Expired rows are treated as absent (and opportunistically
// deleted) so a stale cookie can never authorize a request.
export async function getSession(tokenHash) {
  await ensureSchema();
  const result = await query(
    `SELECT token_hash, user_id, username, name, role, expires_at
     FROM sessions
     WHERE token_hash = $1 AND expires_at > NOW();`,
    [tokenHash],
  );
  if (result.rows.length === 0) {
    // Best-effort cleanup of the matching expired row; never blocks the caller.
    query('DELETE FROM sessions WHERE token_hash = $1 AND expires_at <= NOW();', [tokenHash]).catch(
      () => {},
    );
    return null;
  }
  return result.rows[0];
}

export async function deleteSession(tokenHash) {
  await ensureSchema();
  await query('DELETE FROM sessions WHERE token_hash = $1;', [tokenHash]);
}

// Revoke every live session for a user — used when an account is deleted, its
// role changes, or its password is reset, so stale cookies can't outlive the
// change. The primary admin uses the synthetic user id 'admin'.
export async function deleteSessionsForUser(userId) {
  await ensureSchema();
  await query('DELETE FROM sessions WHERE user_id = $1;', [userId]);
}

export async function deleteExpiredSessions() {
  await ensureSchema();
  const result = await query('DELETE FROM sessions WHERE expires_at <= NOW();');
  return result.rowCount;
}

async function listQueueJobsByPrintedStatus(printedStatus) {
  await ensureSchema();

  // Static whitelist — never derived from request input.
  const orderByClause =
    Number(printedStatus) === 1
      ? 'updated_at DESC, submitted_at DESC NULLS LAST, created_at DESC'
      : 'submitted_at ASC NULLS LAST, created_at ASC';

  const result = await query(
    `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'filename', filename,
          'fileCount', file_count,
          'printedStatus', printed_status,
          'status', CASE WHEN printed_status = 1 THEN 'completed' ELSE 'queued' END,
          'progress', 0,
          'estimatedTime', estimated_time,
          'timeRemaining', estimated_time,
          'filamentUsed', 0,
          'priority', priority,
          'stlFileUrl', CASE
            WHEN COALESCE(file_size_bytes, 0) > 0 THEN '/api/queue/' || id || '/file'
            ELSE stl_file_url
          END,
          'hasFile', COALESCE(file_size_bytes, 0) > 0,
          'submitterName', submitter_name,
          'submitterEmail', submitter_email,
          'notes', notes,
          'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
        )
        ORDER BY ${orderByClause}
      ),
      '[]'::json
    ) AS data
    FROM queue_jobs
    WHERE form_type = $1
      AND deleted_at IS NULL
      AND printed_status = $2;
  `,
    [QUEUE_FORM_TYPE, Number(printedStatus)],
  );

  return result.rows[0].data;
}

export async function listQueueData() {
  const [queue, history] = await Promise.all([
    listQueueJobsByPrintedStatus(0),
    listQueueJobsByPrintedStatus(1),
  ]);

  return { queue, history };
}

// Cheap existence check for the sidebar's real-time queue dot — a COUNT would
// scan every unfinished row just to throw the number away, so cap it at 1 row.
export async function hasUnfinishedQueueJobs() {
  await ensureSchema();
  const result = await query(
    `
    SELECT 1
    FROM queue_jobs
    WHERE form_type = $1
      AND deleted_at IS NULL
      AND printed_status = 0
    LIMIT 1;
  `,
    [QUEUE_FORM_TYPE],
  );
  return result.rows.length > 0;
}

export async function markQueueJobPrinted(id) {
  await ensureSchema();
  await query(
    `
    UPDATE queue_jobs
    SET printed_status = 1,
        updated_at = NOW(),
        file_content = NULL,
        file_mime = NULL,
        file_size_bytes = 0
    WHERE id = $1
      AND deleted_at IS NULL;
  `,
    [id],
  );
}

export async function resetQueueJobs() {
  await ensureSchema();
  await query(
    `
    UPDATE queue_jobs
    SET printed_status = 0,
        updated_at = NOW()
      WHERE form_type = $1
        AND deleted_at IS NULL;
  `,
    [QUEUE_FORM_TYPE],
  );
}

export async function deleteQueueJob(id) {
  await ensureSchema();
  await query(
    `
    UPDATE queue_jobs
    SET deleted_at = NOW(),
        updated_at = NOW()
    WHERE id = $1;
  `,
    [id],
  );
}

// Soft-delete a set of jobs in one statement. Used to remove the source-side
// rows after a host→host migration ("migrate selection, then drop the source").
// Returns the number of rows actually removed (already-deleted rows are skipped).
export async function deleteQueueJobs(ids) {
  await ensureSchema();
  if (!Array.isArray(ids) || ids.length === 0) {
    return 0;
  }
  const result = await query(
    `
    UPDATE queue_jobs
    SET deleted_at = NOW(),
        updated_at = NOW()
    WHERE id = ANY($1::text[])
      AND deleted_at IS NULL;
  `,
    [ids],
  );
  return result.rowCount;
}

// Insert (or replace) a job submitted through the in-app print-request form. The
// uploaded file lives in queue_jobs.file_content (bytea) so the queue carries the
// model itself instead of an external link. form_type is forced to the queue's
// canonical type so the submission shows up in the queue read path.
export async function insertQueueSubmission(job) {
  await ensureSchema();
  await query(
    `
    INSERT INTO queue_jobs (
      id, filename, file_count, submitter_name, submitter_email, notes,
      submitted_at, priority, estimated_time, form_type, printed_status,
      file_content, file_mime, file_size_bytes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      filename = EXCLUDED.filename,
      file_count = EXCLUDED.file_count,
      submitter_name = EXCLUDED.submitter_name,
      submitter_email = EXCLUDED.submitter_email,
      notes = EXCLUDED.notes,
      submitted_at = EXCLUDED.submitted_at,
      priority = EXCLUDED.priority,
      estimated_time = EXCLUDED.estimated_time,
      file_content = EXCLUDED.file_content,
      file_mime = EXCLUDED.file_mime,
      file_size_bytes = EXCLUDED.file_size_bytes,
      deleted_at = NULL,
      updated_at = NOW();
  `,
    [
      job.id,
      job.filename,
      job.fileCount,
      job.submitterName,
      job.submitterEmail ?? null,
      job.notes ?? null,
      job.submittedAt,
      job.priority,
      job.estimatedTime,
      QUEUE_FORM_TYPE,
      job.fileContent,
      job.fileMime,
      job.fileSize,
    ],
  );
}

// Fetch a stored submission's file metadata for download. Returns null when the
// job is missing, soft-deleted, or has no stored file. Deliberately does NOT
// pull `file_content` — model files can be tens of MB, so loading the whole
// bytea into a Node Buffer per request makes server RAM scale with file size ×
// concurrent downloads. Callers stream the bytes via readQueueJobFileChunk()
// instead, keeping resident memory to a small fixed window.
export async function getQueueJobFileMeta(id) {
  await ensureSchema();
  const result = await query(
    `
    SELECT filename, file_mime, octet_length(file_content) AS size
    FROM queue_jobs
    WHERE id = $1
      AND deleted_at IS NULL
      AND file_content IS NOT NULL;
  `,
    [id],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    filename: row.filename,
    mime: row.file_mime || 'application/octet-stream',
    size: Number(row.size) || 0,
  };
}

// Read one slice of a stored file's bytea, 1-indexed by byte (`offset` is
// 0-based here and mapped to Postgres' 1-based substring). Returns a Buffer of
// at most `length` bytes (shorter at EOF, empty past the end). Pulling fixed
// chunks lets the download route stream straight to the client without ever
// materialising the full file server-side.
export async function readQueueJobFileChunk(id, offset, length) {
  await ensureSchema();
  const result = await query(
    `
    SELECT substring(file_content FROM $2 FOR $3) AS chunk
    FROM queue_jobs
    WHERE id = $1
      AND deleted_at IS NULL
      AND file_content IS NOT NULL;
  `,
    [id, offset + 1, length],
  );

  if (result.rows.length === 0 || result.rows[0].chunk == null) {
    return Buffer.alloc(0);
  }
  return result.rows[0].chunk;
}

// ── Queue migration (host → host) ──────────────────────────────────────────
// A remote print-farm manager migrates the queue between hosts by pulling a
// manifest from the source (exportQueueJobs), recreating the rows on the
// destination (importQueueJobs), then streaming each model file across with
// GET/PUT .../file (chunked-streamed reads / setQueueJobFile). The manifest carries
// metadata only — file bytes move per-job so a 50 MB model never has to be
// buffered as base64 inside one JSON document.

// Manifest of stored queue jobs for migration. Pending jobs only by default;
// pass includePrinted to also carry the printed history. Soft-deleted rows are
// always skipped. Pass a non-empty `ids` array to migrate only that selection
// (order/printed filters still apply). No file bytes — each job advertises
// hasFile/fileMime/fileSize and the caller fetches the bytes from .../file.
export async function exportQueueJobs(includePrinted = false, ids = null) {
  await ensureSchema();
  const idFilter = Array.isArray(ids) && ids.length > 0 ? ids : null;
  const result = await query(
    `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'filename', filename,
          'fileCount', file_count,
          'printedStatus', printed_status,
          'estimatedTime', estimated_time,
          'priority', priority,
          'stlFileUrl', stl_file_url,
          'submitterName', submitter_name,
          'submitterEmail', submitter_email,
          'notes', notes,
          'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'hasFile', COALESCE(file_size_bytes, 0) > 0,
          'fileMime', file_mime,
          'fileSize', COALESCE(file_size_bytes, 0)
        )
        ORDER BY submitted_at ASC NULLS LAST, created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM queue_jobs
    WHERE form_type = $1
      AND deleted_at IS NULL
      AND (
        CASE
          -- An explicit selection wins: export exactly those jobs regardless of
          -- printed status, so migrating a selection that includes history works.
          WHEN $3::text[] IS NOT NULL THEN id = ANY($3::text[])
          ELSE ($2::boolean OR printed_status = 0)
        END
      );
  `,
    [QUEUE_FORM_TYPE, Boolean(includePrinted), idFilter],
  );

  return result.rows[0].data;
}

// Recreate jobs from a migration manifest, preserving their ids, printed status
// and submission timestamps. File bytes are attached separately via
// setQueueJobFile. Returns the number of rows written.
export async function importQueueJobs(jobs) {
  await ensureSchema();

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return 0;
  }

  const result = await query(
    `
    WITH input AS (
      SELECT jsonb_array_elements($1::jsonb) AS data
    ),
    normalized AS (
      SELECT
        data->>'id' AS id,
        COALESCE(data->>'filename', '') AS filename,
        COALESCE((data->>'fileCount')::integer, 1) AS file_count,
        NULLIF(data->>'stlFileUrl', '') AS stl_file_url,
        NULLIF(data->>'submitterName', '') AS submitter_name,
        NULLIF(data->>'submitterEmail', '') AS submitter_email,
        NULLIF(data->>'notes', '') AS notes,
        CASE
          WHEN COALESCE(data->>'submittedAt', '') = '' THEN NULL
          ELSE (data->>'submittedAt')::timestamptz
        END AS submitted_at,
        COALESCE(data->>'priority', 'low') AS priority,
        COALESCE((data->>'estimatedTime')::integer, 0) AS estimated_time,
        COALESCE((data->>'printedStatus')::integer, 0) AS printed_status
      FROM input
      WHERE COALESCE(data->>'id', '') <> ''
    ),
    upserted AS (
      INSERT INTO queue_jobs (
        id, filename, file_count, stl_file_url, submitter_name, submitter_email,
        notes, submitted_at, priority, estimated_time, form_type, printed_status
      )
      SELECT
        id, filename, file_count, stl_file_url, submitter_name, submitter_email,
        notes, submitted_at, priority, estimated_time, $2, printed_status
      FROM normalized
      ON CONFLICT (id) DO UPDATE SET
        filename = EXCLUDED.filename,
        file_count = EXCLUDED.file_count,
        stl_file_url = EXCLUDED.stl_file_url,
        submitter_name = EXCLUDED.submitter_name,
        submitter_email = EXCLUDED.submitter_email,
        notes = EXCLUDED.notes,
        submitted_at = EXCLUDED.submitted_at,
        priority = EXCLUDED.priority,
        estimated_time = EXCLUDED.estimated_time,
        printed_status = EXCLUDED.printed_status,
        form_type = EXCLUDED.form_type,
        deleted_at = NULL,
        updated_at = NOW()
      RETURNING id
    )
    SELECT COUNT(*)::int AS count FROM upserted;
  `,
    [JSON.stringify(jobs), QUEUE_FORM_TYPE],
  );

  return result.rows[0].count;
}

// Attach a migrated model file to an existing (non-deleted) queue job. Returns
// true when a row was updated, false when the target job does not exist.
export async function setQueueJobFile(id, content, mime) {
  await ensureSchema();
  const result = await query(
    `
    UPDATE queue_jobs
    SET file_content = $2,
        file_mime = $3,
        file_size_bytes = $4,
        updated_at = NOW()
    WHERE id = $1
      AND deleted_at IS NULL;
  `,
    [id, content, mime || 'application/octet-stream', content.length],
  );

  return result.rowCount > 0;
}

export async function listDiscordWebhooks() {
  await ensureSchema();

  const result = await query(`
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'webhookUrl', webhook_url,
          'events', events,
          'enabled', enabled,
          'tts', tts,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM discord_webhooks;
  `);

  return result.rows[0].data;
}

export async function createDiscordWebhook(webhook) {
  await ensureSchema();

  await query(
    `
    WITH input AS (
      SELECT $1::jsonb AS data
    )
    INSERT INTO discord_webhooks (
      id,
      name,
      webhook_url,
      events,
      enabled,
      tts
    )
    SELECT
      data->>'id',
      data->>'name',
      data->>'webhookUrl',
      CASE
        WHEN jsonb_typeof(data->'events') = 'array' THEN data->'events'
        ELSE NULL
      END,
      COALESCE((data->>'enabled')::boolean, TRUE),
      COALESCE((data->>'tts')::boolean, FALSE)
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      webhook_url = EXCLUDED.webhook_url,
      events = EXCLUDED.events,
      enabled = EXCLUDED.enabled,
      tts = EXCLUDED.tts;
  `,
    [JSON.stringify(webhook)],
  );
}

export async function deleteDiscordWebhook(id) {
  await ensureSchema();
  await query('DELETE FROM discord_webhooks WHERE id = $1;', [id]);
}

// Named API keys for the slicer-upload proxy. Only the sha256 hash is stored —
// the plaintext key is shown to the admin once at creation and never again.
// listSlicerApiKeys never returns the hash; the prefix is for display only.
export async function listSlicerApiKeys() {
  await ensureSchema();

  const result = await query(`
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'keyPrefix', key_prefix,
          'permissions', permissions,
          'lastUsedAt', to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM slicer_api_keys
    WHERE session_token_hash IS NULL;
  `);

  return result.rows[0].data;
}

export async function createSlicerApiKey({ id, name, keyHash, keyPrefix, permissions, sessionTokenHash = null }) {
  await ensureSchema();
  await query(
    `INSERT INTO slicer_api_keys (id, name, key_hash, key_prefix, permissions, session_token_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6);`,
    [id, name, keyHash, keyPrefix, JSON.stringify(permissions ?? []), sessionTokenHash],
  );
}

export async function deleteSlicerApiKey(id) {
  await ensureSchema();
  await query('DELETE FROM slicer_api_keys WHERE id = $1;', [id]);
}

// Delete every ephemeral key minted for a given session (by session token hash).
// Used to revoke a slicer's upload token on logout / on slicer exit.
export async function deleteSlicerApiKeysBySession(sessionTokenHash) {
  await ensureSchema();
  if (!sessionTokenHash) return;
  await query('DELETE FROM slicer_api_keys WHERE session_token_hash = $1;', [sessionTokenHash]);
}

// Used by the proxy to authenticate an upload. Returns the matching key row
// (id/name) or null; the caller stamps last_used_at via touchSlicerApiKey.
export async function findSlicerApiKeyByHash(keyHash) {
  await ensureSchema();
  const result = await query(
    'SELECT id, name, permissions FROM slicer_api_keys WHERE key_hash = $1;',
    [keyHash],
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

export async function touchSlicerApiKey(id) {
  await ensureSchema();
  await query('UPDATE slicer_api_keys SET last_used_at = NOW() WHERE id = $1;', [id]);
}

// Store the slicer's filament estimate (grams) for a print, keyed by printer +
// the subtask name the print is started with. The poller correlates this with
// the printer's reported job name to show real per-job filament usage. Called
// best-effort from the slicer-proxy after a successful Bambu upload.
export async function recordSlicerPrintEstimate({ printerId, jobName, filamentGrams }) {
  await ensureSchema();
  await query(
    `INSERT INTO slicer_print_estimates (printer_id, job_name, filament_grams, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (printer_id, job_name) DO UPDATE
       SET filament_grams = EXCLUDED.filament_grams,
           updated_at = NOW();`,
    [printerId, jobName, filamentGrams],
  );
}

// Generic key/value store for app-wide preferences (e.g. the shared printer
// detail card layout). Values are stored as JSONB and returned parsed.
export async function getAppSetting(key) {
  await ensureSchema();
  const result = await query('SELECT value FROM app_settings WHERE key = $1;', [key]);
  return result.rows.length > 0 ? result.rows[0].value : null;
}

export async function setAppSetting(key, value) {
  await ensureSchema();
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = NOW();`,
    [key, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------------------
// Preventive maintenance
// ---------------------------------------------------------------------------

// app_settings key holding the admin-configurable global default service
// intervals that seed every printer's maintenance_schedules.
const MAINTENANCE_INTERVALS_KEY = 'maintenance_default_intervals';

// The shipped default service plan (the spec's 50/100/250/500/1000/2000h tasks).
// maintenance_type is the stable identity used for dedup/nozzle-reset detection;
// description is the human-readable checklist. Admins can override the whole list
// in Settings -> Maintenance; existing printers are backfilled by the worker.
export const DEFAULT_MAINTENANCE_INTERVALS = [
  { type: 'Basic Inspection', intervalHours: 50, description: 'Basic inspection; clean build plate; inspect nozzle' },
  { type: 'Extruder & Fans', intervalHours: 100, description: 'Clean extruder gears; check fans; inspect belts' },
  { type: 'Lubrication', intervalHours: 250, description: 'Lubricate rods / rails; check screws' },
  { type: 'Deep Clean', intervalHours: 500, description: 'Deep clean toolhead; inspect wiring' },
  { type: 'Nozzle Service', intervalHours: 1000, description: 'Nozzle inspection / replacement' },
  { type: 'Full Service', intervalHours: 2000, description: 'Full maintenance service' },
];

// A pending event counts as "overdue" once the printer has run this far past the
// hours at which the task was triggered without it being completed (10% of the
// interval, floored at 10h). Kept identical across the worker, the API summary,
// and the badge logic so "due" vs "overdue" means the same thing everywhere.
function overdueGraceHours(intervalHours) {
  return Math.max((Number(intervalHours) || 0) * 0.1, 10);
}

// True when the completed task should zero current_nozzle_hours (the 1000h nozzle
// inspection/replacement, or any task whose type mentions the nozzle).
function isNozzleResetType(type, intervalHours) {
  return Number(intervalHours) === 1000 || /nozzle/i.test(String(type || ''));
}

// Validate/normalize an admin-supplied interval list; falls back to the shipped
// defaults when the stored value is missing or malformed.
function normalizeIntervals(value) {
  if (!Array.isArray(value)) return DEFAULT_MAINTENANCE_INTERVALS;
  const cleaned = value
    .map((row) => ({
      type: String(row?.type ?? '').trim(),
      intervalHours: Number(row?.intervalHours),
      description: String(row?.description ?? '').trim(),
    }))
    .filter((row) => row.type && Number.isFinite(row.intervalHours) && row.intervalHours > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_MAINTENANCE_INTERVALS;
}

export async function getMaintenanceDefaultIntervals() {
  const stored = await getAppSetting(MAINTENANCE_INTERVALS_KEY);
  return normalizeIntervals(stored);
}

export async function setMaintenanceDefaultIntervals(intervals) {
  const normalized = normalizeIntervals(intervals);
  await setAppSetting(MAINTENANCE_INTERVALS_KEY, normalized);
  await reconcileMaintenanceSchedules(normalized);
  return normalized;
}

// Applies an admin's edited interval list to every printer's existing schedules.
// Without this, editing e.g. "Deep Clean" from 500h to 400h only ever inserted a
// *new* (printer, type, 400h) schedule row (backfillAllMaintenanceSchedules /
// seedMaintenanceSchedules both key off the (printer_id, type, interval_hours)
// unique index and ON CONFLICT DO NOTHING) while the old 500h row — and any
// pending event already generated from it — stuck around forever, so staff saw
// the old-interval task sitting right next to the newly generated one.
async function reconcileMaintenanceSchedules(intervals) {
  const payload = JSON.stringify(
    intervals.map((i) => ({ type: i.type, interval_hours: i.intervalHours, description: i.description })),
  );

  // Collapse any pre-existing duplicate (printer, type) schedule rows — left over
  // from the old insert-only bug — down to one before retargeting it below, or
  // the retarget UPDATE could collide with the unique index.
  await query(
    `DELETE FROM maintenance_schedules s
     USING maintenance_schedules s2
     WHERE s.printer_id = s2.printer_id
       AND s.maintenance_type = s2.maintenance_type
       AND (s.created_at, s.id) < (s2.created_at, s2.id);`,
  );

  // Retarget each printer's existing schedule for a type onto the new
  // interval/description in place, instead of leaving the old-interval row behind.
  await query(
    `UPDATE maintenance_schedules s
     SET interval_hours = d.interval_hours,
         description = d.description
     FROM jsonb_to_recordset($1::jsonb)
       AS d(type text, interval_hours double precision, description text)
     WHERE s.maintenance_type = d.type
       AND s.interval_hours IS DISTINCT FROM d.interval_hours;`,
    [payload],
  );

  // Seed any printer/type combo that doesn't have a schedule yet (a newly added
  // task type).
  await query(
    `INSERT INTO maintenance_schedules (printer_id, maintenance_type, interval_hours, description)
     SELECT p.id, d.type, d.interval_hours, d.description
     FROM printers p
     CROSS JOIN jsonb_to_recordset($1::jsonb)
       AS d(type text, interval_hours double precision, description text)
     ON CONFLICT (printer_id, maintenance_type, interval_hours) DO NOTHING;`,
    [payload],
  );

  // Drop schedules for task types the admin removed from the list.
  await query(
    `DELETE FROM maintenance_schedules s
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset($1::jsonb)
         AS d(type text, interval_hours double precision, description text)
       WHERE d.type = s.maintenance_type
     );`,
    [payload],
  );

  // Clear pending events that no longer match any schedule (their type's interval
  // changed, or the type was removed) so the stale old-interval task disappears
  // instead of sitting next to the newly generated one.
  await query(
    `DELETE FROM maintenance_events e
     WHERE e.status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM maintenance_schedules s
         WHERE s.printer_id = e.printer_id
           AND s.maintenance_type = e.maintenance_type
           AND s.interval_hours = e.interval_hours
       );`,
  );
}

// Seed a single printer's schedules from the global defaults. Idempotent: the
// unique (printer_id, type, interval) index makes a repeat run a no-op, so this is
// safe to call on every upsertPrinter.
export async function seedMaintenanceSchedules(printerId) {
  const intervals = await getMaintenanceDefaultIntervals();
  await query(
    `INSERT INTO maintenance_schedules (printer_id, maintenance_type, interval_hours, description)
     SELECT $1, d.type, d.interval_hours, d.description
     FROM jsonb_to_recordset($2::jsonb)
       AS d(type text, interval_hours double precision, description text)
     ON CONFLICT (printer_id, maintenance_type, interval_hours) DO NOTHING;`,
    [printerId, JSON.stringify(intervals.map((i) => ({ type: i.type, interval_hours: i.intervalHours, description: i.description })))],
  );
}

// Set-based backfill across the whole fleet (worker path) — seeds any printer
// that predates this feature without a per-printer round trip.
export async function backfillAllMaintenanceSchedules() {
  const intervals = await getMaintenanceDefaultIntervals();
  await query(
    `INSERT INTO maintenance_schedules (printer_id, maintenance_type, interval_hours, description)
     SELECT p.id, d.type, d.interval_hours, d.description
     FROM printers p
     CROSS JOIN jsonb_to_recordset($1::jsonb)
       AS d(type text, interval_hours double precision, description text)
     ON CONFLICT (printer_id, maintenance_type, interval_hours) DO NOTHING;`,
    [JSON.stringify(intervals.map((i) => ({ type: i.type, interval_hours: i.intervalHours, description: i.description })))],
  );
}

export async function listMaintenanceSchedules(printerId) {
  await ensureSchema();
  const result = await query(
    `SELECT id,
            printer_id   AS "printerId",
            maintenance_type AS "maintenanceType",
            interval_hours AS "intervalHours",
            description,
            enabled
     FROM maintenance_schedules
     WHERE printer_id = $1
     ORDER BY interval_hours ASC;`,
    [printerId],
  );
  return result.rows;
}

// Create a pending event, relying on the partial unique index to silently no-op a
// duplicate while one is still pending. Returns the created row, or null when an
// open event already existed.
export async function createPendingMaintenanceEvent({ printerId, maintenanceType, intervalHours, triggeredAtHours }) {
  await ensureSchema();
  const result = await query(
    `INSERT INTO maintenance_events
       (printer_id, maintenance_type, interval_hours, triggered_at_hours, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (printer_id, maintenance_type, interval_hours) WHERE status = 'pending'
     DO NOTHING
     RETURNING id;`,
    [printerId, maintenanceType, intervalHours, triggeredAtHours],
  );
  return result.rows[0] ?? null;
}

function maintenanceEventSelect() {
  return `
    id,
    printer_id AS "printerId",
    maintenance_type AS "maintenanceType",
    interval_hours AS "intervalHours",
    triggered_at_hours AS "triggeredAtHours",
    completed_at_hours AS "completedAtHours",
    status,
    notes,
    created_at AS "createdAt",
    completed_at AS "completedAt"
  `;
}

// List events with optional printer / status / type filters. Backed by the
// (printer_id, status) and (status, created_at) indexes.
export async function listMaintenanceEvents({ printerId = null, status = null, maintenanceType = null, limit = 500 } = {}) {
  await ensureSchema();
  const conditions = [];
  const params = [];
  if (printerId) {
    params.push(printerId);
    conditions.push(`printer_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (maintenanceType) {
    params.push(maintenanceType);
    conditions.push(`maintenance_type = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT ${maintenanceEventSelect()}
     FROM maintenance_events
     ${where}
     ORDER BY (status = 'pending') DESC, created_at DESC
     LIMIT $${params.length};`,
    params,
  );
  return result.rows;
}

// Bumps both hour counters atomically and returns the before/after totals so the
// caller can detect interval crossings. Used by the web worker; the poller does the
// equivalent inline in finalize_job_analytics.
export async function addPrintHours(printerId, hours) {
  await ensureSchema();
  const result = await query(
    `UPDATE printers
        SET total_print_hours = total_print_hours + $2,
            current_nozzle_hours = current_nozzle_hours + $2
      WHERE id = $1
      RETURNING total_print_hours AS "totalPrintHours",
                total_print_hours - $2 AS "previousTotalPrintHours",
                current_nozzle_hours AS "currentNozzleHours";`,
    [printerId, Number(hours) || 0],
  );
  return result.rows[0] ?? null;
}

// Mark an event completed: stamp completion hours/time, advance the printer's
// last_maintenance_at, and zero current_nozzle_hours when a nozzle service was
// done. Returns the updated event, or null when the id was unknown or not pending.
export async function completeMaintenanceEvent(id, notes = null) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      // RETURNING is table-qualified (e.*) because this UPDATE ... FROM joins
      // printers, which also has an `id` column (otherwise "id" is ambiguous).
      `UPDATE maintenance_events e
          SET status = 'completed',
              completed_at = NOW(),
              completed_at_hours = p.total_print_hours,
              notes = $2
         FROM printers p
        WHERE e.id = $1
          AND e.status = 'pending'
          AND p.id = e.printer_id
        RETURNING
          e.id,
          e.printer_id AS "printerId",
          e.maintenance_type AS "maintenanceType",
          e.interval_hours AS "intervalHours",
          e.triggered_at_hours AS "triggeredAtHours",
          e.completed_at_hours AS "completedAtHours",
          e.status,
          e.notes,
          e.created_at AS "createdAt",
          e.completed_at AS "completedAt";`,
      [id, notes],
    );
    const event = updated.rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return null;
    }
    const resetNozzle = isNozzleResetType(event.maintenanceType, event.intervalHours);
    await client.query(
      `UPDATE printers
          SET last_maintenance_at = NOW()
              ${resetNozzle ? ', current_nozzle_hours = 0' : ''}
        WHERE id = $1;`,
      [event.printerId],
    );
    await client.query('COMMIT');
    return event;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Pure health-score calculator (clamped 0-100), shared by the worker and the
// per-printer summary so the dashboard and the stored score never disagree.
export function recalcHealthScore({ lubricationOverdue, nozzleOverdue, anyTaskOverdue, highFailureRate }) {
  let score = 100;
  if (lubricationOverdue) score -= 5;
  if (nozzleOverdue) score -= 10;
  if (anyTaskOverdue) score -= 15;
  if (highFailureRate) score -= 10;
  return Math.max(0, Math.min(100, score));
}

export function healthStatusFromScore(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Warning';
  return 'Service Required';
}

// Decorate a pending event with due/overdue state from the printer's current
// hours. Shared by every read path so a task's urgency is computed one way.
function classifyPendingEvent(event, totalHours) {
  const grace = overdueGraceHours(event.intervalHours);
  const overdue = Number(totalHours) >= Number(event.triggeredAtHours ?? 0) + grace;
  return { ...event, overdue };
}

// Per-printer maintenance summary for GET /api/printers/:id/maintenance. Computes
// next_service from the schedules, classifies pending/completed tasks, and derives
// the live health score/status.
export async function getPrinterMaintenance(printerId) {
  await ensureSchema();
  const printerResult = await query(
    `SELECT id, name,
            total_print_hours AS "totalPrintHours",
            current_nozzle_hours AS "currentNozzleHours",
            success_rate AS "successRate",
            health_score AS "healthScore",
            last_maintenance_at AS "lastMaintenanceAt"
     FROM printers WHERE id = $1;`,
    [printerId],
  );
  const printer = printerResult.rows[0];
  if (!printer) return null;

  const [schedules, events] = await Promise.all([
    listMaintenanceSchedules(printerId),
    listMaintenanceEvents({ printerId, limit: 500 }),
  ]);

  const totalHours = Number(printer.totalPrintHours) || 0;
  const pending = events
    .filter((e) => e.status === 'pending')
    .map((e) => classifyPendingEvent(e, totalHours));
  const completed = events.filter((e) => e.status === 'completed');

  // next_service: the schedule whose next interval multiple is soonest.
  let nextService = null;
  for (const s of schedules) {
    if (!s.enabled) continue;
    const interval = Number(s.intervalHours) || 0;
    if (interval <= 0) continue;
    const nextMultiple = (Math.floor(totalHours / interval) + 1) * interval;
    const remaining = Math.max(0, nextMultiple - totalHours);
    if (!nextService || remaining < nextService.remainingHours) {
      nextService = { type: s.maintenanceType, intervalHours: interval, remainingHours: remaining };
    }
  }

  const lubricationOverdue = pending.some((e) => e.overdue && /lubric/i.test(e.maintenanceType));
  const nozzleOverdue = (Number(printer.currentNozzleHours) || 0) > 1000;
  const anyTaskOverdue = pending.some((e) => e.overdue);
  const highFailureRate = 100 - (Number(printer.successRate) || 0) > 10;
  const healthScore = recalcHealthScore({ lubricationOverdue, nozzleOverdue, anyTaskOverdue, highFailureRate });

  return {
    printerId: printer.id,
    printerName: printer.name,
    totalHours: Math.round(totalHours * 100) / 100,
    nozzleHours: Math.round((Number(printer.currentNozzleHours) || 0) * 100) / 100,
    healthScore,
    healthStatus: healthStatusFromScore(healthScore),
    lastMaintenanceAt: printer.lastMaintenanceAt,
    pendingTasks: pending,
    completedTasks: completed,
    nextService,
  };
}

// Fleet-wide widget aggregates as single indexed queries (kept cheap at scale).
export async function getMaintenanceSummary() {
  await ensureSchema();
  const result = await query(
    `WITH pending AS (
       SELECT e.printer_id,
              bool_or(p.total_print_hours
                      >= e.triggered_at_hours + GREATEST(e.interval_hours * 0.1, 10)) AS has_overdue,
              count(*) AS pending_count,
              count(*) FILTER (
                WHERE p.total_print_hours
                      >= e.triggered_at_hours + GREATEST(e.interval_hours * 0.1, 10)
              ) AS overdue_count
       FROM maintenance_events e
       JOIN printers p ON p.id = e.printer_id
       WHERE e.status = 'pending'
       GROUP BY e.printer_id
     )
     SELECT
       (SELECT count(*) FROM pending WHERE pending_count > 0) AS printers_requiring_maintenance,
       (SELECT COALESCE(sum(overdue_count), 0) FROM pending) AS overdue_tasks,
       (SELECT COALESCE(round(avg(health_score)), 0) FROM printers) AS average_health,
       (SELECT COALESCE(round(sum(total_print_hours)::numeric, 2), 0) FROM printers) AS total_fleet_hours,
       (SELECT count(*) FROM printers) AS printer_count;`,
  );
  const row = result.rows[0] || {};
  return {
    printersRequiringMaintenance: Number(row.printers_requiring_maintenance) || 0,
    overdueTasks: Number(row.overdue_tasks) || 0,
    averageHealth: Number(row.average_health) || 0,
    totalFleetHours: Number(row.total_fleet_hours) || 0,
    printerCount: Number(row.printer_count) || 0,
  };
}

export async function listMaintenanceNotifications({ unreadOnly = false, limit = 100 } = {}) {
  await ensureSchema();
  const params = [];
  let where = '';
  if (unreadOnly) {
    where = 'WHERE read = FALSE';
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const result = await query(
    `SELECT id, printer_id AS "printerId", kind, title, body, read,
            created_at AS "createdAt"
     FROM maintenance_notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length};`,
    params,
  );
  return result.rows;
}

// Insert an unread notification, de-duped to one open row per (printer, kind) via
// the partial unique index — a persistent condition won't spam the bell.
export async function createMaintenanceNotification({ printerId = null, kind, title, body = null }) {
  await ensureSchema();
  const result = await query(
    `INSERT INTO maintenance_notifications (printer_id, kind, title, body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (printer_id, kind) WHERE read = FALSE
     DO NOTHING
     RETURNING id;`,
    [printerId, kind, title, body],
  );
  return result.rows[0] ?? null;
}

// Stamp the notification kind we've raised for a set of pending maintenance events
// so the worker doesn't re-alert the same task every pass. Idempotent; only writes
// when the kind actually changes (null → 'due' → 'overdue').
export async function markMaintenanceEventsNotified(ids, kind) {
  await ensureSchema();
  if (!Array.isArray(ids) || ids.length === 0) return;
  await query(
    `UPDATE maintenance_events
        SET notified_kind = $2
      WHERE id = ANY($1) AND notified_kind IS DISTINCT FROM $2;`,
    [ids, kind],
  );
}

export async function markMaintenanceNotificationsRead(ids = null) {
  await ensureSchema();
  if (Array.isArray(ids) && ids.length > 0) {
    await query('UPDATE maintenance_notifications SET read = TRUE WHERE id = ANY($1);', [ids]);
  } else {
    await query('UPDATE maintenance_notifications SET read = TRUE WHERE read = FALSE;');
  }
}

// Bulk fleet snapshot for the 5-minute worker: printers, their enabled schedules,
// open pending events, and completed-event counts per (printer, type, interval).
// Three set-based queries joined in JS — avoids a per-printer round trip so the
// pass stays cheap with thousands of printers.
export async function getMaintenanceWorkerData() {
  await ensureSchema();
  const [printers, schedules, pending, completed] = await Promise.all([
    query(
      `SELECT id, name,
              total_print_hours AS "totalPrintHours",
              current_nozzle_hours AS "currentNozzleHours",
              success_rate AS "successRate",
              health_score AS "healthScore"
       FROM printers;`,
    ),
    query(
      `SELECT printer_id AS "printerId", maintenance_type AS "maintenanceType",
              interval_hours AS "intervalHours"
       FROM maintenance_schedules
       WHERE enabled = TRUE;`,
    ),
    query(
      `SELECT id, printer_id AS "printerId", maintenance_type AS "maintenanceType",
              interval_hours AS "intervalHours", triggered_at_hours AS "triggeredAtHours",
              notified_kind AS "notifiedKind"
       FROM maintenance_events WHERE status = 'pending';`,
    ),
    query(
      `SELECT printer_id AS "printerId", maintenance_type AS "maintenanceType",
              interval_hours AS "intervalHours", count(*)::int AS count
       FROM maintenance_events WHERE status = 'completed'
       GROUP BY 1, 2, 3;`,
    ),
  ]);
  return {
    printers: printers.rows,
    schedules: schedules.rows,
    pending: pending.rows,
    completedCounts: completed.rows,
  };
}

// Bulk-write recomputed health scores. Accepts [{ id, healthScore }]; a single
// UPDATE ... FROM unnest keeps it to one round trip.
export async function bulkUpdateHealthScores(updates) {
  await ensureSchema();
  if (!Array.isArray(updates) || updates.length === 0) return;
  const ids = updates.map((u) => u.id);
  const scores = updates.map((u) => Math.max(0, Math.min(100, Math.round(Number(u.healthScore) || 0))));
  await query(
    `UPDATE printers p
        SET health_score = v.score
       FROM unnest($1::text[], $2::int[]) AS v(id, score)
      WHERE p.id = v.id AND p.health_score IS DISTINCT FROM v.score;`,
    [ids, scores],
  );
}

// Append one entry to the audit trail. `action` is required; everything else is
// optional. Callers should treat this as best-effort and never block a user
// action on it failing.
export async function recordAuditLog(entry) {
  await ensureSchema();

  const {
    actorName = null,
    actorUsername = null,
    actorRole = null,
    action,
    target = null,
    details = null,
    source = 'web',
    ip = null,
  } = entry || {};

  if (typeof action !== 'string' || !action.trim()) {
    throw new Error('audit log action is required');
  }

  await query(
    `INSERT INTO audit_logs
       (actor_name, actor_username, actor_role, action, target, details, source, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
    [
      actorName,
      actorUsername,
      actorRole,
      action.trim(),
      target,
      details == null ? null : JSON.stringify(details),
      source,
      ip,
    ],
  );
}

export async function createManagerRequest({ id, name, description }) {
  await ensureSchema();
  await query(
    `INSERT INTO manager_requests (id, name, description) VALUES ($1, $2, $3)`,
    [id, name, description || null],
  );
}

export async function getManagerRequest(id) {
  await ensureSchema();
  const result = await query(
    `SELECT id, name, description, status, api_key_id, key_secret,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
     FROM manager_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function listManagerRequests() {
  await ensureSchema();
  const result = await query(`
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'description', description,
          'status', status,
          'apiKeyId', api_key_id,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at DESC
      ),
      '[]'::json
    ) AS data
    FROM manager_requests
    WHERE status != 'revoked';
  `);
  return result.rows[0].data;
}

export async function approveManagerRequest(id, { apiKeyId, keySecret }) {
  await ensureSchema();
  await query(
    `UPDATE manager_requests
     SET status = 'approved', api_key_id = $2, key_secret = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, apiKeyId, keySecret],
  );
}

export async function denyManagerRequest(id) {
  await ensureSchema();
  await query(
    `UPDATE manager_requests SET status = 'denied', updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function clearManagerRequestKeySecret(id) {
  await ensureSchema();
  await query(
    `UPDATE manager_requests SET key_secret = NULL, updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function deleteManagerRequest(id) {
  await ensureSchema();
  await query(`DELETE FROM manager_requests WHERE id = $1`, [id]);
}

// Most recent audit entries first. `limit` is clamped to a sane window so a
// stray query can never ask the database for the entire table.
export async function listAuditLogs(limit = 200) {
  await ensureSchema();

  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);

  const result = await query(
    `
    SELECT COALESCE(
      json_agg(entry ORDER BY created_at DESC, id DESC),
      '[]'::json
    ) AS data
    FROM (
      SELECT
        id,
        created_at,
        json_build_object(
          'id', id,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'actorName', actor_name,
          'actorUsername', actor_username,
          'actorRole', actor_role,
          'action', action,
          'target', target,
          'details', details,
          'source', source,
          'ip', ip
        ) AS entry
      FROM audit_logs
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    ) recent;
  `,
    [safeLimit],
  );

  return result.rows[0].data;
}
