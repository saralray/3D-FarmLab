package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"printfarm/internal/secretcrypto"
)

// store.go ports the read functions of server/postgres.js that Phase 2 needs.
//
// Every Node read returns its result already shaped by json_build_object /
// json_agg in a single JSON column, so the Go port runs the same SQL and scans
// that column straight into json.RawMessage. Emitting those bytes verbatim
// guarantees byte-identical responses (key order, number formatting, nesting)
// without re-marshaling. The only post-read transforms the Node layer applies
// are decryptPrinterSecrets (a no-op unless PRINTER_SECRET_KEY is set) and the
// optional Redis telemetry overlay — both reproduced here.

// queueFormType mirrors QUEUE_FORM_TYPE in server/postgres.js.
const queueFormType = "สั่งพิมพ์งาน 3D Print"

var printerCardLayoutProfiles = map[string]bool{
	"generic":          true,
	"snapmaker_u1":     true,
	"bambulab_a1_mini": true,
	"bambulab_h2s":     true,
	"bambulab_h2d":     true,
	"bambulab_h2c":     true,
}

var secretCipher = secretcrypto.FromEnv()

// buildPrinterListSelect mirrors buildPrinterListSelect in server/postgres.js:
// the same json_build_object, with the four connection-secret fields blanked
// when includeSensitive is false.
func buildPrinterListSelect(includeSensitive bool) string {
	url, ip, apiKey, serial := "''", "''", "''", "''"
	if includeSensitive {
		url, ip, apiKey, serial = "url", "ip_address", "api_key_header", "serial"
	}
	return fmt.Sprintf(`
    json_build_object(
      'id', id,
      'name', name,
      'model', model,
      'sortOrder', sort_order,
      'profile', profile,
      'url', %s,
      'ipAddress', %s,
      'apiKeyHeader', %s,
      'serial', %s,
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
    )`, url, ip, apiKey, serial)
}

func scanJSON(ctx context.Context, sql string, args ...any) (json.RawMessage, error) {
	var data json.RawMessage
	if err := dbPool.QueryRow(ctx, sql, args...).Scan(&data); err != nil {
		return nil, err
	}
	return data, nil
}

// listPrinters / listPrintersRedacted / getRedactedPrinterById / getPrinterById /
// getPublicPrinterById mirror the like-named exports in server/postgres.js.

func listPrintersJSON(ctx context.Context, includeSensitive bool) (json.RawMessage, error) {
	data, err := scanJSON(ctx, fmt.Sprintf(`
    SELECT COALESCE(
      json_agg(
        %s
        ORDER BY sort_order ASC, created_at DESC
      ),
      '[]'::json
    ) AS data
    FROM printers;`, buildPrinterListSelect(includeSensitive)))
	if err != nil {
		return nil, err
	}
	if includeSensitive {
		data = decryptPrintersJSON(data)
	}
	return data, nil
}

func getPrinterByIdJSON(ctx context.Context, id string, includeSensitive bool) (json.RawMessage, error) {
	data, err := scanJSON(ctx, fmt.Sprintf(
		`SELECT %s AS printer FROM printers WHERE id = $1;`,
		buildPrinterListSelect(includeSensitive)), id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if isJSONNull(data) {
		return nil, nil
	}
	if includeSensitive {
		data = decryptPrinterJSON(data)
	}
	return data, nil
}

func listDailyAnalyticsJSON(ctx context.Context, days int) (json.RawMessage, error) {
	return scanJSON(ctx, `
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
      ON a.analytics_date = d.analytics_date;`, days)
}

// listQueueJobsByPrintedStatus mirrors the like-named helper in postgres.js; the
// ORDER BY clause is a static whitelist keyed off printedStatus.
func listQueueJobsByPrintedStatus(ctx context.Context, printedStatus int) (json.RawMessage, error) {
	orderBy := "submitted_at ASC NULLS LAST, created_at ASC"
	if printedStatus == 1 {
		orderBy = "updated_at DESC, submitted_at DESC NULLS LAST, created_at DESC"
	}
	return scanJSON(ctx, fmt.Sprintf(`
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
        ORDER BY %s
      ),
      '[]'::json
    ) AS data
    FROM queue_jobs
    WHERE form_type = $1
      AND deleted_at IS NULL
      AND printed_status = $2;`, orderBy), queueFormType, printedStatus)
}

// listQueueDataJSON mirrors listQueueData: { queue, history } assembled from the
// two printed-status reads. The two RawMessages are spliced into an object so the
// queue/history arrays keep their exact server-shaped bytes.
func listQueueDataJSON(ctx context.Context) (json.RawMessage, error) {
	queue, err := listQueueJobsByPrintedStatus(ctx, 0)
	if err != nil {
		return nil, err
	}
	history, err := listQueueJobsByPrintedStatus(ctx, 1)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(queue)+len(history)+24)
	out = append(out, []byte(`{"queue":`)...)
	out = append(out, queue...)
	out = append(out, []byte(`,"history":`)...)
	out = append(out, history...)
	out = append(out, '}')
	return out, nil
}

