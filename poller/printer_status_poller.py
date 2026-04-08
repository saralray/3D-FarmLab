import calendar
import json
import os
import time
from typing import Any

import psycopg
import requests

POLL_INTERVAL_SECONDS = max(int(os.getenv("PRINTER_POLL_INTERVAL_MS", "5000")) / 1000, 1)
REQUEST_TIMEOUT_SECONDS = max(int(os.getenv("PRINTER_REQUEST_TIMEOUT_MS", "3000")) / 1000, 1)

SCHEMA_SQL = """
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
SELECT pg_advisory_unlock(90210);
"""

SNAPMAKER_STATUS_PATH = (
    "/printer/objects/query?print_stats&extruder=temperature,target"
    "&extruder1=temperature,target&extruder2=temperature,target"
    "&extruder3=temperature,target&heater_bed=temperature,target"
)


def db_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    return url


def ensure_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(SCHEMA_SQL)
    conn.commit()


def list_printers(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
              id,
              name,
              model,
              sort_order AS "sortOrder",
              profile,
              url,
              ip_address AS "ipAddress",
              api_key_header AS "apiKeyHeader",
              status,
              json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed) AS temperature,
              progress,
              last_maintenance AS "lastMaintenance",
              total_print_time AS "totalPrintTime",
              success_rate AS "successRate",
              current_job AS "currentJob",
              nozzle_temperatures AS "nozzleTemperatures",
              spools
            FROM printers
            ORDER BY sort_order ASC, created_at DESC
            """
        )
        return list(cur.fetchall())


def upsert_printer(conn: psycopg.Connection, printer: dict[str, Any]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
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
            ) VALUES (
              %(id)s,
              %(name)s,
              %(model)s,
              %(sortOrder)s,
              %(profile)s,
              %(url)s,
              %(ipAddress)s,
              %(apiKeyHeader)s,
              %(status)s,
              %(temperature_nozzle)s,
              %(temperature_bed)s,
              %(progress)s,
              %(lastMaintenance)s,
              %(totalPrintTime)s,
              %(successRate)s,
              %(currentJob)s::jsonb,
              %(nozzleTemperatures)s::jsonb,
              %(spools)s::jsonb
            )
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
              spools = EXCLUDED.spools
            """,
            {
                "id": printer["id"],
                "name": printer["name"],
                "model": printer["model"],
                "sortOrder": printer.get("sortOrder", 0),
                "profile": printer["profile"],
                "url": printer["url"],
                "ipAddress": printer["ipAddress"],
                "apiKeyHeader": printer.get("apiKeyHeader", ""),
                "status": printer["status"],
                "temperature_nozzle": printer.get("temperature", {}).get("nozzle", 0),
                "temperature_bed": printer.get("temperature", {}).get("bed", 0),
                "progress": printer.get("progress", 0),
                "lastMaintenance": printer["lastMaintenance"],
                "totalPrintTime": printer.get("totalPrintTime", 0),
                "successRate": printer.get("successRate", 0),
                "currentJob": json.dumps(printer.get("currentJob")),
                "nozzleTemperatures": json.dumps(printer.get("nozzleTemperatures")),
                "spools": json.dumps(printer.get("spools")),
            },
        )


def parse_header_string(header_value: str) -> dict[str, str]:
    separator_index = header_value.find(":")
    if separator_index == -1:
      trimmed_value = header_value.strip()
      return {"X-API-Key": trimmed_value} if trimmed_value else {}

    name = header_value[:separator_index].strip()
    value = header_value[separator_index + 1 :].strip()
    return {name: value} if name and value else {}


def map_print_state_to_status(state: str | None) -> str:
    if state == "printing":
        return "printing"
    if state == "paused":
        return "paused"
    if state == "error":
        return "error"
    return "idle"


