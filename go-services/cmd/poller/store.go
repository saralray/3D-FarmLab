package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"printfarm/internal/db"
)

// schemaSQL is the poller's idempotent schema, ported verbatim from
// printer_status_poller.py's SCHEMA_SQL. Run once per connection under the shared
// advisory lock so concurrent service starts don't race.
const schemaSQL = `
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
ALTER TABLE printers ADD COLUMN IF NOT EXISTS total_print_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS current_nozzle_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS last_maintenance_at TIMESTAMPTZ;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS health_score INTEGER NOT NULL DEFAULT 100;
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
CREATE TABLE IF NOT EXISTS analytics_daily (
  analytics_date DATE PRIMARY KEY,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  print_time_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  filament_used_grams DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS discord_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS events JSONB;
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS tts BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS slicer_print_estimates (
  printer_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  filament_grams DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (printer_id, job_name)
);
-- Per-filament-slot 3MF breakdown ([{slotId,usedG,type,color}, ...]), alongside
-- the coarse filament_grams total above. Nullable/additive: existing readers of
-- filament_grams are unaffected; filament_consumption.go's applyFilamentConsumption
-- is the only consumer of this column.
ALTER TABLE slicer_print_estimates ADD COLUMN IF NOT EXISTS filament_slots JSONB;
CREATE TABLE IF NOT EXISTS poller_health (
  shard_index INTEGER PRIMARY KEY,
  shard_count INTEGER NOT NULL DEFAULT 1,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cycle_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  printers_polled INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  refresh_failures INTEGER NOT NULL DEFAULT 0
);
-- Bytes to/from the printers themselves this shard's last cycle (HTTP polling,
-- Bambu MQTT, Bambu FTP) — see netbytes.go. Added after the initial release;
-- a separate ALTER rather than baking into the CREATE TABLE above so an
-- existing deployment picks it up without a backfill.
ALTER TABLE poller_health ADD COLUMN IF NOT EXISTS bytes_out BIGINT NOT NULL DEFAULT 0;
ALTER TABLE poller_health ADD COLUMN IF NOT EXISTS bytes_in BIGINT NOT NULL DEFAULT 0;
-- Filament Station inventory table (see server/postgres.js's SCHEMA_SQL for
-- the full definition with all three filament_station_* tables — this is
-- just filament_spools, the one this poller reads/writes directly via
-- filament_matcher.go's auto-catalog. Duplicated here, like every other
-- shared table in this file, so the poller can bootstrap it on a fresh DB
-- even if the web service hasn't started yet.
CREATE TABLE IF NOT EXISTS filament_spools (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  material TEXT NOT NULL,
  subtype TEXT,
  color_name TEXT,
  rgba TEXT NOT NULL DEFAULT 'FFFFFFFF',
  brand TEXT,
  label_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  core_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  weight_used DOUBLE PRECISION NOT NULL DEFAULT 0,
  nozzle_temp_min INTEGER,
  nozzle_temp_max INTEGER,
  bed_temp_min INTEGER,
  bed_temp_max INTEGER,
  diameter DOUBLE PRECISION NOT NULL DEFAULT 1.75,
  tag_uid TEXT,
  tray_uuid TEXT,
  data_origin TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  last_scale_weight DOUBLE PRECISION,
  last_weighed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS filament_spools_tag_uid_idx ON filament_spools (tag_uid) WHERE tag_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS filament_spools_tray_uuid_idx ON filament_spools (tray_uuid) WHERE tray_uuid IS NOT NULL;
-- Spool-to-printer/AMS-slot bindings, duplicated from server/postgres.js's
-- SCHEMA_SQL for the same reason as filament_spools above: filament_matcher.go's
-- ensureAutoAssignment and filament_consumption.go's findAssignedSpoolID query
-- this table directly and must not depend on the Node web service having
-- bootstrapped the DB first.
CREATE TABLE IF NOT EXISTS filament_station_assignments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  spool_id TEXT NOT NULL REFERENCES filament_spools(id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  ams_id INTEGER NOT NULL DEFAULT 0,
  tray_id INTEGER NOT NULL,
  fingerprint_color TEXT,
  fingerprint_type TEXT,
  fingerprint_present BOOLEAN,
  pending_config BOOLEAN NOT NULL DEFAULT FALSE,
  needs_trigger_at TIMESTAMPTZ,
  last_trigger_result TEXT,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (printer_id, ams_id, tray_id)
);
CREATE INDEX IF NOT EXISTS filament_station_assignments_trigger_idx
  ON filament_station_assignments (needs_trigger_at) WHERE needs_trigger_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS filament_station_assignments_spool_idx
  ON filament_station_assignments (spool_id);
SELECT pg_advisory_unlock(90210);
`