// getAppSetting mirrors server/postgres.js getAppSetting: the stored JSON value,
// or null when the key is absent.
func getAppSetting(ctx context.Context, key string) (json.RawMessage, error) {
	var data json.RawMessage
	err := dbPool.QueryRow(ctx, `SELECT value FROM app_settings WHERE key = $1;`, key).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

// setAppSetting mirrors server/postgres.js setAppSetting: upsert the JSON value
// (stored as the JSONB column).
func setAppSetting(ctx context.Context, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = dbPool.Exec(ctx,
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = NOW();`,
		key, string(encoded))
	return err
}

func isJSONNull(b json.RawMessage) bool {
	return len(b) == 0 || string(b) == "null"
}

// ── Write paths (mirrors of the postgres.js mutators) ────────────────────────

// upsertPrinter mirrors upsertPrinter: encrypt the connection secret at rest,
// upsert configuration fields only (live telemetry is the poller's), then seed
// the printer's maintenance schedules (best-effort).
func upsertPrinter(ctx context.Context, body json.RawMessage) error {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return err
	}
	if ak, ok := m["apiKeyHeader"].(string); ok {
		m["apiKeyHeader"] = secretCipher.Encrypt(ak)
	}
	stored, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = dbPool.Exec(ctx, `
    WITH input AS (SELECT $1::jsonb AS data)
    INSERT INTO printers (
      id, name, model, sort_order, profile, url, ip_address, api_key_header,
      serial, status, temperature_nozzle, temperature_bed, progress,
      last_maintenance, total_print_time, success_rate, current_job,
      nozzle_temperatures, spools, offline_since
    )
    SELECT
      data->>'id', data->>'name', data->>'model',
      COALESCE((data->>'sortOrder')::integer, 0),
      data->>'profile', data->>'url', data->>'ipAddress', data->>'apiKeyHeader',
      data->>'serial', data->>'status',
      COALESCE((data->'temperature'->>'nozzle')::double precision, 0),
      COALESCE((data->'temperature'->>'bed')::double precision, 0),
      COALESCE((data->>'progress')::integer, 0),
      data->>'lastMaintenance',
      COALESCE((data->>'totalPrintTime')::double precision, 0),
      COALESCE((data->>'successRate')::double precision, 0),
      data->'currentJob', data->'nozzleTemperatures', data->'spools',
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
      serial = EXCLUDED.serial,
      last_maintenance = EXCLUDED.last_maintenance;`, string(stored))
	if err != nil {
		return err
	}
	if id, ok := m["id"].(string); ok && id != "" {
		_ = seedMaintenanceSchedules(ctx, id) // best-effort
	}
	return nil
}

// seedMaintenanceSchedules mirrors seedMaintenanceSchedules: idempotent insert of
// the global default intervals for one printer.
func seedMaintenanceSchedules(ctx context.Context, printerID string) error {
	intervals, err := getMaintenanceDefaultIntervals(ctx)
	if err != nil {
		return err
	}
	rows := make([]map[string]any, len(intervals))
	for i, iv := range intervals {
		rows[i] = map[string]any{"type": iv.Type, "interval_hours": iv.IntervalHours, "description": iv.Description}
	}
	payload, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = dbPool.Exec(ctx,
		`INSERT INTO maintenance_schedules (printer_id, maintenance_type, interval_hours, description)
     SELECT $1, d.type, d.interval_hours, d.description
     FROM jsonb_to_recordset($2::jsonb)
       AS d(type text, interval_hours double precision, description text)
     ON CONFLICT (printer_id, maintenance_type, interval_hours) DO NOTHING;`,
		printerID, string(payload))
	return err
}

func deletePrinter(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM printers WHERE id = $1;`, id)
	return err
}

// printerConn holds the connection fields the proxy / command / webcam paths
// need from a full (decrypted) printer record. Mirrors the subset of
// getPrinterById that handlePrinterProxy and sendBambuCommand read.
type printerConn struct {
	ID           string
	Name         string
	Profile      string
	URL          string
	IPAddress    string
	APIKeyHeader string
	Serial       string
}

// getPrinterConn loads a printer's connection fields, decrypting api_key_header
// the same way decryptPrinterSecrets does. Returns nil when the id is unknown.
func getPrinterConn(ctx context.Context, id string) (*printerConn, error) {
	var pc printerConn
	var name, profile, url, ip, apiKey, serial *string
	err := dbPool.QueryRow(ctx, `
    SELECT id, name, profile, url, ip_address, api_key_header, serial
    FROM printers WHERE id = $1;`, id).Scan(&pc.ID, &name, &profile, &url, &ip, &apiKey, &serial)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	pc.Name = derefStr(name)
	pc.Profile = derefStr(profile)
	pc.URL = derefStr(url)
	pc.IPAddress = derefStr(ip)
	pc.Serial = derefStr(serial)
	pc.APIKeyHeader = derefStr(apiKey)
	if secretCipher.Enabled() && pc.APIKeyHeader != "" {
		pc.APIKeyHeader = secretCipher.Decrypt(pc.APIKeyHeader)
	}
	return &pc, nil
}

// getPrinterConnByIdOrName mirrors getPrinterByIdOrName: an exact id match wins
// over a case-insensitive name match. Used by the friendly /webcam/<id-or-name>
// stream URL.
func getPrinterConnByIdOrName(ctx context.Context, identifier string) (*printerConn, error) {
	var id string
	err := dbPool.QueryRow(ctx, `
    SELECT id FROM printers
    WHERE id = $1 OR lower(name) = lower($1)
    ORDER BY (id = $1) DESC
    LIMIT 1;`, identifier).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return getPrinterConn(ctx, id)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// markQueueJobPrinted mirrors postgres.js: marking a job printed also clears the
// stored model file (file_content/file_mime/file_size_bytes) to reclaim storage.
func markQueueJobPrinted(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE queue_jobs
		 SET printed_status = 1, updated_at = NOW(),
		     file_content = NULL, file_mime = NULL, file_size_bytes = 0
		 WHERE id = $1 AND deleted_at IS NULL;`, id)
	return err
}

func resetQueueJobs(ctx context.Context) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE queue_jobs SET printed_status = 0, updated_at = NOW() WHERE form_type = $1 AND deleted_at IS NULL;`,
		queueFormType)
	return err
}

func deleteQueueJob(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE queue_jobs SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1;`, id)
	return err
}

func resetDailyAnalytics(ctx context.Context) error {
	_, err := dbPool.Exec(ctx, `TRUNCATE TABLE analytics_daily;`)
	return err
}

// listAuditLogsJSON mirrors listAuditLogs: json_agg of audit entries (createdAt
// via to_char so it matches Node's to_char path), limit clamped 1..1000.
func listAuditLogsJSON(ctx context.Context, limit int) (json.RawMessage, error) {
	if limit <= 0 {
		limit = 200
	}
	limit = clampInt(limit, 1, 1000)
	return scanJSON(ctx, `
    SELECT COALESCE(json_agg(entry ORDER BY created_at DESC, id DESC), '[]'::json) AS data
    FROM (
      SELECT id, created_at,
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
    ) recent;`, limit)
}

// decryptPrintersJSON / decryptPrinterJSON reproduce decryptPrinterSecrets for
// the full (sensitive) read path. When encryption is disabled (the common case,
// and always so in Phase 2 since the privileged path isn't reachable until
// sessions land) this is a pure passthrough that preserves the raw bytes.
func decryptPrintersJSON(b json.RawMessage) json.RawMessage {
	if !secretCipher.Enabled() || isJSONNull(b) {
		return b
	}
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(b, &arr); err != nil {
		return b
	}
	for _, p := range arr {
		decryptPrinterMap(p)
	}
	out, err := json.Marshal(arr)
	if err != nil {
		return b
	}
	return out
}

func decryptPrinterJSON(b json.RawMessage) json.RawMessage {
	if !secretCipher.Enabled() || isJSONNull(b) {
		return b
	}
	var p map[string]json.RawMessage
	if err := json.Unmarshal(b, &p); err != nil {
		return b
	}
	decryptPrinterMap(p)
	out, err := json.Marshal(p)
	if err != nil {
		return b
	}
	return out
}

func decryptPrinterMap(p map[string]json.RawMessage) {
	raw, ok := p["apiKeyHeader"]
	if !ok {
		return
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || s == "" {
		return
	}
	dec, err := json.Marshal(secretCipher.Decrypt(s))
	if err != nil {
		return
	}
	p["apiKeyHeader"] = dec
}
