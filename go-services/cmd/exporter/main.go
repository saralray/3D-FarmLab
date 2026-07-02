// Command exporter is the Go port of exporter/printfarm_exporter.py: a
// standalone, read-only Prometheus exporter that reads the `printers`,
// `analytics_daily`, `queue_jobs` and `poller_health` tables fresh on every
// scrape and exposes them under the printfarm_* namespace on EXPORTER_PORT
// (default 9180, path /metrics). A database error is reported as
// printfarm_scrape_success 0 rather than crashing the process.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"printfarm/internal/db"
	"printfarm/internal/metrics"
	"printfarm/internal/procmetrics"
)

const (
	// Only these queue rows are real print-queue jobs (matches QUEUE_FORM_TYPE
	// in server/postgres.js); soft-deleted rows are excluded.
	queueFormType = "สั่งพิมพ์งาน 3D Print"
	// The only status that counts as "down" for printfarm_printer_up.
	offlineStatus = "offline"
)

func main() {
	port := db.EnvInt("EXPORTER_PORT", 9180, 1)
	connectTimeout := time.Duration(db.EnvInt("EXPORTER_DB_TIMEOUT_SECONDS", 5, 1)) * time.Second
	statementTimeoutMs := db.EnvInt("DATABASE_STATEMENT_TIMEOUT_MS", 30000, 0)

	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		body := collect(connectTimeout, statementTimeoutMs)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(body))
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/metrics", http.StatusFound)
	})

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	log.Printf("printfarm exporter listening on :%d/metrics", port)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("exporter http server failed: %v", err)
	}
}

// collect runs every query on a fresh connection and renders the metrics. On any
// error it still returns a valid body with printfarm_scrape_success 0.
func collect(connectTimeout time.Duration, statementTimeoutMs int) string {
	started := time.Now()
	w := metrics.NewWriter()
	success := 1.0

	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout+30*time.Second)
	defer cancel()

	if err := build(ctx, w, connectTimeout, statementTimeoutMs); err != nil {
		success = 0
		// Reset any partially-built families: a scrape is all-or-nothing.
		w = metrics.NewWriter()
		fmt.Fprintf(os.Stderr, "printfarm exporter scrape error: %v\n", err)
	}

	w.Gauge("printfarm_scrape_success",
		"1 if the last scrape read the database successfully, else 0",
		success, nil, nil)
	w.Gauge("printfarm_scrape_duration_seconds",
		"Seconds the exporter spent collecting from the database",
		time.Since(started).Seconds(), nil, nil)

	// Standard process_* metrics, mirroring prometheus_client's default
	// collector so the exporter is a drop-in replacement.
	procmetrics.Add(w)
	return w.String()
}

func build(ctx context.Context, w *metrics.Writer, connectTimeout time.Duration, statementTimeoutMs int) error {
	conn, err := db.Connect(ctx, connectTimeout, statementTimeoutMs)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	if err := printerMetrics(ctx, conn, w); err != nil {
		return err
	}
	if err := analyticsMetrics(ctx, conn, w); err != nil {
		return err
	}
	if err := queueMetric(ctx, conn, w); err != nil {
		return err
	}
	if err := pollerMetrics(ctx, conn, w); err != nil {
		return err
	}
	if err := networkUsageMetrics(ctx, conn, w); err != nil {
		return err
	}
	return nil
}

