import pg from 'pg';

const { Pool } = pg;

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
SELECT pg_advisory_unlock(90210);
`;

const QUEUE_FORM_TYPE = 'สั่งพิมพ์งาน 3D Print';

let pool;

// The pool is created lazily so importing this module never fails when
// DATABASE_URL is absent; the connection is only needed once a query runs.
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }

    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
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

export async function listPrinters() {
  await ensureSchema();
  const includeSensitive = !isPublicViewerMode();

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

  return result.rows[0].data;
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

  return result.rows[0]?.printer ?? null;
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

  return result.rows[0]?.printer ?? null;
}

export async function upsertPrinter(printer) {
  await ensureSchema();

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
    [JSON.stringify(printer)],
  );
}

export async function deletePrinter(id) {
  await ensureSchema();
  await query('DELETE FROM printers WHERE id = $1;', [id]);
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
          'stlFileUrl', stl_file_url,
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

export async function createSlicerApiKey({ id, name, keyHash, keyPrefix }) {
  await ensureSchema();
  await query(
    `INSERT INTO slicer_api_keys (id, name, key_hash, key_prefix)
     VALUES ($1, $2, $3, $4);`,
    [id, name, keyHash, keyPrefix],
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
    'SELECT id, name FROM slicer_api_keys WHERE key_hash = $1;',
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
