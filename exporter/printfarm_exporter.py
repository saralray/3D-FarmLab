"""Prometheus exporter for the STEM Lab Print Farm.

A standalone, read-only service that mirrors the poller's database pattern
(psycopg + DATABASE_URL) but, instead of writing printer state, exposes the
contents of the `printers`, `analytics_daily`, and `queue_jobs` tables as
Prometheus metrics on EXPORTER_PORT (default 9180, path /metrics).

Every scrape reads the database fresh via a custom collector, so values are
always current and nothing has to be kept in memory between scrapes. A database
error is surfaced as `printfarm_scrape_success 0` rather than crashing the
process, so a brief database blip never takes the exporter down.
"""

import os
import time

import psycopg
from prometheus_client import REGISTRY, start_http_server
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily

EXPORTER_PORT = int(os.getenv("EXPORTER_PORT", "9180"))
# Cap how long a single scrape waits to reach PostgreSQL; a hung connect would
# otherwise stall the scrape until Prometheus's own scrape_timeout fires.
DB_CONNECT_TIMEOUT_SECONDS = max(int(os.getenv("EXPORTER_DB_TIMEOUT_SECONDS", "5")), 1)
# Also bound each scrape query server-side, so a slow/locked query fails the
# scrape fast (reported as printfarm_scrape_success 0) instead of hanging.
DB_STATEMENT_TIMEOUT_MS = max(int(os.getenv("DATABASE_STATEMENT_TIMEOUT_MS", "30000")), 0)

# Only "สั่งพิมพ์งาน 3D Print" rows are real print-queue jobs (matches
# QUEUE_FORM_TYPE in server/postgres.js); soft-deleted rows are excluded.
QUEUE_FORM_TYPE = "สั่งพิมพ์งาน 3D Print"

# A printer in this status is the only state that counts as "down" for
# printfarm_printer_up; every other reported state means the box is reachable.
OFFLINE_STATUS = "offline"


def db_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    return url


