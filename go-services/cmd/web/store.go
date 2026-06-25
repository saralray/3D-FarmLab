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

func isJSONNull(b json.RawMessage) bool {
	return len(b) == 0 || string(b) == "null"
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