// connectDB opens the poll loop's long-lived connection with the same guards as
// the Node pool: bounded connect, per-statement and idle-in-transaction timeouts.
func connectDB(ctx context.Context) (*pgx.Conn, error) {
	url, err := db.URL()
	if err != nil {
		return nil, err
	}
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnectTimeout = dbConnectTimeout
	if dbStatementTimeout > 0 {
		cfg.RuntimeParams["statement_timeout"] = strconv.Itoa(dbStatementTimeout)
	}
	if dbIdleTxTimeout > 0 {
		cfg.RuntimeParams["idle_in_transaction_session_timeout"] = strconv.Itoa(dbIdleTxTimeout)
	}
	return pgx.ConnectConfig(ctx, cfg)
}

// ensureSchema runs the full schema blob via the simple protocol (Exec with no
// args allows multiple semicolon-separated statements).
func ensureSchema(ctx context.Context, conn *pgx.Conn) error {
	_, err := conn.Exec(ctx, schemaSQL)
	return err
}

func jsonbParam(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return b
}

func unmarshalJSONB(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// listPrinters reads every printer, decrypting the connection secret, and returns
// each as a pmap with the camelCase keys the rest of the poller expects.
func listPrinters(ctx context.Context, conn *pgx.Conn, cipher secretDecryptor) ([]pmap, error) {
	rows, err := conn.Query(ctx, `
		SELECT
		  id, name, model, sort_order, profile, url, ip_address, api_key_header, serial, status,
		  json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed, 'chamber', temperature_chamber) AS temperature,
		  progress, last_maintenance, total_print_time, success_rate,
		  current_job, nozzle_temperatures, nozzle_targets, bed_target, chamber_target,
		  spools, fan_speeds, light_on, air_filter_on, error_message, offline_since
		FROM printers
		ORDER BY sort_order ASC, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var printers []pmap
	for rows.Next() {
		var (
			id, name, model, profile, url, ipAddress, apiKeyHeader, status string
			sortOrder, progress                                            int
			serial, lastMaintenance, errorMessage                          *string
			totalPrintTime, successRate                                    float64
			bedTarget, chamberTarget, offlineSince                         *float64
			lightOn, airFilterOn                                           *bool
			temperatureRaw, currentJobRaw, nozzleTempsRaw                  []byte
			nozzleTargetsRaw, spoolsRaw, fanSpeedsRaw                      []byte
		)
		if err := rows.Scan(
			&id, &name, &model, &sortOrder, &profile, &url, &ipAddress, &apiKeyHeader, &serial, &status,
			&temperatureRaw, &progress, &lastMaintenance, &totalPrintTime, &successRate,
			&currentJobRaw, &nozzleTempsRaw, &nozzleTargetsRaw, &bedTarget, &chamberTarget,
			&spoolsRaw, &fanSpeedsRaw, &lightOn, &airFilterOn, &errorMessage, &offlineSince,
		); err != nil {
			return nil, err
		}

		p := pmap{
			"id":                 id,
			"name":               name,
			"model":              model,
			"sortOrder":          float64(sortOrder),
			"profile":            profile,
			"url":                url,
			"ipAddress":          ipAddress,
			"apiKeyHeader":       cipher.Decrypt(apiKeyHeader),
			"serial":             ptrToAny(serial),
			"status":             status,
			"temperature":        unmarshalJSONB(temperatureRaw),
			"progress":           float64(progress),
			"lastMaintenance":    derefStr(lastMaintenance),
			"totalPrintTime":     totalPrintTime,
			"successRate":        successRate,
			"currentJob":         unmarshalJSONB(currentJobRaw),
			"nozzleTemperatures": unmarshalJSONB(nozzleTempsRaw),
			"nozzleTargets":      unmarshalJSONB(nozzleTargetsRaw),
			"bedTarget":          fptrToAny(bedTarget),
			"chamberTarget":      fptrToAny(chamberTarget),
			"spools":             unmarshalJSONB(spoolsRaw),
			"fanSpeeds":          unmarshalJSONB(fanSpeedsRaw),
			"lightOn":            bptrToAny(lightOn),
			"airFilterOn":        bptrToAny(airFilterOn),
			"errorMessage":       ptrToAny(errorMessage),
			"offlineSince":       fptrToAny(offlineSince),
		}
		printers = append(printers, p)
	}
	return printers, rows.Err()
}

// upsertPrinter writes one printer row. Mirrors upsert_printer in Python: the
// connection secret is re-encrypted; JSONB columns are passed as marshalled bytes
// with a ::jsonb cast.
func upsertPrinter(ctx context.Context, conn *pgx.Conn, cipher secretEncryptor, p pmap) error {
	// Printers are untrusted: clamp device-derived telemetry to sane bounds and
	// bound free-text length before it reaches the DB (S-5 / MP-2).
	sanitizePrinterTelemetry(p)
	temp := mMap(p, "temperature")
	_, err := conn.Exec(ctx, `
		INSERT INTO printers (
		  id, name, model, sort_order, profile, url, ip_address, api_key_header, serial, status,
		  temperature_nozzle, temperature_bed, temperature_chamber, progress, last_maintenance,
		  total_print_time, success_rate, current_job, nozzle_temperatures, nozzle_targets,
		  bed_target, chamber_target, spools, fan_speeds, light_on, air_filter_on, error_message, offline_since
		) VALUES (
		  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
		  $11,$12,$13,$14,$15,
		  $16,$17,$18::jsonb,$19::jsonb,$20::jsonb,
		  $21,$22,$23::jsonb,$24::jsonb,$25,$26,$27,$28
		)
		ON CONFLICT (id) DO UPDATE SET
		  name = EXCLUDED.name, model = EXCLUDED.model, sort_order = EXCLUDED.sort_order,
		  profile = EXCLUDED.profile, url = EXCLUDED.url, ip_address = EXCLUDED.ip_address,
		  api_key_header = EXCLUDED.api_key_header, serial = EXCLUDED.serial, status = EXCLUDED.status,
		  temperature_nozzle = EXCLUDED.temperature_nozzle, temperature_bed = EXCLUDED.temperature_bed,
		  temperature_chamber = EXCLUDED.temperature_chamber, progress = EXCLUDED.progress,
		  last_maintenance = EXCLUDED.last_maintenance, total_print_time = EXCLUDED.total_print_time,
		  success_rate = EXCLUDED.success_rate, current_job = EXCLUDED.current_job,
		  nozzle_temperatures = EXCLUDED.nozzle_temperatures, nozzle_targets = EXCLUDED.nozzle_targets,
		  bed_target = EXCLUDED.bed_target, chamber_target = EXCLUDED.chamber_target,
		  spools = EXCLUDED.spools, fan_speeds = EXCLUDED.fan_speeds, light_on = EXCLUDED.light_on,
		  air_filter_on = EXCLUDED.air_filter_on, error_message = EXCLUDED.error_message,
		  offline_since = EXCLUDED.offline_since`,
		mStr(p, "id"), mStr(p, "name"), mStr(p, "model"), mInt(p, "sortOrder"), mStr(p, "profile"),
		mStr(p, "url"), mStr(p, "ipAddress"), cipher.Encrypt(mStr(p, "apiKeyHeader")), p["serial"], mStr(p, "status"),
		mFloatDef(temp, "nozzle", 0), mFloatDef(temp, "bed", 0), mFloatDef(temp, "chamber", 0),
		mInt(p, "progress"), mStr(p, "lastMaintenance"), mFloatDef(p, "totalPrintTime", 0), mFloatDef(p, "successRate", 0),
		jsonbParam(p["currentJob"]), jsonbParam(p["nozzleTemperatures"]), jsonbParam(p["nozzleTargets"]),
		p["bedTarget"], p["chamberTarget"], jsonbParam(p["spools"]), jsonbParam(p["fanSpeeds"]),
		p["lightOn"], p["airFilterOn"], p["errorMessage"], p["offlineSince"],
	)
	return err
}

// listDiscordWebhooks reads the configured Discord webhooks.
func listDiscordWebhooks(ctx context.Context, conn *pgx.Conn) ([]pmap, error) {
	rows, err := conn.Query(ctx, `
		SELECT id, name, webhook_url, events, enabled, tts
		FROM discord_webhooks ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hooks []pmap
	for rows.Next() {
		var id, name, webhookURL string
		var eventsRaw []byte
		var enabled, tts bool
		if err := rows.Scan(&id, &name, &webhookURL, &eventsRaw, &enabled, &tts); err != nil {
			return nil, err
		}
		hooks = append(hooks, pmap{
			"id": id, "name": name, "webhookUrl": webhookURL,
			"events": unmarshalJSONB(eventsRaw), "enabled": enabled, "tts": tts,
		})
	}
	return hooks, rows.Err()
}

// estimateKey identifies a slicer estimate by (printerID, jobName).
type estimateKey struct{ printerID, jobName string }

func listSlicerEstimates(ctx context.Context, conn *pgx.Conn) (map[estimateKey]float64, error) {
	rows, err := conn.Query(ctx, `SELECT printer_id, job_name, filament_grams FROM slicer_print_estimates`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[estimateKey]float64{}
	for rows.Next() {
		var pid, job string
		var grams float64
		if err := rows.Scan(&pid, &job, &grams); err != nil {
			return nil, err
		}
		out[estimateKey{pid, job}] = grams
	}
	return out, rows.Err()
}

// listSlicerSlotEstimates hydrates the per-filament-slot 3MF breakdown, the
// sibling of listSlicerEstimates's coarse total — same reload-every-cycle
// pattern (run.go calls both once per poll cycle, not just at startup).
func listSlicerSlotEstimates(ctx context.Context, conn *pgx.Conn) (map[estimateKey][]filamentSlot, error) {
	rows, err := conn.Query(ctx, `
		SELECT printer_id, job_name, filament_slots FROM slicer_print_estimates
		WHERE filament_slots IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[estimateKey][]filamentSlot{}
	for rows.Next() {
		var pid, job string
		var raw []byte
		if err := rows.Scan(&pid, &job, &raw); err != nil {
			return nil, err
		}
		var slots []filamentSlot
		if err := json.Unmarshal(raw, &slots); err != nil {
			continue // corrupt/foreign-shaped row — skip rather than fail the whole cycle
		}
		if len(slots) > 0 {
			out[estimateKey{pid, job}] = slots
		}
	}
	return out, rows.Err()
}

func recordSlicerEstimate(ctx context.Context, conn *pgx.Conn, printerID, jobName string, grams float64, slots []filamentSlot) error {
	_, err := conn.Exec(ctx, `
		INSERT INTO slicer_print_estimates (printer_id, job_name, filament_grams, filament_slots)
		VALUES ($1, $2, $3, $4::jsonb)
		ON CONFLICT (printer_id, job_name) DO UPDATE
		  SET filament_grams = EXCLUDED.filament_grams, filament_slots = EXCLUDED.filament_slots, updated_at = NOW()`,
		printerID, jobName, grams, jsonbParam(slots))
	return err
}

// findAssignedSpoolID resolves a physical AMS/external slot to the inventory
// spool bound to it, or "" if unassigned. Used by filament_consumption.go to
// turn a resolved filament slot/tray into a filament_spools row to decrement.
func findAssignedSpoolID(ctx context.Context, conn *pgx.Conn, printerID string, amsID, trayID int) (string, error) {
	var spoolID string
	err := conn.QueryRow(ctx, `
		SELECT spool_id FROM filament_station_assignments
		WHERE printer_id = $1 AND ams_id = $2 AND tray_id = $3`,
		printerID, amsID, trayID,
	).Scan(&spoolID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return spoolID, err
}

// decrementSpoolWeight increments filament_spools.weight_used by grams —
// "decrement" names the effect on remaining filament (label_weight -
// weight_used), matching Bambuddy's spool.weight_used += weight_grams.
func decrementSpoolWeight(ctx context.Context, conn *pgx.Conn, spoolID string, grams float64) error {
	if grams <= 0 {
		return nil
	}
	_, err := conn.Exec(ctx, `
		UPDATE filament_spools SET weight_used = weight_used + $1, updated_at = NOW()
		WHERE id = $2`,
		grams, spoolID)
	return err
}

func upsertPollerHealth(ctx context.Context, conn *pgx.Conn, cycleDurationMs float64, printersPolled, rowsWritten, refreshFailures int, bytesOut, bytesIn int64) error {
	_, err := conn.Exec(ctx, `
		INSERT INTO poller_health (
		  shard_index, shard_count, last_run_at,
		  cycle_duration_ms, printers_polled, rows_written, refresh_failures,
		  bytes_out, bytes_in
		) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)
		ON CONFLICT (shard_index) DO UPDATE SET
		  shard_count = EXCLUDED.shard_count, last_run_at = EXCLUDED.last_run_at,
		  cycle_duration_ms = EXCLUDED.cycle_duration_ms, printers_polled = EXCLUDED.printers_polled,
		  rows_written = EXCLUDED.rows_written, refresh_failures = EXCLUDED.refresh_failures,
		  bytes_out = EXCLUDED.bytes_out, bytes_in = EXCLUDED.bytes_in`,
		shardIndex, shardCount, cycleDurationMs, printersPolled, rowsWritten, refreshFailures, bytesOut, bytesIn)
	return err
}

// accruePrintHoursAndTriggerMaintenance adds a job's duration to the lifetime +
// nozzle counters and creates a pending maintenance event for every interval
// boundary newly crossed.
func accruePrintHoursAndTriggerMaintenance(ctx context.Context, conn *pgx.Conn, printerID string, durationHours float64) error {
	if printerID == "" || durationHours <= 0 {
		return nil
	}
	var newTotal, previousTotal float64
	err := conn.QueryRow(ctx, `
		UPDATE printers
		   SET total_print_hours = total_print_hours + $1,
		       current_nozzle_hours = current_nozzle_hours + $1
		 WHERE id = $2
		RETURNING total_print_hours, total_print_hours - $1 AS previous_total`,
		durationHours, printerID).Scan(&newTotal, &previousTotal)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}

	rows, err := conn.Query(ctx, `
		SELECT maintenance_type, interval_hours
		FROM maintenance_schedules
		WHERE printer_id = $1 AND enabled = TRUE AND interval_hours > 0
		  AND floor($2 / interval_hours) > floor($3 / interval_hours)`,
		printerID, newTotal, previousTotal)
	if err != nil {
		return err
	}
	type crossed struct {
		mType    string
		interval float64
	}
	var list []crossed
	for rows.Next() {
		var c crossed
		if err := rows.Scan(&c.mType, &c.interval); err != nil {
			rows.Close()
			return err
		}
		list = append(list, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, c := range list {
		if _, err := conn.Exec(ctx, `
			INSERT INTO maintenance_events
			  (printer_id, maintenance_type, interval_hours, triggered_at_hours, status)
			VALUES ($1, $2, $3, $4, 'pending')
			ON CONFLICT (printer_id, maintenance_type, interval_hours)
			  WHERE status = 'pending'
			DO NOTHING`,
			printerID, c.mType, c.interval, newTotal); err != nil {
			return err
		}
	}
	return nil
}

// finalizeJobAnalytics records a finished job's outcome into analytics_daily and
// accrues its runtime hours (for both completed and failed outcomes).
func finalizeJobAnalytics(ctx context.Context, conn *pgx.Conn, job pmap, outcome, printerID string) error {
	startTime := mStr(job, "startTime")
	if startTime == "" {
		return nil
	}
	startedEpoch, ok := parseISOEpoch(startTime)
	if !ok {
		return nil
	}
	finishedEpoch := time.Now().Unix()
	durationHours := float64(finishedEpoch-startedEpoch) / 3600
	if durationHours < 0 {
		durationHours = 0
	}
	filamentUsed := mFloatDef(job, "filamentUsed", 0)

	if printerID != "" {
		if err := accruePrintHoursAndTriggerMaintenance(ctx, conn, printerID, durationHours); err != nil {
			return err
		}
	}

	completed, failed := 0, 0
	if outcome == "completed" {
		completed = 1
	} else if outcome == "failed" {
		failed = 1
	}
	_, err := conn.Exec(ctx, `
		INSERT INTO analytics_daily (
		  analytics_date, completed_jobs, failed_jobs, print_time_hours, filament_used_grams, updated_at
		) VALUES (CURRENT_DATE, $1, $2, $3, $4, NOW())
		ON CONFLICT (analytics_date) DO UPDATE SET
		  completed_jobs = analytics_daily.completed_jobs + EXCLUDED.completed_jobs,
		  failed_jobs = analytics_daily.failed_jobs + EXCLUDED.failed_jobs,
		  print_time_hours = analytics_daily.print_time_hours + EXCLUDED.print_time_hours,
		  filament_used_grams = analytics_daily.filament_used_grams + EXCLUDED.filament_used_grams,
		  updated_at = NOW()`,
		completed, failed, durationHours, filamentUsed)
	return err
}

// ── small interfaces so store.go doesn't import the crypto type directly ──
type secretDecryptor interface{ Decrypt(string) string }
type secretEncryptor interface{ Encrypt(string) string }

func ptrToAny(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
func fptrToAny(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
func bptrToAny(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}
func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ownsPrinter reports whether this shard is responsible for a printer.
func ownsPrinter(printerID string) bool {
	if shardCount <= 1 {
		return true
	}
	return int(crc32sum(printerID))%shardCount == shardIndex
}