class PrintFarmCollector:
    """Reads the print-farm tables on every scrape and yields metric families."""

    def collect(self):
        started = time.perf_counter()
        success = 1
        metrics = []
        try:
            with psycopg.connect(
                db_url(),
                connect_timeout=DB_CONNECT_TIMEOUT_SECONDS,
                options=f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}",
            ) as conn:
                metrics = self._build_metrics(conn)
        except Exception as error:  # noqa: BLE001 - report as a failed scrape, never crash
            success = 0
            print(f"printfarm exporter scrape error: {error}", flush=True)

        yield from metrics

        scrape_success = GaugeMetricFamily(
            "printfarm_scrape_success",
            "1 if the last scrape read the database successfully, else 0",
        )
        scrape_success.add_metric([], success)
        yield scrape_success

        duration = GaugeMetricFamily(
            "printfarm_scrape_duration_seconds",
            "Seconds the exporter spent collecting from the database",
        )
        duration.add_metric([], time.perf_counter() - started)
        yield duration

    def _build_metrics(self, conn):
        """Run every query and build the metric families, or raise on failure.

        Returns the complete list only when all queries succeed, so a scrape is
        all-or-nothing: a partial result is never published.
        """
        metrics = []
        metrics.extend(self._printer_metrics(conn))
        metrics.extend(self._analytics_metrics(conn))
        metrics.append(self._queue_metric(conn))
        metrics.extend(self._poller_metrics(conn))
        return metrics

    def _poller_metrics(self, conn):
        """Poller liveness/lag from the poller_health table (one row per shard).
        Tolerates the table not existing yet (a DB where the poller hasn't run),
        returning no poller metrics rather than failing the whole scrape."""
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.poller_health');")
            if cur.fetchone()[0] is None:
                return []

        last_run = GaugeMetricFamily(
            "printfarm_poller_last_run_timestamp_seconds",
            "Unix time of the shard's last completed poll cycle (alert when stale)",
            labels=["shard"],
        )
        cycle_duration = GaugeMetricFamily(
            "printfarm_poller_cycle_duration_seconds",
            "Duration of the shard's last poll cycle, in seconds",
            labels=["shard"],
        )
        printers_polled = GaugeMetricFamily(
            "printfarm_poller_printers_polled",
            "Printers the shard polled in its last cycle",
            labels=["shard"],
        )
        rows_written = GaugeMetricFamily(
            "printfarm_poller_rows_written",
            "Printer rows the shard wrote to Postgres in its last cycle",
            labels=["shard"],
        )
        refresh_failures = GaugeMetricFamily(
            "printfarm_poller_refresh_failures",
            "Printers whose refresh failed (fell back to offline grace) last cycle",
            labels=["shard"],
        )
        shard_count = GaugeMetricFamily(
            "printfarm_poller_shard_count",
            "Number of poller shards configured",
        )

        max_shard_count = 1
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT shard_index, shard_count,
                       EXTRACT(EPOCH FROM last_run_at),
                       cycle_duration_ms, printers_polled, rows_written,
                       refresh_failures
                FROM poller_health;
                """
            )
            for (idx, count, last_epoch, dur_ms, polled, written, failures) in cur:
                shard = str(idx)
                last_run.add_metric([shard], float(last_epoch or 0))
                cycle_duration.add_metric([shard], float(dur_ms or 0) / 1000.0)
                printers_polled.add_metric([shard], int(polled or 0))
                rows_written.add_metric([shard], int(written or 0))
                refresh_failures.add_metric([shard], int(failures or 0))
                max_shard_count = max(max_shard_count, int(count or 1))

        shard_count.add_metric([], max_shard_count)
        return [last_run, cycle_duration, printers_polled, rows_written,
                refresh_failures, shard_count]

    def _printer_metrics(self, conn):
        # Per-printer value metrics are labelled by the human-readable `name`
        # alone, so Grafana legends read "Bambu A1 #1" instead of being cluttered
        # with the opaque internal id. The id (and the rest of the metadata) lives
        # only on printfarm_printer_info, which can be joined on `name` when the
        # id is genuinely needed.
        printer_info = GaugeMetricFamily(
            "printfarm_printer_info",
            "Printer metadata; value is always 1",
            labels=["id", "name", "model", "profile", "status"],
        )
        printer_up = GaugeMetricFamily(
            "printfarm_printer_up",
            "1 if the printer is not offline, else 0",
            labels=["name"],
        )
        nozzle_temp = GaugeMetricFamily(
            "printfarm_printer_nozzle_temperature_celsius",
            "Current nozzle temperature in Celsius",
            labels=["name"],
        )
        bed_temp = GaugeMetricFamily(
            "printfarm_printer_bed_temperature_celsius",
            "Current bed temperature in Celsius",
            labels=["name"],
        )
        progress = GaugeMetricFamily(
            "printfarm_printer_progress_percent",
            "Current print progress, 0-100",
            labels=["name"],
        )
        print_time = GaugeMetricFamily(
            "printfarm_printer_total_print_time_hours",
            "Lifetime print-time counter for the printer, in hours",
            labels=["name"],
        )
        success_rate = GaugeMetricFamily(
            "printfarm_printer_success_rate_percent",
            "Reported print success rate, 0-100",
            labels=["name"],
        )

        status_counts = {}
        printer_total = 0

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, model, profile, status,
                       temperature_nozzle, temperature_bed, progress,
                       total_print_time, success_rate
                FROM printers;
                """
            )
            for (pid, name, model, profile, status, t_nozzle, t_bed, prog,
                 total_pt, succ) in cur:
                # Fall back to the id only if a printer somehow has no name, so
                # the value metrics always carry a usable, non-empty label.
                name = name or pid
                status = status or "unknown"
                printer_total += 1
                status_counts[status] = status_counts.get(status, 0) + 1

                labels = [name]
                printer_info.add_metric([pid, name, model or "", profile or "", status], 1)
                printer_up.add_metric(labels, 0 if status == OFFLINE_STATUS else 1)
                nozzle_temp.add_metric(labels, float(t_nozzle or 0))
                bed_temp.add_metric(labels, float(t_bed or 0))
                progress.add_metric(labels, float(prog or 0))
                print_time.add_metric(labels, float(total_pt or 0))
                success_rate.add_metric(labels, float(succ or 0))

        printers_total = GaugeMetricFamily(
            "printfarm_printers_total", "Total number of printers"
        )
        printers_total.add_metric([], printer_total)

        by_status = GaugeMetricFamily(
            "printfarm_printers_by_status",
            "Number of printers in each status",
            labels=["status"],
        )
        for status, count in status_counts.items():
            by_status.add_metric([status], count)

        # Per-state printer counts as individually named gauges, mirroring the
        # dashboard's status summary (src/app/pages/Dashboard.tsx:62-67).
        # "online" counts every printer that is not offline (so a
        # printing/paused/error printer is still online), matching the UI's
        # `status !== 'offline'`; the rest are exact status matches.
        offline_count = status_counts.get(OFFLINE_STATUS, 0)
        state_gauges = [
            self._gauge("printfarm_printer_online",
                        "Printers that are not offline", printer_total - offline_count),
            self._gauge("printfarm_printer_offline",
                        "Printers with status 'offline'", offline_count),
            self._gauge("printfarm_printer_printing",
                        "Printers with status 'printing'", status_counts.get("printing", 0)),
            self._gauge("printfarm_printer_pause",
                        "Printers with status 'paused'", status_counts.get("paused", 0)),
            self._gauge("printfarm_printer_error",
                        "Printers with status 'error'", status_counts.get("error", 0)),
        ]

        return [printer_info, printer_up, nozzle_temp, bed_temp, progress,
                print_time, success_rate, printers_total, by_status, *state_gauges]

    def _analytics_metrics(self, conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(SUM(completed_jobs), 0),
                       COALESCE(SUM(failed_jobs), 0),
                       COALESCE(SUM(print_time_hours), 0),
                       COALESCE(SUM(filament_used_grams), 0)
                FROM analytics_daily;
                """
            )
            total_completed, total_failed, total_hours, total_filament = cur.fetchone()

            cur.execute(
                """
                SELECT COALESCE(completed_jobs, 0), COALESCE(failed_jobs, 0),
                       COALESCE(print_time_hours, 0), COALESCE(filament_used_grams, 0)
                FROM analytics_daily
                WHERE analytics_date = CURRENT_DATE;
                """
            )
            today = cur.fetchone() or (0, 0, 0, 0)

        # Success rate, mirroring the Analytics page (src/app/pages/Analytics.tsx):
        # completed / (completed + failed) * 100, and 0 when there are no jobs.
        total_jobs = (total_completed or 0) + (total_failed or 0)
        success_rate = (total_completed / total_jobs * 100) if total_jobs else 0
        today_jobs = (today[0] or 0) + (today[1] or 0)
        today_success_rate = (today[0] / today_jobs * 100) if today_jobs else 0

        # Average print time per completed job, matching the Analytics page's
        # "Avg Print Time" card (total print time / completed jobs, 0 when none).
        avg_print_time = (total_hours / total_completed) if total_completed else 0
        today_avg_print_time = (today[2] / today[0]) if today[0] else 0

        return [
            # Cumulative counters. The admin "reset analytics" TRUNCATEs the
            # table; Prometheus treats the drop to 0 as a normal counter reset.
            self._counter("printfarm_jobs_completed", "Cumulative completed print jobs", total_completed),
            self._counter("printfarm_jobs_failed", "Cumulative failed print jobs", total_failed),
            self._counter("printfarm_print_time_hours", "Cumulative print time across all jobs, in hours", total_hours),
            self._counter("printfarm_filament_grams", "Cumulative filament used across all jobs, in grams", total_filament),
            # Today's running totals, exposed directly for convenience.
            self._gauge("printfarm_jobs_completed_today", "Completed print jobs today", today[0]),
            self._gauge("printfarm_jobs_failed_today", "Failed print jobs today", today[1]),
            self._gauge("printfarm_print_time_hours_today", "Print time today, in hours", today[2]),
            self._gauge("printfarm_filament_grams_today", "Filament used today, in grams", today[3]),
            # Success rate, matching the Analytics page's headline card.
            self._gauge("printfarm_success_rate_percent",
                        "Overall success rate: completed / (completed + failed) * 100", success_rate),
            self._gauge("printfarm_success_rate_percent_today",
                        "Success rate for today's jobs, 0-100", today_success_rate),
            # Average print time per completed job, matching the Analytics page.
            self._gauge("printfarm_avg_print_time_hours",
                        "Average print time per completed job, in hours", avg_print_time),
            self._gauge("printfarm_avg_print_time_hours_today",
                        "Average print time per completed job today, in hours", today_avg_print_time),
        ]

    def _queue_metric(self, conn):
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT printed_status, COUNT(*)
                FROM queue_jobs
                WHERE form_type = %s AND deleted_at IS NULL
                GROUP BY printed_status;
                """,
                (QUEUE_FORM_TYPE,),
            )
            counts = dict(cur.fetchall())

        queue = GaugeMetricFamily(
            "printfarm_queue_jobs",
            "Print-queue jobs by state",
            labels=["state"],
        )
        queue.add_metric(["queued"], counts.get(0, 0))
        queue.add_metric(["completed"], counts.get(1, 0))
        return queue

    @staticmethod
    def _counter(name, documentation, value):
        # CounterMetricFamily appends the _total suffix to the exposed sample.
        counter = CounterMetricFamily(name, documentation)
        counter.add_metric([], float(value or 0))
        return counter

    @staticmethod
    def _gauge(name, documentation, value):
        gauge = GaugeMetricFamily(name, documentation)
        gauge.add_metric([], float(value or 0))
        return gauge


def main() -> None:
    REGISTRY.register(PrintFarmCollector())
    start_http_server(EXPORTER_PORT, addr="0.0.0.0")
    print(f"printfarm exporter listening on :{EXPORTER_PORT}/metrics", flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
