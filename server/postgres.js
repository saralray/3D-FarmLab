import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
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
  spools JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
          'spools', spools
        )
        ORDER BY created_at DESC
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
      spools
    )
    SELECT
      data->>'id',
      data->>'name',
      data->>'model',
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
      data->'spools'
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      model = EXCLUDED.model,
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
      spools = EXCLUDED.spools;
  `;

  await runPsql(sql);
}

export async function deletePrinter(id) {
  await ensureSchema();
  await runPsql(`DELETE FROM printers WHERE id = ${sqlLiteral(id)};`);
}
