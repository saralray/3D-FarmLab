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
SELECT pg_advisory_unlock(90210);
`;

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
      'airFilterOn', air_filter_on
    )
  `;
}

let schemaReadyPromise;

export async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = query(SCHEMA_SQL).catch((error) => {
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
      'airFilterOn', air_filter_on
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

export async function markQueueJobPrinted(id) {
  await ensureSchema();
  await query(
    `
    UPDATE queue_jobs
    SET printed_status = 1,
        updated_at = NOW()
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
      enabled
    )
    SELECT
      data->>'id',
      data->>'name',
      data->>'webhookUrl',
      CASE
        WHEN jsonb_typeof(data->'events') = 'array' THEN data->'events'
        ELSE NULL
      END,
      COALESCE((data->>'enabled')::boolean, TRUE)
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      webhook_url = EXCLUDED.webhook_url,
      events = EXCLUDED.events,
      enabled = EXCLUDED.enabled;
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
    FROM slicer_api_keys;
  `);

  return result.rows[0].data;
}

export async function createSlicerApiKey({ id, name, keyHash, keyPrefix, permissions }) {
  await ensureSchema();
  await query(
    `INSERT INTO slicer_api_keys (id, name, key_hash, key_prefix, permissions)
     VALUES ($1, $2, $3, $4, $5::jsonb);`,
    [id, name, keyHash, keyPrefix, JSON.stringify(permissions ?? [])],
  );
}

export async function deleteSlicerApiKey(id) {
  await ensureSchema();
  await query('DELETE FROM slicer_api_keys WHERE id = $1;', [id]);
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