func f(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func s(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func printerMetrics(ctx context.Context, conn *pgx.Conn, w *metrics.Writer) error {
	rows, err := conn.Query(ctx, `
		SELECT id, name, model, profile, status,
		       temperature_nozzle, temperature_bed, progress,
		       total_print_time, success_rate
		FROM printers;`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type printerRow struct {
		name                                               string
		id, model, profile, status                         string
		nozzle, bed, progress, totalPrintTime, successRate float64
	}
	var printers []printerRow
	statusCounts := map[string]int{}
	total := 0

	for rows.Next() {
		var id, name, model, profile, status *string
		var nozzle, bed, progress, totalPT, succ *float64
		if err := rows.Scan(&id, &name, &model, &profile, &status,
			&nozzle, &bed, &progress, &totalPT, &succ); err != nil {
			return err
		}
		// Fall back to the id only if a printer somehow has no name, so value
		// metrics always carry a usable, non-empty label.
		nm := s(name)
		if nm == "" {
			nm = s(id)
		}
		st := s(status)
		if st == "" {
			st = "unknown"
		}
		total++
		statusCounts[st]++
		printers = append(printers, printerRow{
			name: nm, id: s(id), model: s(model), profile: s(profile), status: st,
			nozzle: f(nozzle), bed: f(bed), progress: f(progress),
			totalPrintTime: f(totalPT), successRate: f(succ),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, p := range printers {
		w.Gauge("printfarm_printer_info", "Printer metadata; value is always 1", 1,
			[]string{"id", "name", "model", "profile", "status"},
			[]string{p.id, p.name, p.model, p.profile, p.status})
	}
	for _, p := range printers {
		up := 1.0
		if p.status == offlineStatus {
			up = 0
		}
		w.Gauge("printfarm_printer_up", "1 if the printer is not offline, else 0", up,
			[]string{"name"}, []string{p.name})
	}
	gaugeByName := func(name, help string, val func(printerRow) float64) {
		for _, p := range printers {
			w.Gauge(name, help, val(p), []string{"name"}, []string{p.name})
		}
	}
	gaugeByName("printfarm_printer_nozzle_temperature_celsius", "Current nozzle temperature in Celsius",
		func(p printerRow) float64 { return p.nozzle })
	gaugeByName("printfarm_printer_bed_temperature_celsius", "Current bed temperature in Celsius",
		func(p printerRow) float64 { return p.bed })
	gaugeByName("printfarm_printer_progress_percent", "Current print progress, 0-100",
		func(p printerRow) float64 { return p.progress })
	gaugeByName("printfarm_printer_total_print_time_hours", "Lifetime print-time counter for the printer, in hours",
		func(p printerRow) float64 { return p.totalPrintTime })
	gaugeByName("printfarm_printer_success_rate_percent", "Reported print success rate, 0-100",
		func(p printerRow) float64 { return p.successRate })

	w.Gauge("printfarm_printers_total", "Total number of printers", float64(total), nil, nil)

	for st, count := range statusCounts {
		w.Gauge("printfarm_printers_by_status", "Number of printers in each status",
			float64(count), []string{"status"}, []string{st})
	}

	// Per-state printer counts mirroring the dashboard's status summary. "online"
	// counts every printer that is not offline; the rest are exact matches.
	offlineCount := statusCounts[offlineStatus]
	w.Gauge("printfarm_printer_online", "Printers that are not offline", float64(total-offlineCount), nil, nil)
	w.Gauge("printfarm_printer_offline", "Printers with status 'offline'", float64(offlineCount), nil, nil)
	w.Gauge("printfarm_printer_printing", "Printers with status 'printing'", float64(statusCounts["printing"]), nil, nil)
	w.Gauge("printfarm_printer_pause", "Printers with status 'paused'", float64(statusCounts["paused"]), nil, nil)
	w.Gauge("printfarm_printer_error", "Printers with status 'error'", float64(statusCounts["error"]), nil, nil)
	return nil
}

func analyticsMetrics(ctx context.Context, conn *pgx.Conn, w *metrics.Writer) error {
	var totalCompleted, totalFailed, totalHours, totalFilament float64
	if err := conn.QueryRow(ctx, `
		SELECT COALESCE(SUM(completed_jobs), 0),
		       COALESCE(SUM(failed_jobs), 0),
		       COALESCE(SUM(print_time_hours), 0),
		       COALESCE(SUM(filament_used_grams), 0)
		FROM analytics_daily;`).Scan(&totalCompleted, &totalFailed, &totalHours, &totalFilament); err != nil {
		return err
	}

	var todayCompleted, todayFailed, todayHours, todayFilament float64
	err := conn.QueryRow(ctx, `
		SELECT COALESCE(completed_jobs, 0), COALESCE(failed_jobs, 0),
		       COALESCE(print_time_hours, 0), COALESCE(filament_used_grams, 0)
		FROM analytics_daily
		WHERE analytics_date = CURRENT_DATE;`).Scan(&todayCompleted, &todayFailed, &todayHours, &todayFilament)
	if err == pgx.ErrNoRows {
		todayCompleted, todayFailed, todayHours, todayFilament = 0, 0, 0, 0
	} else if err != nil {
		return err
	}

	totalJobs := totalCompleted + totalFailed
	successRate := 0.0
	if totalJobs > 0 {
		successRate = totalCompleted / totalJobs * 100
	}
	todayJobs := todayCompleted + todayFailed
	todaySuccessRate := 0.0
	if todayJobs > 0 {
		todaySuccessRate = todayCompleted / todayJobs * 100
	}
	avgPrintTime := 0.0
	if totalCompleted > 0 {
		avgPrintTime = totalHours / totalCompleted
	}
	todayAvgPrintTime := 0.0
	if todayCompleted > 0 {
		todayAvgPrintTime = todayHours / todayCompleted
	}

	w.Counter("printfarm_jobs_completed", "Cumulative completed print jobs", totalCompleted, nil, nil)
	w.Counter("printfarm_jobs_failed", "Cumulative failed print jobs", totalFailed, nil, nil)
	w.Counter("printfarm_print_time_hours", "Cumulative print time across all jobs, in hours", totalHours, nil, nil)
	w.Counter("printfarm_filament_grams", "Cumulative filament used across all jobs, in grams", totalFilament, nil, nil)
	w.Gauge("printfarm_jobs_completed_today", "Completed print jobs today", todayCompleted, nil, nil)
	w.Gauge("printfarm_jobs_failed_today", "Failed print jobs today", todayFailed, nil, nil)
	w.Gauge("printfarm_print_time_hours_today", "Print time today, in hours", todayHours, nil, nil)
	w.Gauge("printfarm_filament_grams_today", "Filament used today, in grams", todayFilament, nil, nil)
	w.Gauge("printfarm_success_rate_percent",
		"Overall success rate: completed / (completed + failed) * 100", successRate, nil, nil)
	w.Gauge("printfarm_success_rate_percent_today",
		"Success rate for today's jobs, 0-100", todaySuccessRate, nil, nil)
	w.Gauge("printfarm_avg_print_time_hours",
		"Average print time per completed job, in hours", avgPrintTime, nil, nil)
	w.Gauge("printfarm_avg_print_time_hours_today",
		"Average print time per completed job today, in hours", todayAvgPrintTime, nil, nil)
	return nil
}

func queueMetric(ctx context.Context, conn *pgx.Conn, w *metrics.Writer) error {
	rows, err := conn.Query(ctx, `
		SELECT printed_status, COUNT(*)
		FROM queue_jobs
		WHERE form_type = $1 AND deleted_at IS NULL
		GROUP BY printed_status;`, queueFormType)
	if err != nil {
		return err
	}
	defer rows.Close()

	counts := map[int]int64{}
	for rows.Next() {
		var status *int
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return err
		}
		key := 0
		if status != nil {
			key = *status
		}
		counts[key] = count
	}
	if err := rows.Err(); err != nil {
		return err
	}

	w.Gauge("printfarm_queue_jobs", "Print-queue jobs by state", float64(counts[0]), []string{"state"}, []string{"queued"})
	w.Gauge("printfarm_queue_jobs", "Print-queue jobs by state", float64(counts[1]), []string{"state"}, []string{"completed"})
	return nil
}

func pollerMetrics(ctx context.Context, conn *pgx.Conn, w *metrics.Writer) error {
	// Tolerate the table not existing yet (a DB where the poller hasn't run).
	var regclass *string
	if err := conn.QueryRow(ctx, `SELECT to_regclass('public.poller_health');`).Scan(&regclass); err != nil {
		return err
	}
	if regclass == nil {
		return nil
	}

	rows, err := conn.Query(ctx, `
		SELECT shard_index, shard_count,
		       EXTRACT(EPOCH FROM last_run_at),
		       cycle_duration_ms, printers_polled, rows_written,
		       refresh_failures
		FROM poller_health;`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type healthRow struct {
		shard                     string
		lastRun, cycleSeconds     float64
		polled, written, failures float64
	}
	var health []healthRow
	maxShardCount := 1

	for rows.Next() {
		var idx, count *int
		var lastEpoch, durMs *float64
		var polled, written, failures *int
		if err := rows.Scan(&idx, &count, &lastEpoch, &durMs, &polled, &written, &failures); err != nil {
			return err
		}
		shard := "0"
		if idx != nil {
			shard = fmt.Sprintf("%d", *idx)
		}
		cnt := 1
		if count != nil {
			cnt = *count
		}
		if cnt > maxShardCount {
			maxShardCount = cnt
		}
		toF := func(p *int) float64 {
			if p == nil {
				return 0
			}
			return float64(*p)
		}
		health = append(health, healthRow{
			shard:        shard,
			lastRun:      f(lastEpoch),
			cycleSeconds: f(durMs) / 1000.0,
			polled:       toF(polled),
			written:      toF(written),
			failures:     toF(failures),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, h := range health {
		w.Gauge("printfarm_poller_last_run_timestamp_seconds",
			"Unix time of the shard's last completed poll cycle (alert when stale)",
			h.lastRun, []string{"shard"}, []string{h.shard})
	}
	for _, h := range health {
		w.Gauge("printfarm_poller_cycle_duration_seconds",
			"Duration of the shard's last poll cycle, in seconds",
			h.cycleSeconds, []string{"shard"}, []string{h.shard})
	}
	for _, h := range health {
		w.Gauge("printfarm_poller_printers_polled",
			"Printers the shard polled in its last cycle",
			h.polled, []string{"shard"}, []string{h.shard})
	}
	for _, h := range health {
		w.Gauge("printfarm_poller_rows_written",
			"Printer rows the shard wrote to Postgres in its last cycle",
			h.written, []string{"shard"}, []string{h.shard})
	}
	for _, h := range health {
		w.Gauge("printfarm_poller_refresh_failures",
			"Printers whose refresh failed (fell back to offline grace) last cycle",
			h.failures, []string{"shard"}, []string{h.shard})
	}
	w.Gauge("printfarm_poller_shard_count", "Number of poller shards configured",
		float64(maxShardCount), nil, nil)
	return nil
}

// networkUsageMetrics exposes the web tier's approximate app-layer traffic
// (server/metrics.js counters, flushed once a minute into network_usage_daily
// — see the Network Usage admin page) as durable Prometheus series: an
// all-time counter per route/direction that survives web-container restarts
// (unlike the raw in-process counters at web:5173/metrics, which reset on
// restart), plus a today gauge for at-a-glance dashboards.
func networkUsageMetrics(ctx context.Context, conn *pgx.Conn, w *metrics.Writer) error {
	// Tolerate the table not existing yet (a DB predating this feature).
	var regclass *string
	if err := conn.QueryRow(ctx, `SELECT to_regclass('public.network_usage_daily');`).Scan(&regclass); err != nil {
		return err
	}
	if regclass == nil {
		return nil
	}

	type usageRow struct {
		route                       string
		bytesOut, bytesIn, requests float64
	}

	totalRows, err := conn.Query(ctx, `
		SELECT route, SUM(bytes)::float8, SUM(bytes_in)::float8, SUM(requests)::float8
		FROM network_usage_daily
		GROUP BY route;`)
	if err != nil {
		return err
	}
	defer totalRows.Close()

	var totals []usageRow
	for totalRows.Next() {
		var row usageRow
		if err := totalRows.Scan(&row.route, &row.bytesOut, &row.bytesIn, &row.requests); err != nil {
			return err
		}
		totals = append(totals, row)
	}
	if err := totalRows.Err(); err != nil {
		return err
	}

	for _, r := range totals {
		w.Counter("printfarm_network_usage_bytes_out",
			"Cumulative outbound (response) bytes served, by route category",
			r.bytesOut, []string{"route"}, []string{r.route})
	}
	for _, r := range totals {
		w.Counter("printfarm_network_usage_bytes_in",
			"Cumulative inbound (request) bytes received, by route category",
			r.bytesIn, []string{"route"}, []string{r.route})
	}
	for _, r := range totals {
		w.Counter("printfarm_network_usage_requests",
			"Cumulative requests handled, by route category",
			r.requests, []string{"route"}, []string{r.route})
	}

	todayRows, err := conn.Query(ctx, `
		SELECT route, bytes::float8, bytes_in::float8, requests::float8
		FROM network_usage_daily
		WHERE usage_date = CURRENT_DATE;`)
	if err != nil {
		return err
	}
	defer todayRows.Close()

	var today []usageRow
	for todayRows.Next() {
		var row usageRow
		if err := todayRows.Scan(&row.route, &row.bytesOut, &row.bytesIn, &row.requests); err != nil {
			return err
		}
		today = append(today, row)
	}
	if err := todayRows.Err(); err != nil {
		return err
	}

	for _, r := range today {
		w.Gauge("printfarm_network_usage_bytes_out_today",
			"Outbound (response) bytes served today, by route category",
			r.bytesOut, []string{"route"}, []string{r.route})
	}
	for _, r := range today {
		w.Gauge("printfarm_network_usage_bytes_in_today",
			"Inbound (request) bytes received today, by route category",
			r.bytesIn, []string{"route"}, []string{r.route})
	}
	return nil
}
