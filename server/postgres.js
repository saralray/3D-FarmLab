import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE printers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS nozzle_temperatures JSONB;
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS file_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT '';
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS printed_status INTEGER NOT NULL DEFAULT 0;
SELECT pg_advisory_unlock(90210);
`;

function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? '';
}

function getPsqlArgs(sql) {
  const args = ['--dbname', getDatabaseUrl(), '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  args.push('-c', sql);
  return args;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPsql(sql) {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  const { stdout } = await execFileAsync('psql', getPsqlArgs(sql), {
    env: process.env,
  });

  return stdout.trim();
}

export async function ensureSchema() {
  await runPsql(SCHEMA_SQL);
}

export async function listPrinters() {
  await ensureSchema();

  const sql = `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'model', model,
          'sortOrder', sort_order,
          'profile', profile,
          'url', url,
          'ipAddress', ip_address,
          'apiKeyHeader', api_key_header,
          'status', status,
          'temperature', json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed),
          'progress', progress,
          'lastMaintenance', last_maintenance,
          'totalPrintTime', total_print_time,
          'successRate', success_rate,
          'currentJob', current_job,
          'nozzleTemperatures', nozzle_temperatures,
          'spools', spools
        )
        ORDER BY sort_order ASC, created_at DESC
      ),
      '[]'::json
    )::text
    FROM printers;
  `;

  const output = await runPsql(sql);
  return JSON.parse(output || '[]');
}

export async function getPrinterById(id) {
  await ensureSchema();

  const sql = `
    SELECT COALESCE(
      (
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
          'temperature', json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed),
          'progress', progress,
          'lastMaintenance', last_maintenance,
          'totalPrintTime', total_print_time,
          'successRate', success_rate,
          'currentJob', current_job,
          'nozzleTemperatures', nozzle_temperatures,
          'spools', spools
        )::text
        FROM printers
        WHERE id = ${sqlLiteral(id)}
      ),
      ''
    );
  `;

  const output = await runPsql(sql);
  return output ? JSON.parse(output) : null;
}

export async function upsertPrinter(printer) {
  await ensureSchema();

  const payload = sqlLiteral(JSON.stringify(printer));
  const sql = `
    WITH input AS (
      SELECT ${payload}::jsonb AS data
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
      spools
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
      data->'spools'
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
      spools = EXCLUDED.spools;
  `;

  await runPsql(sql);
}

export async function deletePrinter(id) {
  await ensureSchema();
  await runPsql(`DELETE FROM printers WHERE id = ${sqlLiteral(id)};`);
}

export async function listDailyAnalytics(days = 7) {
  await ensureSchema();

  const sql = `
    WITH dates AS (
      SELECT generate_series(
        CURRENT_DATE - (${Number(days) - 1} * INTERVAL '1 day'),
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
    )::text
    FROM dates d
    LEFT JOIN analytics_daily a
      ON a.analytics_date = d.analytics_date;
  `;

  const output = await runPsql(sql);
  return JSON.parse(output || '[]');
}

export async function resetDailyAnalytics() {
  await ensureSchema();
  await runPsql(`TRUNCATE TABLE analytics_daily;`);
}

export async function upsertQueueJobs(jobs) {
  await ensureSchema();

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  const payload = sqlLiteral(JSON.stringify(jobs));
  const sql = `
    WITH input AS (
      SELECT jsonb_array_elements(${payload}::jsonb) AS data
    )
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
      data->>'id',
      COALESCE(data->>'filename', ''),
      COALESCE((data->>'fileCount')::integer, 1),
      NULLIF(data->>'stlFileUrl', ''),
      NULLIF(data->>'submitterName', ''),
      NULLIF(data->>'submitterEmail', ''),
      NULLIF(data->>'notes', ''),
      CASE
        WHEN COALESCE(data->>'submittedAt', '') = '' THEN NULL
        ELSE (data->>'submittedAt')::timestamptz
      END,
      COALESCE(data->>'priority', 'low'),
      COALESCE((data->>'estimatedTime')::integer, 0),
      COALESCE(data->>'formType', ''),
      COALESCE((data->>'printedStatus')::integer, 0)
    FROM input
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
      updated_at = NOW();
  `;

  await runPsql(sql);
}

async function listQueueJobsByPrintedStatus(printedStatus) {
  await ensureSchema();

  const sql = `
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
        ORDER BY submitted_at DESC NULLS LAST, created_at DESC
      ),
      '[]'::json
    )::text
    FROM queue_jobs
    WHERE form_type = 'สั่งพิมพ์งาน 3D Print'
      AND printed_status = ${Number(printedStatus)};
  `;

  const output = await runPsql(sql);
  return JSON.parse(output || '[]');
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
  await runPsql(`
    UPDATE queue_jobs
    SET printed_status = 1,
        updated_at = NOW()
    WHERE id = ${sqlLiteral(id)};
  `);
}

export async function resetQueueJobs() {
  await ensureSchema();
  await runPsql(`
    UPDATE queue_jobs
    SET printed_status = 0,
        updated_at = NOW()
    WHERE form_type = 'สั่งพิมพ์งาน 3D Print';
  `);
}