def build_current_job(
    print_stats: dict[str, Any] | None, previous_job: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    if not print_stats:
        return None

    state = print_stats.get("state")
    filename = print_stats.get("filename")
    if not filename or not state or state in {"standby", "complete", "cancelled"}:
        return None

    filament_used = print_stats.get("filament_used", 0)
    previous_filename = previous_job.get("filename") if previous_job else None
    start_time = (
        previous_job.get("startTime")
        if previous_filename == filename and previous_job
        else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    return {
        "id": f"job-{filename}",
        "filename": filename,
        "status": "paused" if state == "paused" else "failed" if state == "error" else "printing",
        "progress": 0,
        "estimatedTime": 0,
        "timeRemaining": 0,
        "filamentUsed": round(filament_used) if isinstance(filament_used, (int, float)) else 0,
        "startTime": start_time,
        "priority": "medium",
    }


def build_offline_printer_state(printer: dict[str, Any]) -> dict[str, Any]:
    nozzle_temperatures = printer.get("nozzleTemperatures")
    return {
        "status": "offline",
        "currentJob": None,
        "progress": 0,
        "temperature": {"nozzle": 0, "bed": 0},
        "nozzleTemperatures": [0 for _ in nozzle_temperatures] if nozzle_temperatures else [0],
    }


def get_reachable_generic_status(printer: dict[str, Any]) -> str:
    current_job = printer.get("currentJob") or {}
    if current_job.get("status") == "paused" or printer.get("status") == "paused":
        return "paused"
    if current_job.get("status") == "printing" or printer.get("status") == "printing":
        return "printing"
    if printer.get("status") == "error":
        return "error"
    return "idle"


def fetch_generic_status(printer: dict[str, Any]) -> dict[str, Any]:
    response = requests.get(
        f"{printer['url']}/",
        headers=parse_header_string(printer.get("apiKeyHeader", "")),
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return {"status": get_reachable_generic_status(printer)}


def fetch_snapmaker_status(printer: dict[str, Any]) -> dict[str, Any]:
    response = requests.get(
        f"{printer['url']}{SNAPMAKER_STATUS_PATH}",
        headers=parse_header_string(printer.get("apiKeyHeader", "")),
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    payload = response.json()
    status = ((payload.get("result") or {}).get("status")) or {}
    print_stats = status.get("print_stats")
    if not print_stats:
        raise RuntimeError("Printer did not return the expected status JSON")

    extruders = [
        status.get("extruder"),
        status.get("extruder1"),
        status.get("extruder2"),
        status.get("extruder3"),
    ]
    heater_bed = status.get("heater_bed") or {}
    fallback_nozzle = ((printer.get("temperature") or {}).get("nozzle")) or 0
    existing_nozzles = printer.get("nozzleTemperatures") or []

    nozzle_temperatures = []
    for index, extruder in enumerate(extruders):
        temperature = (extruder or {}).get("temperature")
        if isinstance(temperature, (int, float)):
            nozzle_temperatures.append(round(temperature))
        elif index < len(existing_nozzles):
            nozzle_temperatures.append(existing_nozzles[index])
        else:
            nozzle_temperatures.append(fallback_nozzle)

    bed_temperature = heater_bed.get("temperature")
    if not isinstance(bed_temperature, (int, float)):
        bed_temperature = ((printer.get("temperature") or {}).get("bed")) or 0

    raw_print_state = print_stats.get("state")

    return {
        "status": map_print_state_to_status(raw_print_state),
        "currentJob": build_current_job(print_stats, printer.get("currentJob")),
        "progress": 0,
        "rawPrintState": raw_print_state,
        "temperature": {
            "nozzle": nozzle_temperatures[0] if nozzle_temperatures else fallback_nozzle,
            "bed": round(bed_temperature),
        },
        "nozzleTemperatures": nozzle_temperatures,
    }


def refresh_status(printer: dict[str, Any]) -> dict[str, Any]:
    if printer.get("profile") == "snapmaker_u1":
        live_status = fetch_snapmaker_status(printer)
    else:
        live_status = fetch_generic_status(printer)
    return {**printer, **live_status}


def finalize_job_analytics(
    conn: psycopg.Connection,
    job: dict[str, Any],
    outcome: str,
) -> None:
    start_time = job.get("startTime")
    if not start_time:
        return

    try:
        started_at = time.strptime(start_time, "%Y-%m-%dT%H:%M:%SZ")
        started_epoch = calendar.timegm(started_at)
    except ValueError:
        return

    finished_epoch = time.time()
    duration_hours = max((finished_epoch - started_epoch) / 3600, 0)
    filament_used = job.get("filamentUsed", 0)
    if not isinstance(filament_used, (int, float)):
        filament_used = 0

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO analytics_daily (
              analytics_date,
              completed_jobs,
              failed_jobs,
              print_time_hours,
              filament_used_grams,
              updated_at
            ) VALUES (
              CURRENT_DATE,
              %(completed)s,
              %(failed)s,
              %(print_time_hours)s,
              %(filament_used_grams)s,
              NOW()
            )
            ON CONFLICT (analytics_date) DO UPDATE SET
              completed_jobs = analytics_daily.completed_jobs + EXCLUDED.completed_jobs,
              failed_jobs = analytics_daily.failed_jobs + EXCLUDED.failed_jobs,
              print_time_hours = analytics_daily.print_time_hours + EXCLUDED.print_time_hours,
              filament_used_grams = analytics_daily.filament_used_grams + EXCLUDED.filament_used_grams,
              updated_at = NOW()
            """,
            {
                "completed": 1 if outcome == "completed" else 0,
                "failed": 1 if outcome == "failed" else 0,
                "print_time_hours": duration_hours,
                "filament_used_grams": float(filament_used),
            },
        )


def collect_analytics_for_transition(
    conn: psycopg.Connection, previous_printer: dict[str, Any], next_printer: dict[str, Any]
) -> None:
    previous_job = previous_printer.get("currentJob")
    if not previous_job:
        return

    next_job = next_printer.get("currentJob")
    previous_filename = previous_job.get("filename")
    next_filename = next_job.get("filename") if next_job else None

    if next_job and next_filename == previous_filename:
        return

    next_status = next_printer.get("status")
    if next_status == "offline":
        return

    raw_print_state = next_printer.get("rawPrintState")
    if raw_print_state == "cancelled":
        outcome = "failed"
    else:
        outcome = "failed" if next_status == "error" else "completed"
    finalize_job_analytics(conn, previous_job, outcome)


def run() -> None:
    while True:
        try:
            with psycopg.connect(db_url()) as conn:
                ensure_schema(conn)
                printers = list_printers(conn)
                for printer in printers:
                    try:
                        next_printer = refresh_status(printer)
                    except Exception:
                        next_printer = {**printer, **build_offline_printer_state(printer)}
                    collect_analytics_for_transition(conn, printer, next_printer)
                    upsert_printer(conn, next_printer)
                conn.commit()
        except Exception as error:
            print(f"printer poller error: {error}", flush=True)

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
