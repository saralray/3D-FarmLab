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
  status TEXT NOT NULL,
  temperature_nozzle DOUBLE PRECISION NOT NULL DEFAULT 0,
  temperature_bed DOUBLE PRECISION NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  last_maintenance TEXT NOT NULL,
  total_print_time DOUBLE PRECISION NOT NULL DEFAULT 0,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_job JSONB,
  nozzle_temperatures JSONB,
  spools JSONB,
  offline_since DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE printers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS nozzle_temperatures JSONB;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS offline_since DOUBLE PRECISION;
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
CREATE TABLE IF NOT EXISTS discord_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
      'status', status,
      'temperature', json_build_object(
        'nozzle', ROUND(temperature_nozzle::numeric, 2),
        'bed', ROUND(temperature_bed::numeric, 2)
      ),
      'progress', progress,
      'lastMaintenance', last_maintenance,
      'totalPrintTime', ROUND(total_print_time::numeric, 2),
      'successRate', ROUND(success_rate::numeric, 2),
      'currentJob', current_job,
      'nozzleTemperatures', nozzle_temperatures,
      'spools', spools
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
      'status', status,
      'temperature', json_build_object(
        'nozzle', ROUND(temperature_nozzle::numeric, 2),
        'bed', ROUND(temperature_bed::numeric, 2)
      ),
      'progress', progress,
      'lastMaintenance', last_maintenance,
      'totalPrintTime', ROUND(total_print_time::numeric, 2),
      'successRate', ROUND(success_rate::numeric, 2),
      'currentJob', current_job,
      'nozzleTemperatures', nozzle_temperatures,
      'spools', spools
    ) AS printer
    FROM printers
    WHERE id = $1;
  `,
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
      name = EXCLUDED.name,
      model = EXCLUDED.model,
      sort_order = EXCLUDED.sort_order,
      profile = EXCLUDED.profile,
      url = EXCLUDED.url,
      ip_address = EXCLUDED.ip_address,
      api_key_header = EXCLUDED.api_key_header,
      status = EXCLUDED.status,
      temperature_nozzle = EXCLUDED.temperature_nozzle,
      temperature_bed = EXCLUDED.temperature_bed,
      progress = EXCLUDED.progress,
      last_maintenance = EXCLUDED.last_maintenance,
      total_print_time = EXCLUDED.total_print_time,
      success_rate = EXCLUDED.success_rate,
      current_job = EXCLUDED.current_job,
      nozzle_temperatures = EXCLUDED.nozzle_temperatures,
      spools = EXCLUDED.spools,
      offline_since = EXCLUDED.offline_since;
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
      webhook_url
    )
    SELECT
      data->>'id',
      data->>'name',
      data->>'webhookUrl'
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      webhook_url = EXCLUDED.webhook_url;
  `,
    [JSON.stringify(webhook)],
  );
}

export async function deleteDiscordWebhook(id) {
  await ensureSchema();
  await query('DELETE FROM discord_webhooks WHERE id = $1;', [id]);
}
