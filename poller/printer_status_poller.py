import calendar
import ftplib
import json
import os
import re
import socket
import ssl
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Any
from urllib.parse import quote

import paho.mqtt.client as mqtt
import psycopg
import requests

POLL_INTERVAL_SECONDS = max(int(os.getenv("PRINTER_POLL_INTERVAL_MS", "5000")) / 1000, 1)
REQUEST_TIMEOUT_SECONDS = max(int(os.getenv("PRINTER_REQUEST_TIMEOUT_MS", "3000")) / 1000, 1)
OFFLINE_GRACE_SECONDS = max(int(os.getenv("PRINTER_OFFLINE_GRACE_SECONDS", "30")), 0)
# Bambu cameras aren't plain HTTP (port-6000 JPEG socket on the A1, RTSP-over-TLS
# on the H2), so the poller can't fetch their snapshots directly the way it does
# the Snapmaker's /webcam/snapshot.jpg. The web service already implements both
# protocols at /__printer_webcam/<id>/snapshot.jpg, so for Bambu profiles the
# poller grabs the snapshot from there over the internal compose network.
WEB_SNAPSHOT_BASE_URL = os.getenv("WEB_SNAPSHOT_BASE_URL", "http://web:5173").rstrip("/")
# Bambu snapshots can take a few seconds (RTSP frame grab / ffmpeg warm-up), so
# allow more headroom than the per-poll printer request timeout.
BAMBU_SNAPSHOT_TIMEOUT_SECONDS = max(REQUEST_TIMEOUT_SECONDS, 10)
BAMBU_PROFILES = frozenset(
    {"bambulab_a1_mini", "bambulab_h2s", "bambulab_h2d", "bambulab_h2c"}
)
# H2/X1-class printers expose an RTSP live view that the web camera hub transcodes
# to a live MJPEG stream; for the Discord snapshot we grab a frame straight from
# that live stream. The A1 Mini has no live view (port-6000 snapshot only).
BAMBU_RTSP_PROFILES = frozenset({"bambulab_h2s", "bambulab_h2d", "bambulab_h2c"})
# Dual-nozzle Bambus — they have a left and a right toolhead, so their status
# carries two nozzle readings instead of the single flat nozzle_temper field. The
# H2C's right toolhead is the Vortek hotend-change system, but it reports the same
# two-nozzle structure as the H2D.
BAMBU_DUAL_NOZZLE_PROFILES = frozenset({"bambulab_h2d", "bambulab_h2c"})
# H2-series firmware blocks FTP file access (the slicer-proxy notes the same), so
# the direct-from-printer 3MF filament fetch can't run there; those printers fall
# back to the AMS remain%-delta. The A1/P1 class serves the .3mf over FTPS fine.
BAMBU_FTP_BLOCKED_PROFILES = frozenset({"bambulab_h2s", "bambulab_h2d", "bambulab_h2c"})
# Sanity cap when parsing a JPEG frame out of the MJPEG stream.
MAX_FRAME_BYTES = 25 * 1024 * 1024
_MJPEG_CONTENT_LENGTH_RE = re.compile(rb"content-length:\s*(\d+)", re.IGNORECASE)
# Largest gap (seconds) ever credited to the lifetime print-hours counter in a
# single poll. Bounds the damage from a backward/forward clock jump or a long
# poller stall, so a printer seen "printing" on both sides of a big gap can't
# bank the whole gap as runtime.
MAX_PRINT_TIME_STEP_SECONDS = max(POLL_INTERVAL_SECONDS * 6, 120)

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
CREATE TABLE IF NOT EXISTS discord_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-webhook event subscription. NULL means "all events enabled" (the historical
-- behaviour); a JSON array of event keys restricts the webhook to those events.
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS events JSONB;
-- Master on/off switch per webhook. TRUE means notifications are sent (the
-- historical default); FALSE mutes the webhook entirely.
ALTER TABLE discord_webhooks ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- Slicer-derived filament estimate per print (grams), written by the slicer-proxy
-- when a .3mf is uploaded and read here to populate per-job filament usage. Keyed
-- by printer + the subtask name the print is started with. Owned by the web schema
-- too; created here so the poller's read never races ahead of it.
CREATE TABLE IF NOT EXISTS slicer_print_estimates (
  printer_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  filament_grams DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (printer_id, job_name)
);
SELECT pg_advisory_unlock(90210);
"""

SNAPMAKER_STATUS_PATH = (
    "/printer/objects/query?print_stats&extruder=temperature,target"
    "&extruder1=temperature,target&extruder2=temperature,target"
    "&extruder3=temperature,target&heater_bed=temperature,target"
    "&virtual_sdcard=progress&fan=speed&toolhead=extruder"
)

# Bambu Lab printers report over MQTT-over-TLS in LAN mode (no HTTP status API).
# Auth is the LAN access code (stored in the printer's api_key_header field) with a
# fixed "bblp" username; the serial is learned from the report topic.
BAMBU_MQTT_PORT = 8883
BAMBU_MQTT_USERNAME = "bblp"
# Implicit FTPS — same "bblp" + LAN-access-code auth — used to pull the active
# print's .3mf off the printer so we can read the slicer's per-filament weight
# (the way bambuddy's bambu_ftp service does). Lets a print started from Bambu
# Studio / the SD card / Handy still get an exact filament estimate, not just the
# AMS remain%-delta fallback. The H2 series blocks FTP file access, so it's skipped
# there (see BAMBU_FTP_BLOCKED_PROFILES).
BAMBU_FTP_PORT = 990
BAMBU_FTP_USERNAME = "bblp"
BAMBU_FTP_TIMEOUT_SECONDS = max(REQUEST_TIMEOUT_SECONDS, 8)
# Treat a Bambu printer as offline if no MQTT report arrives within this window.
BAMBU_REPORT_FRESHNESS_SECONDS = max(POLL_INTERVAL_SECONDS * 4, 20)
# Rate-limit full-snapshot (pushall) requests so we never flood the printer.
BAMBU_PUSHALL_MIN_INTERVAL_SECONDS = 10
BAMBU_STATE_MAP = {
    "RUNNING": "printing",
    "PREPARE": "printing",
    "SLICING": "printing",
    "PAUSE": "paused",
    "FINISH": "idle",
    "IDLE": "idle",
}


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
              serial,
              status,
              json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed, 'chamber', temperature_chamber) AS temperature,
              progress,
              last_maintenance AS "lastMaintenance",
              total_print_time AS "totalPrintTime",
              success_rate AS "successRate",
              current_job AS "currentJob",
              nozzle_temperatures AS "nozzleTemperatures",
              nozzle_targets AS "nozzleTargets",
              bed_target AS "bedTarget",
              chamber_target AS "chamberTarget",
              spools,
              fan_speeds AS "fanSpeeds",
              light_on AS "lightOn",
              air_filter_on AS "airFilterOn",
              offline_since AS "offlineSince"
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
              serial,
              status,
              temperature_nozzle,
              temperature_bed,
              temperature_chamber,
              progress,
              last_maintenance,
              total_print_time,
              success_rate,
              current_job,
              nozzle_temperatures,
              nozzle_targets,
              bed_target,
              chamber_target,
              spools,
              fan_speeds,
              light_on,
              air_filter_on,
              offline_since
            ) VALUES (
              %(id)s,
              %(name)s,
              %(model)s,
              %(sortOrder)s,
              %(profile)s,
              %(url)s,
              %(ipAddress)s,
              %(apiKeyHeader)s,
              %(serial)s,
              %(status)s,
              %(temperature_nozzle)s,
              %(temperature_bed)s,
              %(temperature_chamber)s,
              %(progress)s,
              %(lastMaintenance)s,
              %(totalPrintTime)s,
              %(successRate)s,
              %(currentJob)s::jsonb,
              %(nozzleTemperatures)s::jsonb,
              %(nozzleTargets)s::jsonb,
              %(bedTarget)s,
              %(chamberTarget)s,
              %(spools)s::jsonb,
              %(fanSpeeds)s::jsonb,
              %(lightOn)s,
              %(airFilterOn)s,
              %(offlineSince)s
            )
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              model = EXCLUDED.model,
              sort_order = EXCLUDED.sort_order,
              profile = EXCLUDED.profile,
              url = EXCLUDED.url,
              ip_address = EXCLUDED.ip_address,
              api_key_header = EXCLUDED.api_key_header,
              serial = EXCLUDED.serial,
              status = EXCLUDED.status,
              temperature_nozzle = EXCLUDED.temperature_nozzle,
              temperature_bed = EXCLUDED.temperature_bed,
              temperature_chamber = EXCLUDED.temperature_chamber,
              progress = EXCLUDED.progress,
              last_maintenance = EXCLUDED.last_maintenance,
              total_print_time = EXCLUDED.total_print_time,
              success_rate = EXCLUDED.success_rate,
              current_job = EXCLUDED.current_job,
              nozzle_temperatures = EXCLUDED.nozzle_temperatures,
              nozzle_targets = EXCLUDED.nozzle_targets,
              bed_target = EXCLUDED.bed_target,
              chamber_target = EXCLUDED.chamber_target,
              spools = EXCLUDED.spools,
              fan_speeds = EXCLUDED.fan_speeds,
              light_on = EXCLUDED.light_on,
              air_filter_on = EXCLUDED.air_filter_on,
              offline_since = EXCLUDED.offline_since
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
                "serial": printer.get("serial"),
                "status": printer["status"],
                "temperature_nozzle": printer.get("temperature", {}).get("nozzle", 0),
                "temperature_bed": printer.get("temperature", {}).get("bed", 0),
                "temperature_chamber": printer.get("temperature", {}).get("chamber", 0),
                "progress": printer.get("progress", 0),
                "lastMaintenance": printer["lastMaintenance"],
                "totalPrintTime": printer.get("totalPrintTime", 0),
                "successRate": printer.get("successRate", 0),
                "currentJob": json.dumps(printer.get("currentJob")),
                "nozzleTemperatures": json.dumps(printer.get("nozzleTemperatures")),
                "nozzleTargets": json.dumps(printer.get("nozzleTargets")),
                "bedTarget": printer.get("bedTarget"),
                "chamberTarget": printer.get("chamberTarget"),
                "spools": json.dumps(printer.get("spools")),
                "fanSpeeds": json.dumps(printer.get("fanSpeeds")),
                "lightOn": printer.get("lightOn"),
                "airFilterOn": printer.get("airFilterOn"),
                "offlineSince": printer.get("offlineSince"),
            },
        )


def list_discord_webhooks(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
              id,
              name,
              webhook_url AS "webhookUrl",
              events,
              enabled
            FROM discord_webhooks
            ORDER BY created_at ASC
            """
        )
        return list(cur.fetchall())


def list_slicer_estimates(conn: psycopg.Connection) -> dict[tuple[str, str], float]:
    """Slicer-derived filament totals keyed by (printer_id, job_name)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT printer_id, job_name, filament_grams FROM slicer_print_estimates"
        )
        return {(row[0], row[1]): float(row[2]) for row in cur.fetchall()}


def record_slicer_estimate(
    conn: psycopg.Connection, printer_id: str, job_name: str, grams: float
) -> None:
    """Upsert a slicer-derived filament total (grams) for one print.

    Same table/key the slicer-proxy writes when a .3mf is uploaded; here it's the
    poller filling it in for prints fetched straight off the printer over FTPS.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO slicer_print_estimates (printer_id, job_name, filament_grams)
            VALUES (%s, %s, %s)
            ON CONFLICT (printer_id, job_name) DO UPDATE
              SET filament_grams = EXCLUDED.filament_grams,
                  updated_at = NOW()
            """,
            (printer_id, job_name, grams),
        )


def apply_slicer_filament_estimate(
    printer: dict[str, Any], estimates: dict[tuple[str, str], float]
) -> None:
    """Override a job's filament usage with the slicer's 3MF estimate when known.

    The slicer-proxy stores the print's total filament grams; here we scale it by
    progress for a live "used so far" figure. This is exact (unlike the AMS
    remain%-delta fallback computed during status refresh), so it takes precedence
    when an estimate exists; otherwise the AMS-delta value is left untouched.
    """
    job = printer.get("currentJob")
    if not job:
        return
    grams = estimates.get((printer.get("id"), job.get("filename")))
    if grams is None or grams <= 0:
        return
    progress = job.get("progress")
    progress = progress if isinstance(progress, (int, float)) else 0
    job["estimatedFilament"] = round(grams, 1)
    job["filamentUsed"] = round(grams * max(0, min(100, progress)) / 100, 1)


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
    print_stats: dict[str, Any] | None,
    previous_job: dict[str, Any] | None = None,
    progress: int = 0,
) -> dict[str, Any] | None:
    if not print_stats:
        return None

    state = print_stats.get("state")
    filename = print_stats.get("filename")
    if not filename or not state or state in {"standby", "complete", "cancelled"}:
        return None

    filament_used = print_stats.get("filament_used", 0)
    filament_used_grams = 0
    if isinstance(filament_used, (int, float)):
        filament_used_grams = round((filament_used / 1000) * 3, 1)
    print_duration = print_stats.get("print_duration", 0)
    printing_time_minutes = 0
    if isinstance(print_duration, (int, float)) and print_duration > 0:
        printing_time_minutes = max(0, round(print_duration / 60))
    estimated_time_minutes = 0
    time_remaining_minutes = 0
    if isinstance(print_duration, (int, float)) and print_duration > 0 and progress > 0:
        estimated_total_seconds = print_duration / max(progress / 100, 0.01)
        remaining_seconds = max(estimated_total_seconds - print_duration, 0)
        estimated_time_minutes = max(1, round(estimated_total_seconds / 60))
        time_remaining_minutes = max(0, round(remaining_seconds / 60))
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
        "progress": progress,
        "estimatedTime": estimated_time_minutes,
        "timeRemaining": time_remaining_minutes,
        "printingTime": printing_time_minutes,
        "filamentUsed": filament_used_grams,
        "startTime": start_time,
        "priority": "medium",
    }


def build_offline_printer_state(printer: dict[str, Any]) -> dict[str, Any]:
    nozzle_temperatures = printer.get("nozzleTemperatures")
    return {
        "status": "offline",
        "currentJob": None,
        "progress": 0,
        "temperature": {"nozzle": 0, "bed": 0, "chamber": 0},
        "nozzleTemperatures": [0 for _ in nozzle_temperatures] if nozzle_temperatures else [0],
        "fanSpeeds": None,
    }


def apply_offline_grace_period(printer: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    detected_at = printer.get("offlineSince")
    current_time = time.time() if now is None else now
    if not isinstance(detected_at, (int, float)):
        return {**printer, "offlineSince": current_time}

    if current_time - detected_at < OFFLINE_GRACE_SECONDS:
        return printer

    return {**printer, **build_offline_printer_state(printer), "offlineSince": detected_at}


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
    virtual_sdcard = status.get("virtual_sdcard") or {}

    extruders = [
        status.get("extruder"),
        status.get("extruder1"),
        status.get("extruder2"),
        status.get("extruder3"),
    ]
    heater_bed = status.get("heater_bed") or {}
    fallback_nozzle = ((printer.get("temperature") or {}).get("nozzle")) or 0
    existing_nozzles = printer.get("nozzleTemperatures") or []
    existing_nozzle_targets = printer.get("nozzleTargets") or []

    nozzle_temperatures = []
    nozzle_targets = []
    for index, extruder in enumerate(extruders):
        temperature = (extruder or {}).get("temperature")
        if isinstance(temperature, (int, float)):
            nozzle_temperatures.append(round(temperature))
        elif index < len(existing_nozzles):
            nozzle_temperatures.append(existing_nozzles[index])
        else:
            nozzle_temperatures.append(fallback_nozzle)

        # Target temps drive the set-temp box so it reflects the live target even
        # when changed from the printer screen or slicer. Default to 0 (heater off).
        target = (extruder or {}).get("target")
        if isinstance(target, (int, float)):
            nozzle_targets.append(round(target))
        elif index < len(existing_nozzle_targets):
            nozzle_targets.append(existing_nozzle_targets[index])
        else:
            nozzle_targets.append(0)

    bed_temperature = heater_bed.get("temperature")
    if not isinstance(bed_temperature, (int, float)):
        bed_temperature = ((printer.get("temperature") or {}).get("bed")) or 0

    bed_target = heater_bed.get("target")
    if not isinstance(bed_target, (int, float)):
        bed_target = printer.get("bedTarget") or 0

    raw_print_state = print_stats.get("state")
    raw_progress = virtual_sdcard.get("progress")
    progress = 0
    if isinstance(raw_progress, (int, float)):
        progress = max(0, min(100, round(raw_progress * 100)))

    # Moonraker reports the part-cooling fan speed as a 0–1 fraction.
    fan = status.get("fan") or {}
    fan_speed = fan.get("speed")
    fan_speeds = (
        [{"id": "part", "speed": max(0, min(100, round(fan_speed * 100)))}]
        if isinstance(fan_speed, (int, float))
        else printer.get("fanSpeeds")
    )

    # Moonraker names the active extruder on the toolhead ("extruder", "extruder1",
    # …); map it to the matching tool-N spool id so the run-out alert fires (and is
    # named) only for the lane the print is actually feeding from.
    active_extruder = (status.get("toolhead") or {}).get("extruder")
    active_spool_id = None
    if isinstance(active_extruder, str) and active_extruder.startswith("extruder"):
        suffix = active_extruder[len("extruder") :]
        active_index = int(suffix) if suffix.isdigit() else 0
        active_spool_id = f"tool-{active_index + 1}"

    return {
        "status": map_print_state_to_status(raw_print_state),
        "currentJob": build_current_job(print_stats, printer.get("currentJob"), progress),
        "progress": progress,
        "rawPrintState": raw_print_state,
        "temperature": {
            "nozzle": nozzle_temperatures[0] if nozzle_temperatures else fallback_nozzle,
            "bed": round(bed_temperature),
        },
        "nozzleTemperatures": nozzle_temperatures,
        "nozzleTargets": nozzle_targets,
        "bedTarget": round(bed_target),
        "fanSpeeds": fan_speeds,
        # Lane currently feeding the nozzle; transient, not persisted by upsert.
        "activeSpoolId": active_spool_id,
    }


def build_spools_from_task_config(task_config: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    if not task_config:
        return None

    filament_types = task_config.get("filament_type") or []
    filament_colors = task_config.get("filament_color_rgba") or []
    filament_exists = task_config.get("filament_exist") or []

    if not filament_types:
        return None

    spools: list[dict[str, Any]] = []
    for index, filament_type in enumerate(filament_types):
        if not filament_exists or index >= len(filament_exists) or not filament_exists[index]:
            continue

        color_rgba = filament_colors[index] if index < len(filament_colors) else "808080FF"
        hex_color = f"#{str(color_rgba)[:6]}"
        material = filament_type if isinstance(filament_type, str) and filament_type else "Unknown"

        spools.append(
            {
                "id": f"tool-{index + 1}",
                "color": hex_color,
                "material": material,
                "remaining": 0,
                "weight": 0,
            }
        )

    return spools or None


def fetch_snapmaker_task_config(printer: dict[str, Any]) -> list[dict[str, Any]] | None:
    response = requests.get(
        f"{printer['url']}/printer/objects/query?print_task_config",
        headers=parse_header_string(printer.get("apiKeyHeader", "")),
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    payload = response.json()
    task_config = (((payload.get("result") or {}).get("status")) or {}).get("print_task_config")
    return build_spools_from_task_config(task_config)


class _BambuMqttClient:
    """Persistent MQTT-over-TLS connection to one Bambu printer in LAN mode.

    Bambu's broker only authorizes a subscription to the printer's own exact topic
    ``device/<serial>/report`` — a wildcard subscription gets the client kicked — and
    an idle printer stays silent until asked, so we send a ``pushall`` request on
    connect and again whenever the cached data is going stale. paho runs the network
    loop on its own thread; each report is merged into a cached ``print`` object that
    the poll loop reads synchronously.
    """

    def __init__(self, host: str, access_code: str, serial: str) -> None:
        self.host = host
        self.access_code = access_code
        self.serial = serial
        self._report_topic = f"device/{serial}/report"
        self._request_topic = f"device/{serial}/request"
        self._print: dict[str, Any] = {}
        self._last_report = 0.0
        self._last_pushall = 0.0
        self._lock = threading.Lock()

        self._client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        self._client.username_pw_set(BAMBU_MQTT_USERNAME, access_code)
        # Bambu printers serve a self-signed certificate; trust the LAN device directly.
        self._client.tls_set(cert_reqs=ssl.CERT_NONE)
        self._client.tls_insecure_set(True)
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)
        self._client.on_connect = self._on_connect
        self._client.on_subscribe = self._on_subscribe
        self._client.on_message = self._on_message
        self._client.connect_async(host, BAMBU_MQTT_PORT, keepalive=30)
        self._client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if getattr(reason_code, "is_failure", False):
            print(f"bambu mqtt connect failed ({self.host}): {reason_code}", flush=True)
            return
        client.subscribe(self._report_topic)

    def _on_subscribe(self, client, userdata, mid, reason_codes, properties=None) -> None:
        # Once the subscription is live, ask for a full snapshot.
        self._last_pushall = 0.0
        self._request_pushall()

    def _on_message(self, client, userdata, message) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        print_data = payload.get("print")
        if isinstance(print_data, dict):
            with self._lock:
                self._print.update(print_data)
                self._last_report = time.time()

    def _request_pushall(self) -> None:
        now = time.time()
        if now - self._last_pushall < BAMBU_PUSHALL_MIN_INTERVAL_SECONDS:
            return
        self._last_pushall = now
        try:
            self._client.publish(
                self._request_topic,
                json.dumps({"pushing": {"sequence_id": "0", "command": "pushall"}}),
            )
        except Exception:
            pass

    def latest_report(self) -> dict[str, Any] | None:
        with self._lock:
            age = time.time() - self._last_report
            data = dict(self._print) if self._print else None
        # Idle printers go quiet; nudge a fresh snapshot before the cached data expires.
        if data is None or age > BAMBU_REPORT_FRESHNESS_SECONDS / 2:
            self._request_pushall()
        if data is None or age > BAMBU_REPORT_FRESHNESS_SECONDS:
            return None
        return data

    def close(self) -> None:
        try:
            self._client.loop_stop()
            self._client.disconnect()
        except Exception:
            pass


# One persistent MQTT connection per Bambu printer, keyed by printer id.
_BAMBU_CLIENTS: dict[str, _BambuMqttClient] = {}


def get_bambu_client(printer: dict[str, Any]) -> _BambuMqttClient:
    printer_id = printer["id"]
    host = printer.get("ipAddress") or ""
    access_code = (printer.get("apiKeyHeader") or "").strip()
    serial = (printer.get("serial") or "").strip()

    client = _BAMBU_CLIENTS.get(printer_id)
    if client is not None and (
        client.host != host or client.access_code != access_code or client.serial != serial
    ):
        client.close()
        client = None
    if client is None:
        client = _BambuMqttClient(host, access_code, serial)
        _BAMBU_CLIENTS[printer_id] = client
    return client


def prune_bambu_clients(active_ids: set[str]) -> None:
    """Drop MQTT connections for printers that no longer exist."""
    for printer_id in list(_BAMBU_CLIENTS.keys()):
        if printer_id not in active_ids:
            _BAMBU_CLIENTS.pop(printer_id).close()
    # Drop 3MF-fetch attempt records for removed printers so the cache can't grow
    # unbounded as printers come and go.
    for key in [k for k in _BAMBU_3MF_ATTEMPTS if k[0] not in active_ids]:
        _BAMBU_3MF_ATTEMPTS.pop(key, None)


def map_bambu_state(state: Any) -> str:
    if not isinstance(state, str):
        return "idle"
    # FAILED is not surfaced as a printer error: it (and a lingering print_error
    # code) persists after any stopped/failed print while the printer is actually
    # idle and ready. The failed outcome is recorded via rawPrintState instead.
    return BAMBU_STATE_MAP.get(state.upper(), "idle")


def build_bambu_current_job(
    print_data: dict[str, Any],
    previous_job: dict[str, Any] | None,
    progress: int,
    status: str,
    remaining_minutes: int,
) -> dict[str, Any] | None:
    if status not in {"printing", "paused"}:
        return None

    filename = print_data.get("subtask_name") or print_data.get("gcode_file")
    if not filename:
        return None

    previous_filename = previous_job.get("filename") if previous_job else None
    start_time = (
        previous_job.get("startTime")
        if previous_job and previous_filename == filename
        else iso_timestamp()
    )

    printing_time_minutes = 0
    try:
        started_epoch = calendar.timegm(time.strptime(start_time, "%Y-%m-%dT%H:%M:%SZ"))
        printing_time_minutes = max(0, round((time.time() - started_epoch) / 60))
    except (ValueError, TypeError):
        printing_time_minutes = 0

    # The printer reports remaining time directly; derive the rest from our own
    # start tracking so the numbers stay coherent across polls.
    estimated_time_minutes = printing_time_minutes + remaining_minutes if remaining_minutes else 0

    return {
        "id": f"job-{filename}",
        "filename": filename,
        "status": "paused" if status == "paused" else "printing",
        "progress": progress,
        "estimatedTime": estimated_time_minutes,
        "timeRemaining": remaining_minutes,
        "printingTime": printing_time_minutes,
        "filamentUsed": 0,
        "startTime": start_time,
        "priority": "medium",
    }


def build_bambu_spools(print_data: dict[str, Any]) -> list[dict[str, Any]] | None:
    spools: list[dict[str, Any]] = []

    def add_tray(tray: Any, slot_id: str) -> None:
        if not isinstance(tray, dict):
            return
        material = tray.get("tray_type")
        if not material:
            return
        color = str(tray.get("tray_color") or "808080FF")[:6]
        remain = tray.get("remain")
        remain_valid = isinstance(remain, (int, float)) and remain >= 0
        remaining = max(0, min(100, round(remain))) if remain_valid else 0
        # Bambu's `tray_weight` is the spool's nominal *full* weight in grams, not
        # the grams left; the AMS `remain` is the remaining percentage (reported
        # only for Bambu RFID spools, -1 otherwise). Real grams remaining =
        # full weight × remain% / 100 (mirrors bambuddy's weight-sync formula).
        # Without a usable remain% we can't derive grams, so report 0 (unknown).
        try:
            full_weight = float(tray.get("tray_weight") or 0)
        except (TypeError, ValueError):
            full_weight = 0
        weight = (
            round(full_weight * remaining / 100, 1)
            if remain_valid and full_weight > 0
            else 0
        )
        spools.append(
            {
                "id": slot_id,
                "color": f"#{color}",
                "material": material,
                "remaining": remaining,
                "weight": weight,
            }
        )

    ams_root = print_data.get("ams")
    if isinstance(ams_root, dict):
        for unit in ams_root.get("ams") or []:
            if not isinstance(unit, dict):
                continue
            unit_id = unit.get("id", "0")
            for tray in unit.get("tray") or []:
                tray_id = tray.get("id") if isinstance(tray, dict) else None
                add_tray(tray, f"ams{unit_id}-{tray_id}")

    # External spool (used by the A1 mini without an AMS).
    add_tray(print_data.get("vt_tray"), "external")

    return spools or None


def bambu_active_spool_id(print_data: dict[str, Any]) -> str | None:
    """Slot id (matching build_bambu_spools ids) of the tray currently feeding the
    nozzle, read from the AMS `tray_now` pointer. Returns "external" for the vt_tray
    and None when no tray is engaged (transitioning / unknown). Used to fire the
    run-out alert only for the filament the current print is actually using."""
    ams_root = print_data.get("ams")
    if not isinstance(ams_root, dict):
        # No AMS — A1 mini / external-spool printers feed from vt_tray.
        return "external" if isinstance(print_data.get("vt_tray"), dict) else None
    try:
        global_index = int(str(ams_root.get("tray_now")).strip())
    except (TypeError, ValueError):
        return None
    # 254/255 are Bambu's "no tray / external spool" sentinels.
    if global_index >= 254:
        return "external" if isinstance(print_data.get("vt_tray"), dict) else None
    if global_index < 0:
        return None
    # tray_now is a flat index across AMS units of four trays each, matching the
    # ams{unit}-{tray} ids build_bambu_spools emits.
    return f"ams{global_index // 4}-{global_index % 4}"


# Bambu reports faults via two channels in the print report: the `hms` list
# (each `{attr, code}`) and a single `print_error` 32-bit int. Both encode a
# short code "MMMM_EEEE" (module_error). The low 16-bit error word 0x8011 is the
# universal AMS/external filament run-out code across modules, and 0300_8015 is
# the A1/external-spool run-out. Mirrors bambuddy's HMS/print_error parsing
# (bambu_mqtt.py) and the run-out descriptions in its hms_errors table.
_BAMBU_RUNOUT_SHORT_CODES = {"0300_8015"}


def _coerce_hms_int(value: Any) -> int:
    """Bambu sends HMS attr/code as either an int or a hex string ("0x...")."""
    if isinstance(value, str):
        cleaned = value.strip().lower().replace("0x", "")
        if not cleaned:
            return 0
        try:
            return int(cleaned, 16)
        except ValueError:
            return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _is_bambu_runout_code(short_code: str) -> bool:
    # 0x8011 in the low word means "filament run out" on every module.
    return short_code.endswith("_8011") or short_code in _BAMBU_RUNOUT_SHORT_CODES


def bambu_filament_runout(print_data: dict[str, Any]) -> bool:
    """True when the Bambu report carries an active filament-run-out fault."""
    short_codes: set[str] = set()

    hms_list = print_data.get("hms")
    if isinstance(hms_list, list):
        for hms in hms_list:
            if not isinstance(hms, dict):
                continue
            attr = _coerce_hms_int(hms.get("attr"))
            code = _coerce_hms_int(hms.get("code"))
            # Codes below 0x4000 are status/phase indicators, not real faults.
            if code < 0x4000:
                continue
            short_codes.add(f"{(attr >> 16) & 0xFFFF:04X}_{code & 0xFFFF:04X}")

    print_error = print_data.get("print_error")
    if isinstance(print_error, (int, float)) and print_error:
        pe = int(print_error)
        error = pe & 0xFFFF
        if error >= 0x4000:
            short_codes.add(f"{(pe >> 16) & 0xFFFF:04X}_{error:04X}")

    return any(_is_bambu_runout_code(code) for code in short_codes)


# Bambu's MQTT report has no live "grams used" field, so per-job filament usage is
# derived from the drop in AMS remaining grams since the print began — the AMS
# remain%-delta fallback bambuddy's usage tracker uses when no 3MF slicer estimate
# is available. Per printer we keep the print's filename and a baseline of each
# loaded spool's remaining grams captured when printing started. Low-resolution
# (remain% moves in ~10 g steps) and only works for RFID spools that report remain%.
_BAMBU_PRINT_BASELINE: dict[str, dict[str, Any]] = {}


def _spool_grams(spools: list[dict[str, Any]] | None) -> dict[str, float]:
    """Remaining grams per spool id, for spools that actually report it (>0)."""
    return {
        spool["id"]: float(spool.get("weight") or 0)
        for spool in (spools or [])
        if isinstance(spool, dict) and spool.get("id") and (spool.get("weight") or 0) > 0
    }


def update_bambu_filament_used(
    printer_id: str | None,
    job: dict[str, Any] | None,
    spools: list[dict[str, Any]] | None,
) -> None:
    """Set job["filamentUsed"] from the AMS remaining-grams delta since print start.

    Mutates `job` in place; clears the per-printer baseline once the print ends so
    the next print re-anchors from scratch.
    """
    if printer_id is None:
        return
    if not job:
        _BAMBU_PRINT_BASELINE.pop(printer_id, None)
        return

    current = _spool_grams(spools)
    filename = job.get("filename")
    state = _BAMBU_PRINT_BASELINE.get(printer_id)

    if state is None or state.get("filename") != filename:
        # New print: anchor the baseline to the current remaining grams.
        state = {"filename": filename, "grams": dict(current)}
        _BAMBU_PRINT_BASELINE[printer_id] = state
    else:
        # A spool that appears mid-print (e.g. an AMS slot loaded after start) is
        # anchored at its first-seen weight so its full reel isn't counted as used.
        baseline = state["grams"]
        for spool_id, grams in current.items():
            baseline.setdefault(spool_id, grams)

    baseline = state["grams"]
    used = 0.0
    for spool_id, grams in current.items():
        used += max(0.0, baseline.get(spool_id, grams) - grams)
    job["filamentUsed"] = round(used, 1)


# --- Direct-from-printer 3MF filament estimate (bambuddy bambu_ftp parity) -------
#
# bambuddy's most accurate source isn't the AMS delta above — it's the slicer's own
# per-filament weight, read out of the print's .3mf. The slicer-proxy already records
# that when *it* starts the print, but a job launched from Bambu Studio / the SD card
# / Handy never passes through the proxy, so it had only the lossy AMS-delta. Here the
# poller pulls the active .3mf straight off the printer over implicit FTPS (port 990,
# bblp + LAN access code), reads Metadata/slice_info.config, and records the same
# slicer estimate row — so every print, however started, gets the exact figure.


def parse_3mf_filament_grams(buf: bytes) -> float | None:
    """Sum the plate-level filament weight (grams) from a 3MF's slice_info.config.

    Mirrors slicer-proxy/parse3mf.js: each <plate> in Metadata/slice_info.config
    carries <metadata key="weight" value="<grams>"/>; summing across plates yields
    the whole job's filament weight. Returns grams (>0, one decimal) or None.
    """
    try:
        with zipfile.ZipFile(BytesIO(buf)) as archive:
            xml = archive.read("Metadata/slice_info.config").decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError, OSError):
        return None

    total = 0.0
    seen = False
    for match in re.finditer(r'key="weight"\s+value="([0-9]*\.?[0-9]+)"', xml, re.IGNORECASE):
        grams = float(match.group(1))
        if grams > 0:
            total += grams
            seen = True
    return round(total, 1) if seen else None


class _ImplicitFtpTls(ftplib.FTP_TLS):
    """FTP_TLS that does the TLS handshake immediately on connect (implicit FTPS).

    ftplib only ships explicit FTPS (AUTH TLS on a plaintext control channel); Bambu
    printers speak implicit FTPS on port 990, so the control socket must already be
    wrapped in TLS before the first response is read. Same shape as the slicer-proxy's
    basic-ftp `secure: 'implicit'` connection.
    """

    def connect(self, host: str, port: int, timeout: float) -> str:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock = socket.create_connection((host, port), timeout)
        self.af = self.sock.family
        self.sock = self.context.wrap_socket(self.sock, server_hostname=host)
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome


def _open_bambu_ftp(printer: dict[str, Any]) -> _ImplicitFtpTls:
    # Bambu serves a self-signed cert; trust the LAN device directly (matches MQTT).
    context = ssl._create_unverified_context()
    ftp = _ImplicitFtpTls(context=context)
    ftp.connect(
        printer.get("ipAddress") or "",
        BAMBU_FTP_PORT,
        BAMBU_FTP_TIMEOUT_SECONDS,
    )
    ftp.login(BAMBU_FTP_USERNAME, (printer.get("apiKeyHeader") or "").strip())
    ftp.prot_p()  # encrypt the data channel too
    return ftp


def _bambu_3mf_candidates(print_data: dict[str, Any], job_name: str) -> list[str]:
    """Likely FTP paths of the active print's .3mf, most-specific first.

    Where the file lands is firmware/route dependent (root for a slicer/Studio push,
    /cache for a Handy/cloud job), so we try a small ordered set and fall back to a
    directory scan in _fetch_bambu_3mf. The bit most likely to need live tuning.
    """
    candidates: list[str] = []

    def add(path: str | None) -> None:
        if path:
            cleaned = str(path).lstrip("/")
            if cleaned.lower().endswith(".3mf") and cleaned not in candidates:
                candidates.append(cleaned)

    # gcode_file sometimes carries the on-disk path; use it directly when it's a .3mf.
    add(print_data.get("gcode_file"))
    # subtask_name is the project name without extension — the slicer-proxy stores it
    # as "<name>.3mf" or keeps the slicer's "<name>.gcode.3mf"; Studio/cloud cache it.
    for base in (job_name, f"{job_name}.gcode"):
        add(f"{base}.3mf")
        add(f"cache/{base}.3mf")
    return candidates


def _fetch_bambu_3mf(printer: dict[str, Any], print_data: dict[str, Any], job_name: str) -> bytes | None:
    """Download the active print's .3mf over implicit FTPS, or None on any failure."""
    candidates = _bambu_3mf_candidates(print_data, job_name)
    try:
        ftp = _open_bambu_ftp(printer)
    except (*ftplib.all_errors, ssl.SSLError) as error:
        print(f"bambu ftp connect failed ({printer.get('ipAddress')}): {error}", flush=True)
        return None

    try:
        # If none of the guessed paths match, scan root + /cache for a .3mf whose
        # name contains the project token — the resilient fallback bambuddy relies on.
        token = re.sub(r"\.gcode$", "", job_name, flags=re.IGNORECASE).lower()
        for directory in ("", "cache"):
            try:
                names = ftp.nlst(directory) if directory else ftp.nlst()
            except ftplib.all_errors:
                continue
            for name in names:
                cleaned = name.lstrip("/")
                # nlst on a subdir may return bare names; re-attach the dir prefix.
                if directory and "/" not in cleaned:
                    cleaned = f"{directory}/{cleaned}"
                if cleaned.lower().endswith(".3mf") and token and token in cleaned.lower():
                    candidates.append(cleaned)

        seen: set[str] = set()
        for path in candidates:
            if path in seen:
                continue
            seen.add(path)
            sink = BytesIO()
            try:
                ftp.retrbinary(f"RETR {path}", sink.write)
            except ftplib.all_errors:
                continue
            data = sink.getvalue()
            if data:
                return data
        return None
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            try:
                ftp.close()
            except ftplib.all_errors:
                pass


# Per (printer_id, job_name) cool-down so a print whose .3mf can't be fetched (H2,
# unreachable FTP, unguessable path) isn't re-attempted every poll. Cleared per job.
_BAMBU_3MF_ATTEMPTS: dict[tuple[str, str], float] = {}
_BAMBU_3MF_RETRY_SECONDS = 300.0


def ensure_bambu_slicer_estimate(
    conn: psycopg.Connection,
    printer: dict[str, Any],
    print_data: dict[str, Any],
    job: dict[str, Any] | None,
    estimates: dict[tuple[str, str], float],
) -> None:
    """Fetch + store the slicer 3MF estimate for an active Bambu print if missing.

    Best-effort: never raises into the poll loop. Skips H2 (FTP blocked) and any print
    that already has an estimate (proxy upload or a prior fetch). On success the row is
    picked up by the next poll's apply_slicer_filament_estimate, like a proxy upload.
    """
    printer_id = printer.get("id")
    if not printer_id or not job:
        return
    if printer.get("profile") in BAMBU_FTP_BLOCKED_PROFILES:
        return
    job_name = job.get("filename")
    if not job_name:
        return
    key = (printer_id, job_name)
    if key in estimates:
        return  # already have an exact figure (proxy upload or earlier fetch)

    last_attempt = _BAMBU_3MF_ATTEMPTS.get(key)
    if last_attempt is not None and (time.time() - last_attempt) < _BAMBU_3MF_RETRY_SECONDS:
        return
    _BAMBU_3MF_ATTEMPTS[key] = time.time()

    try:
        data = _fetch_bambu_3mf(printer, print_data, job_name)
        if not data:
            return
        grams = parse_3mf_filament_grams(data)
        if not grams or grams <= 0:
            return
        record_slicer_estimate(conn, printer_id, job_name, grams)
        estimates[key] = grams  # apply it this cycle, no extra poll wait
    except Exception as error:  # noqa: BLE001 — must never break the poll loop
        print(f"bambu 3mf estimate failed ({printer_id}/{job_name}): {error}", flush=True)


def maybe_record_bambu_3mf_estimate(
    conn: psycopg.Connection,
    printer: dict[str, Any],
    next_printer: dict[str, Any],
    estimates: dict[tuple[str, str], float],
) -> None:
    """Loop-side guard for ensure_bambu_slicer_estimate: only run for an active,
    FTP-capable Bambu print that still lacks an estimate. Reads the cached MQTT
    report (no extra network round-trip) for the .3mf path hints."""
    if printer.get("profile") not in BAMBU_PROFILES:
        return
    if printer.get("profile") in BAMBU_FTP_BLOCKED_PROFILES:
        return
    job = next_printer.get("currentJob")
    if not job or next_printer.get("status") not in {"printing", "paused"}:
        return
    if (printer.get("id"), job.get("filename")) in estimates:
        return
    try:
        print_data = get_bambu_client(printer).latest_report() or {}
    except Exception:  # noqa: BLE001 — client lookup must never break the loop
        print_data = {}
    ensure_bambu_slicer_estimate(conn, printer, print_data, job, estimates)


# Bambu reports each fan speed as a string on a 0–15 scale (the gear shown on the
# printer); scale it to a 0–100 percentage. The exact fields/scale are the
# device-specific bit most likely to need live tuning.
BAMBU_FAN_FIELDS = {
    "part": "cooling_fan_speed",
    "aux": "big_fan1_speed",
    "chamber": "big_fan2_speed",
}

# Which fans each Bambu profile physically has (mirrors PRINTER_FANS on the web).
BAMBU_PROFILE_FANS = {
    "bambulab_a1_mini": ("part", "aux"),
    "bambulab_h2s": ("part", "aux", "chamber"),
    "bambulab_h2d": ("part", "aux", "chamber"),
    "bambulab_h2c": ("part", "aux", "chamber"),
}


def build_bambu_fan_speeds(
    print_data: dict[str, Any], profile: str | None
) -> list[dict[str, Any]] | None:
    fan_ids = BAMBU_PROFILE_FANS.get(profile or "", ())
    fan_speeds = []
    for fan_id in fan_ids:
        raw = print_data.get(BAMBU_FAN_FIELDS[fan_id])
        try:
            percent = round(int(raw) / 15 * 100)
        except (TypeError, ValueError):
            continue
        fan_speeds.append({"id": fan_id, "speed": max(0, min(100, percent))})
    return fan_speeds or None


# Decode a single Bambu chamber-temperature reading. On the H2 series the value
# is *encoded* whenever the chamber heater is engaged: `target * 65536 + current`
# (current temp in the low 16 bits). A plain reading in the -50..100 range is the
# direct Celsius value (heater off). Anything else is unusable. Mirrors Bambuddy's
# BambuMQTT chamber parsing. Returns the current temp in °C, or None.
def _decode_chamber_value(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    if -50 < value < 100:
        return float(value)
    if value > 500:
        current = int(value) % 65536
        if -50 < current < 100:
            return float(current)
    return None


# The chamber reading can surface in any of several fields depending on firmware;
# try them in priority order and return the first that decodes to a sane temp.
def _chamber_temp_candidates(print_data: dict[str, Any]) -> list[Any]:
    candidates = [print_data.get("chamber_temper")]
    ctc = print_data.get("ctc")
    if isinstance(ctc, dict) and isinstance(ctc.get("info"), dict):
        candidates.append(ctc["info"].get("temp"))
    info = print_data.get("info")
    if isinstance(info, dict):
        candidates.append(info.get("temp"))
    return candidates


def decode_bambu_chamber_temp(print_data: dict[str, Any]) -> float | None:
    for value in _chamber_temp_candidates(print_data):
        decoded = _decode_chamber_value(value)
        if decoded is not None:
            return decoded
    return None


# The chamber *target* lives either in the high 16 bits of the same encoded
# reading (heater on) or in an explicit field. A valid target is 0–60 °C.
def decode_bambu_chamber_target(print_data: dict[str, Any]) -> float | None:
    explicit = [print_data.get("mc_target_cham")]
    ctc = print_data.get("ctc")
    if isinstance(ctc, dict) and isinstance(ctc.get("info"), dict):
        explicit.append(ctc["info"].get("target"))
    for value in explicit:
        if isinstance(value, (int, float)) and 0 <= value <= 60:
            return float(value)
    # Fall back to the target packed into an encoded reading.
    for value in _chamber_temp_candidates(print_data):
        if isinstance(value, (int, float)) and value > 500:
            target = int(value) // 65536
            if 0 <= target <= 60:
                return float(target)
    return None


# A nozzle reading in the device.extruder.info[] structure is either a plain
# Celsius value or packed `target * 65536 + current` (the low 16 bits are the
# current temp), the same encoding the chamber uses. Returns (current, target) in
# °C, with either element None when that part can't be decoded.
def _decode_nozzle_value(value: Any) -> tuple[float | None, float | None]:
    if not isinstance(value, (int, float)):
        return None, None
    if value > 500:
        current = int(value) % 65536
        target = int(value) // 65536
        return (
            float(current) if -50 < current < 500 else None,
            float(target) if 0 <= target < 500 else None,
        )
    if -50 < value < 500:
        return float(value), None
    return None, None


# Pull the two H2D nozzles out of the report. The per-nozzle temps live in
# device.extruder.info[], each entry tagged with an `id` (0 = right, 1 = left,
# matching the tool index the temperature command sends as T0/T1) plus current and
# target readings. We return temps/targets in tool-index order [right, left] and
# fall back to the last-known values (and the flat nozzle_temper field) when the
# cached report omits the structure. The field names and packing are device-specific
# and may need further tuning on a real H2D.
def build_bambu_dual_nozzles(
    print_data: dict[str, Any],
    fallback_nozzle: float,
    fallback_temps: list[Any],
    fallback_targets: list[Any],
) -> tuple[list[int], list[int]]:
    info = ((print_data.get("device") or {}).get("extruder") or {}).get("info")
    by_id: dict[int, dict[str, Any]] = {}
    if isinstance(info, list):
        for entry in info:
            if isinstance(entry, dict) and isinstance(entry.get("id"), (int, float)):
                by_id[int(entry["id"])] = entry

    temps: list[int] = []
    targets: list[int] = []
    for index in (0, 1):
        entry = by_id.get(index) or {}
        current, packed_target = _decode_nozzle_value(entry.get("temp"))
        explicit_target = entry.get("target")
        target = (
            float(explicit_target)
            if isinstance(explicit_target, (int, float)) and 0 <= explicit_target < 500
            else packed_target
        )

        if current is None:
            current = fallback_temps[index] if index < len(fallback_temps) else fallback_nozzle
        if target is None:
            target = fallback_targets[index] if index < len(fallback_targets) else 0

        temps.append(round(current or 0))
        targets.append(round(target or 0))

    # No per-nozzle structure (e.g. a cached report) — surface the flat field on the
    # right/primary nozzle (T0) so the reading isn't stuck at the fallback for both.
    if not by_id:
        legacy = print_data.get("nozzle_temper")
        if isinstance(legacy, (int, float)):
            temps[0] = round(legacy)
        legacy_target = print_data.get("nozzle_target_temper")
        if isinstance(legacy_target, (int, float)):
            targets[0] = round(legacy_target)

    return temps, targets


def fetch_bambu_status(printer: dict[str, Any]) -> dict[str, Any]:
    if not (printer.get("serial") or "").strip():
        raise RuntimeError("Bambu printer is missing its serial number")
    client = get_bambu_client(printer)
    print_data = client.latest_report()
    if print_data is None:
        # No fresh MQTT report — let the caller apply the offline grace period.
        raise RuntimeError("No recent MQTT report from Bambu printer")

    gcode_state = print_data.get("gcode_state")
    status = map_bambu_state(gcode_state)

    fallback_nozzle = ((printer.get("temperature") or {}).get("nozzle")) or 0
    fallback_bed = ((printer.get("temperature") or {}).get("bed")) or 0
    fallback_chamber = ((printer.get("temperature") or {}).get("chamber")) or 0
    raw_nozzle = print_data.get("nozzle_temper")
    raw_bed = print_data.get("bed_temper")
    nozzle_temperature = round(raw_nozzle) if isinstance(raw_nozzle, (int, float)) else fallback_nozzle
    bed_temperature = round(raw_bed) if isinstance(raw_bed, (int, float)) else fallback_bed
    # The H2 series encodes its chamber reading (see decode_bambu_chamber_temp);
    # other Bambu models don't report a usable chamber temp, so keep the fallback.
    decoded_chamber = decode_bambu_chamber_temp(print_data)
    chamber_temperature = round(decoded_chamber) if decoded_chamber is not None else fallback_chamber
    decoded_chamber_target = decode_bambu_chamber_target(print_data)
    chamber_target = (
        round(decoded_chamber_target)
        if decoded_chamber_target is not None
        else (printer.get("chamberTarget") or 0)
    )

    # Target temps keep the set-temp box in sync with the live target.
    existing_nozzle_targets = printer.get("nozzleTargets") or []
    fallback_nozzle_target = existing_nozzle_targets[0] if existing_nozzle_targets else 0
    raw_nozzle_target = print_data.get("nozzle_target_temper")
    raw_bed_target = print_data.get("bed_target_temper")
    nozzle_target = (
        round(raw_nozzle_target)
        if isinstance(raw_nozzle_target, (int, float))
        else fallback_nozzle_target
    )
    bed_target = (
        round(raw_bed_target)
        if isinstance(raw_bed_target, (int, float))
        else (printer.get("bedTarget") or 0)
    )

    raw_percent = print_data.get("mc_percent")
    progress = 0
    if isinstance(raw_percent, (int, float)):
        progress = max(0, min(100, round(raw_percent)))

    raw_remaining = print_data.get("mc_remaining_time")
    remaining_minutes = (
        max(0, round(raw_remaining)) if isinstance(raw_remaining, (int, float)) else 0
    )

    # The chamber light state only appears in the full (pushall) report; the
    # cached report retains it, so fall back to the last-known value otherwise.
    light_on = printer.get("lightOn")
    lights_report = print_data.get("lights_report")
    if isinstance(lights_report, list):
        for entry in lights_report:
            if isinstance(entry, dict) and entry.get("node") == "chamber_light":
                light_on = entry.get("mode") == "on"
                break

    # The H2 air-filter state is the airduct's filtration submode (verified live:
    # device.airduct.subMode flips 0→1 with BambuStudio's "Filter" switch / the
    # set_airduct toggle, see setPrinterAirFilter). It only appears in the full
    # (pushall) report; the cached report drops it, so fall back to last-known.
    air_filter_on = printer.get("airFilterOn")
    airduct = (print_data.get("device") or {}).get("airduct")
    if isinstance(airduct, dict):
        submode = airduct.get("subMode")
        if isinstance(submode, (int, float)):
            air_filter_on = int(submode) == 1

    # The H2D is dual-nozzle (left + right); everything else reports a single nozzle.
    if printer.get("profile") in BAMBU_DUAL_NOZZLE_PROFILES:
        nozzle_temperatures, nozzle_targets = build_bambu_dual_nozzles(
            print_data,
            nozzle_temperature,
            printer.get("nozzleTemperatures") or [],
            printer.get("nozzleTargets") or [],
        )
    else:
        nozzle_temperatures = [nozzle_temperature]
        nozzle_targets = [nozzle_target]

    spools = build_bambu_spools(print_data) or printer.get("spools")
    current_job = build_bambu_current_job(
        print_data, printer.get("currentJob"), progress, status, remaining_minutes
    )
    # Bambu reports no live grams-used; derive it from the AMS remaining delta.
    update_bambu_filament_used(printer.get("id"), current_job, spools)

    return {
        "status": status,
        "currentJob": current_job,
        "progress": progress,
        "rawPrintState": gcode_state.lower() if isinstance(gcode_state, str) else None,
        "temperature": {
            "nozzle": nozzle_temperature,
            "bed": bed_temperature,
            "chamber": chamber_temperature,
        },
        "nozzleTemperatures": nozzle_temperatures,
        "nozzleTargets": nozzle_targets,
        "bedTarget": bed_target,
        "chamberTarget": chamber_target,
        "spools": spools,
        "fanSpeeds": build_bambu_fan_speeds(print_data, printer.get("profile"))
        or printer.get("fanSpeeds"),
        "lightOn": light_on,
        "airFilterOn": air_filter_on,
        # HMS/print_error run-out signal, edge-detected in check_filament_runout.
        # Transient (notification-only); not persisted by upsert_printer.
        "filamentRunout": bambu_filament_runout(print_data),
        # Slot currently feeding the nozzle, so the run-out alert names (and gates
        # on) the filament the print is actually using. Transient; not persisted.
        "activeSpoolId": bambu_active_spool_id(print_data),
    }


def refresh_status(printer: dict[str, Any]) -> dict[str, Any]:
    profile = printer.get("profile")
    if profile == "snapmaker_u1":
        live_status = fetch_snapmaker_status(printer)
        try:
            live_status["spools"] = fetch_snapmaker_task_config(printer)
        except Exception:
            live_status["spools"] = printer.get("spools")
    elif profile in BAMBU_PROFILES:
        live_status = fetch_bambu_status(printer)
    else:
        live_status = fetch_generic_status(printer)
    return {**printer, **live_status, "offlineSince": None}


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


def discord_color_for_status(status: str | None) -> int:
    return {
        "printing": 0x3B82F6,
        "paused": 0xFACC15,
        "idle": 0x22C55E,
        "offline": 0xEF4444,
        "error": 0xEF4444,
        "completed": 0x22C55E,
        "failed": 0xEF4444,
    }.get((status or "").lower(), 0x5865F2)


def iso_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def grab_mjpeg_frame(url: str) -> bytes | None:
    """Pull the first complete JPEG frame out of a multipart/x-mixed-replace MJPEG
    stream, then drop the connection. The web camera hub paints the latest frame to
    a new viewer immediately, so this returns a live-view frame within a frame or
    two rather than waiting on a full GOP."""
    with requests.get(url, stream=True, timeout=BAMBU_SNAPSHOT_TIMEOUT_SECONDS) as response:
        response.raise_for_status()
        buffer = bytearray()
        for chunk in response.iter_content(chunk_size=16384):
            if chunk:
                buffer += chunk
            header_end = buffer.find(b"\r\n\r\n")
            if header_end == -1:
                # Bound the buffer so a malformed stream can't grow without limit.
                if len(buffer) > 65536:
                    return None
                continue
            match = _MJPEG_CONTENT_LENGTH_RE.search(buffer[:header_end])
            if not match:
                return None
            length = int(match.group(1))
            if length <= 0 or length > MAX_FRAME_BYTES:
                return None
            body_start = header_end + 4
            if len(buffer) - body_start < length:
                continue
            return bytes(buffer[body_start : body_start + length])
    return None


def fetch_bambu_snapshot(printer: dict[str, Any]) -> bytes | None:
    """Grab a Bambu camera frame via the web service, which already speaks both
    Bambu camera protocols. For H2/X1-class printers the frame is pulled from the
    live MJPEG stream (the same feed shown on the detail page); the A1 Mini has no
    live view, so it falls back to the port-6000 snapshot. The poller can't reach
    the camera directly, so it reuses the web endpoints over the compose network."""
    printer_id = printer.get("id")
    if not printer_id:
        return None
    encoded_id = quote(str(printer_id), safe="")
    webcam_base = f"{WEB_SNAPSHOT_BASE_URL}/__printer_webcam/{encoded_id}"
    try:
        if printer.get("profile") in BAMBU_RTSP_PROFILES:
            return grab_mjpeg_frame(f"{webcam_base}/stream.mjpg")
        response = requests.get(
            f"{webcam_base}/snapshot.jpg",
            timeout=BAMBU_SNAPSHOT_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return response.content
    except Exception:
        return None


def fetch_printer_snapshot(printer: dict[str, Any]) -> bytes | None:
    if printer.get("profile") in BAMBU_PROFILES:
        return fetch_bambu_snapshot(printer)
    try:
        response = requests.get(
            f"{printer['url']}/webcam/snapshot.jpg",
            headers=parse_header_string(printer.get("apiKeyHeader", "")),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return response.content
    except Exception:
        return None


def webhook_wants(webhook: dict[str, Any], event_key: str) -> bool:
    """A webhook with events == None receives every event (historical default);
    a list restricts it to the listed event keys. A webhook with enabled == False
    is muted entirely."""
    if webhook.get("enabled") is False:
        return False
    events = webhook.get("events")
    if not isinstance(events, list):
        return True
    return event_key in events


def send_discord_embed(
    webhooks: list[dict[str, Any]],
    embed: dict[str, Any],
    event_key: str,
    snapshot_bytes: bytes | None = None,
) -> None:
    if not embed:
        return

    for webhook in webhooks:
        webhook_url = webhook.get("webhookUrl")
        if not webhook_url or not webhook_wants(webhook, event_key):
            continue

        username = webhook.get("name") or "PrintFarm Bot"
        try:
            if snapshot_bytes:
                embed_with_image = {**embed, "image": {"url": "attachment://snapshot.jpg"}}
                requests.post(
                    webhook_url,
                    data={
                        "payload_json": json.dumps(
                            {
                                "username": username,
                                "embeds": [embed_with_image],
                            }
                        )
                    },
                    files={"file": ("snapshot.jpg", BytesIO(snapshot_bytes), "image/jpeg")},
                    timeout=REQUEST_TIMEOUT_SECONDS,
                ).raise_for_status()
            else:
                requests.post(
                    webhook_url,
                    json={
                        "username": username,
                        "embeds": [embed],
                    },
                    timeout=REQUEST_TIMEOUT_SECONDS,
                ).raise_for_status()
        except Exception as error:
            print(f"discord webhook error ({webhook.get('name', 'unknown')}): {error}", flush=True)


def build_status_transition_embed(previous_printer: dict[str, Any], next_printer: dict[str, Any]) -> dict[str, Any] | None:
    previous_status = previous_printer.get("status")
    next_status = next_printer.get("status")

    if previous_status == next_status:
        return None

    printer_name = next_printer.get("name") or previous_printer.get("name") or "Printer"
    if previous_status == "offline" and next_status != "offline":
        title = f"{printer_name} Online"
        description = "Connection restored"
        status_value = "online"
        color = discord_color_for_status("completed")
        event_key = "printer_online"
    elif previous_status != "offline" and next_status == "offline":
        title = f"{printer_name} Offline"
        description = "Connection lost"
        status_value = "offline"
        color = discord_color_for_status("offline")
        event_key = "printer_offline"
    else:
        return None

    return {
        "event": event_key,
        "embed": {
            "title": title,
            "description": description,
            "color": color,
            "fields": [
                {"name": "Printer", "value": printer_name, "inline": True},
                {"name": "Status", "value": status_value, "inline": True},
            ],
            "timestamp": iso_timestamp(),
        },
    }


def build_job_transition_event(
    previous_printer: dict[str, Any], next_printer: dict[str, Any]
) -> dict[str, Any] | None:
    previous_job = previous_printer.get("currentJob") or {}
    next_job = next_printer.get("currentJob") or {}
    previous_filename = previous_job.get("filename")
    next_filename = next_job.get("filename")
    printer_name = next_printer.get("name") or previous_printer.get("name") or "Printer"

    if not previous_filename and not next_filename:
        return None

    if not previous_filename and next_filename:
        return {
            "event": "print_started",
            "embed": {
                "title": f"{printer_name} Print Started",
                "description": str(next_filename),
                "color": discord_color_for_status("printing"),
                "fields": [
                    {"name": "Printer", "value": printer_name, "inline": True},
                ],
                "timestamp": iso_timestamp(),
            },
            "includeSnapshot": False,
        }

    if previous_filename and not next_filename:
        raw_print_state = next_printer.get("rawPrintState")
        if raw_print_state in ("cancelled", "failed"):
            title = f"{printer_name} Print Cancelled"
            description = f"{previous_filename}\nCancelled by printer state"
            color = discord_color_for_status("failed")
            include_snapshot = True
            event_key = "print_cancelled"
        else:
            next_status = next_printer.get("status")
            title = f"{printer_name} Print Completed" if next_status != "error" else f"{printer_name} Print Stopped"
            description = str(previous_filename)
            color = discord_color_for_status("failed" if next_status == "error" else "completed")
            include_snapshot = next_status != "error"
            event_key = "print_completed"

        return {
            "event": event_key,
            "embed": {
                "title": title,
                "description": description,
                "color": color,
                "fields": [
                    {"name": "Printer", "value": printer_name, "inline": True},
                    {
                        "name": "Filament Used",
                        "value": f"{previous_job.get('filamentUsed', 0)} g",
                        "inline": True,
                    },
                ],
                "timestamp": iso_timestamp(),
            },
            "includeSnapshot": include_snapshot,
        }

    if previous_filename != next_filename:
        return {
            "event": "print_started",
            "embed": {
                "title": f"{printer_name} Print Job Switched",
                "description": f"{previous_filename} -> {next_filename}",
                "color": discord_color_for_status("printing"),
                "timestamp": iso_timestamp(),
            },
            "includeSnapshot": False,
        }

    previous_job_status = previous_job.get("status")
    next_job_status = next_job.get("status")
    if previous_job_status == next_job_status:
        return None

    if previous_job_status == "paused" and next_job_status == "printing":
        title = f"{printer_name} Print Resumed"
        status_color = "printing"
        event_key = "print_resumed"
    elif previous_job_status == "printing" and next_job_status == "paused":
        title = f"{printer_name} Print Paused"
        status_color = "paused"
        event_key = "print_paused"
    else:
        return None

    return {
        "event": event_key,
        "embed": {
            "title": title,
            "description": str(next_filename),
            "color": discord_color_for_status(status_color),
            "fields": [
                {"name": "Printer", "value": printer_name, "inline": True},
                {"name": "Progress", "value": f"{next_printer.get('progress', 0)}%", "inline": True},
            ],
            "timestamp": iso_timestamp(),
        },
        "includeSnapshot": False,
    }


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
    if raw_print_state in ("cancelled", "failed"):
        outcome = "failed"
    else:
        outcome = "failed" if next_status == "error" else "completed"
    finalize_job_analytics(conn, previous_job, outcome)


# A heater counts as "at target" once it is within this many °C of the setpoint.
TEMP_REACHED_TOLERANCE = 2

# Spool ids seen while each printer was last printing. A loaded spool that vanishes
# between two printing cycles means filament ran out (or was removed). This is the
# clean signal for Snapmaker U1 (its spool list is built straight from
# print_task_config.filament_exist). For Bambu the spool list falls back to the
# last-known spools when a report is momentarily empty (see build_bambu_spools),
# so the disappearance heuristic is unreliable there; Bambu run-out is instead
# detected precisely from the HMS/print_error codes (next_printer["filamentRunout"],
# built by bambu_filament_runout) and edge-detected via _RUNOUT_REPORTED below.
_PRINTING_SPOOLS: dict[str, set[str]] = {}
# Last-reported HMS run-out flag per printer, so we alert once per run-out rather
# than every poll while the fault (and its paused print) persist.
_RUNOUT_REPORTED: dict[str, bool] = {}


def spool_ids(printer: dict[str, Any]) -> set[str]:
    return {
        spool["id"]
        for spool in (printer.get("spools") or [])
        if isinstance(spool, dict) and spool.get("id")
    }


def check_filament_runout(next_printer: dict[str, Any]) -> bool:
    """Fire once when filament runs out, from either signal:

    - Bambu: the HMS/print_error run-out flag (`filamentRunout`), edge-detected
      so the alert fires on the false→true transition. This works regardless of
      print state because a run-out typically pauses the print.
    - Snapmaker/generic: a loaded spool disappearing mid-print.
    """
    printer_id = next_printer.get("id")
    if printer_id is None:
        return False

    runout_active = bool(next_printer.get("filamentRunout"))
    previously_reported = _RUNOUT_REPORTED.get(printer_id, False)
    _RUNOUT_REPORTED[printer_id] = runout_active
    hms_edge = runout_active and not previously_reported

    if next_printer.get("status") != "printing":
        _PRINTING_SPOOLS.pop(printer_id, None)
        return hms_edge

    current_ids = spool_ids(next_printer)
    previous_ids = _PRINTING_SPOOLS.get(printer_id)
    _PRINTING_SPOOLS[printer_id] = current_ids

    # Only the spool the print is actually feeding from counts as a run-out — an
    # idle loaded spool being removed or depleted must not alert. When the active
    # spool is known we require *it* to have vanished; otherwise fall back to any
    # disappearance so a genuine run-out is never missed.
    disappeared = previous_ids - current_ids if previous_ids is not None else set()
    active_spool_id = next_printer.get("activeSpoolId")
    spool_edge = active_spool_id in disappeared if active_spool_id else bool(disappeared)
    return hms_edge or spool_edge


def humanize_spool_id(spool_id: str | None) -> str | None:
    """Turn an internal slot id (tool-1, ams0-2, external) into a label for alerts."""
    if not spool_id:
        return None
    if spool_id == "external":
        return "External spool"
    if spool_id.startswith("tool-"):
        return f"Lane {spool_id[len('tool-'):]}"
    if spool_id.startswith("ams"):
        try:
            unit, tray = spool_id[len("ams"):].split("-")
            return f"AMS {int(unit) + 1} slot {int(tray) + 1}"
        except (ValueError, IndexError):
            return spool_id
    return spool_id


def build_filament_runout_embed(printer: dict[str, Any]) -> dict[str, Any]:
    printer_name = printer.get("name") or "Printer"
    job = printer.get("currentJob") or {}
    filename = job.get("filename")
    fields = [{"name": "Printer", "value": printer_name, "inline": True}]
    if filename:
        fields.append({"name": "Job", "value": str(filename), "inline": True})
    slot_label = humanize_spool_id(printer.get("activeSpoolId"))
    if slot_label:
        fields.append({"name": "Filament", "value": slot_label, "inline": True})
    return {
        "title": f"{printer_name} Out of Filament",
        "description": "The filament feeding the current print was depleted or removed.",
        "color": discord_color_for_status("failed"),
        "fields": fields,
        "timestamp": iso_timestamp(),
    }


def build_temp_reached_embed(
    previous_printer: dict[str, Any], next_printer: dict[str, Any]
) -> dict[str, Any] | None:
    """Edge-detect a heater crossing into its target band (fires once per heat-up)."""
    printer_name = next_printer.get("name") or previous_printer.get("name") or "Printer"
    reached: list[tuple[str, float, float]] = []

    prev_nozzles = previous_printer.get("nozzleTemperatures") or []
    next_nozzles = next_printer.get("nozzleTemperatures") or []
    next_targets = next_printer.get("nozzleTargets") or []
    multi_nozzle = len([t for t in next_targets if isinstance(t, (int, float)) and t > 0]) > 1

    for index, target in enumerate(next_targets):
        if not isinstance(target, (int, float)) or target <= 0:
            continue
        next_temp = next_nozzles[index] if index < len(next_nozzles) else None
        prev_temp = prev_nozzles[index] if index < len(prev_nozzles) else None
        if not isinstance(next_temp, (int, float)) or not isinstance(prev_temp, (int, float)):
            continue
        threshold = target - TEMP_REACHED_TOLERANCE
        if prev_temp < threshold <= next_temp:
            label = f"Nozzle {index + 1}" if multi_nozzle else "Nozzle"
            reached.append((label, next_temp, target))

    bed_target = next_printer.get("bedTarget")
    next_bed = (next_printer.get("temperature") or {}).get("bed")
    prev_bed = (previous_printer.get("temperature") or {}).get("bed")
    if (
        isinstance(bed_target, (int, float))
        and bed_target > 0
        and isinstance(next_bed, (int, float))
        and isinstance(prev_bed, (int, float))
    ):
        threshold = bed_target - TEMP_REACHED_TOLERANCE
        if prev_bed < threshold <= next_bed:
            reached.append(("Bed", next_bed, bed_target))

    if not reached:
        return None

    fields = [{"name": "Printer", "value": printer_name, "inline": False}]
    for label, temp, target in reached:
        fields.append({"name": label, "value": f"{temp}°C / {target}°C", "inline": True})

    return {
        "title": f"{printer_name} Reached Target Temperature",
        "description": ", ".join(label for label, _, _ in reached),
        "color": discord_color_for_status("printing"),
        "fields": fields,
        "timestamp": iso_timestamp(),
    }


def notify_for_transition(
    webhooks: list[dict[str, Any]], previous_printer: dict[str, Any], next_printer: dict[str, Any]
) -> None:
    if not webhooks:
        return

    status_event = build_status_transition_embed(previous_printer, next_printer)
    if status_event:
        send_discord_embed(webhooks, status_event["embed"], status_event["event"])

    temp_embed = build_temp_reached_embed(previous_printer, next_printer)
    if temp_embed:
        send_discord_embed(webhooks, temp_embed, "temp_target_reached")

    if check_filament_runout(next_printer):
        send_discord_embed(webhooks, build_filament_runout_embed(next_printer), "filament_runout")

    job_event = build_job_transition_event(previous_printer, next_printer)
    if not job_event:
        return

    snapshot_bytes = fetch_printer_snapshot(previous_printer) if job_event.get("includeSnapshot") else None
    send_discord_embed(webhooks, job_event["embed"], job_event["event"], snapshot_bytes)


# The lifetime print-hours counter (printers.total_print_time) is owned by the
# poller, not the API: while a printer reports "printing" we add the wall-clock
# time elapsed since we last saw it printing. Idle/paused/offline printers don't
# accrue. The per-printer timestamp lives in memory, so a poller restart simply
# forgoes crediting the single interval that spans the restart (an undercount,
# never an overcount). Full precision is kept in the DB; only the API/UI round
# the value for display, so even sub-second per-poll increments add up.
_PRINTING_SINCE: dict[str, float] = {}


def accumulate_total_print_time(printer: dict[str, Any], now: float | None = None) -> float:
    printer_id = printer.get("id")
    current_time = time.time() if now is None else now

    total = printer.get("totalPrintTime")
    if not isinstance(total, (int, float)):
        total = 0.0

    last_seen = _PRINTING_SINCE.get(printer_id)
    if printer.get("status") == "printing":
        if last_seen is not None:
            elapsed = current_time - last_seen
            if 0 < elapsed <= MAX_PRINT_TIME_STEP_SECONDS:
                total += elapsed / 3600
        _PRINTING_SINCE[printer_id] = current_time
    elif printer_id is not None:
        _PRINTING_SINCE.pop(printer_id, None)

    return total


def prune_print_time_tracking(active_ids: set[str]) -> None:
    """Forget per-printer in-memory tracking for printers that no longer exist."""
    for printer_id in list(_PRINTING_SINCE.keys()):
        if printer_id not in active_ids:
            _PRINTING_SINCE.pop(printer_id, None)
    for printer_id in list(_PRINTING_SPOOLS.keys()):
        if printer_id not in active_ids:
            _PRINTING_SPOOLS.pop(printer_id, None)
    for printer_id in list(_RUNOUT_REPORTED.keys()):
        if printer_id not in active_ids:
            _RUNOUT_REPORTED.pop(printer_id, None)
    for printer_id in list(_BAMBU_PRINT_BASELINE.keys()):
        if printer_id not in active_ids:
            _BAMBU_PRINT_BASELINE.pop(printer_id, None)


def compute_next_printer(printer: dict[str, Any]) -> dict[str, Any]:
    """Refresh one printer's live status — network/MQTT I/O only, no DB access.

    Safe to run in a worker thread: it never touches the psycopg connection or the
    main-thread-only print-time tracker. Any failure falls back to the offline
    grace-period state, mirroring the previous inline behaviour.
    """
    try:
        return refresh_status(printer)
    except Exception:
        return apply_offline_grace_period(printer)


# Refresh printers concurrently. Snapmaker/generic polling is blocking HTTP (each
# up to REQUEST_TIMEOUT_SECONDS), so doing them in series let one slow/offline
# printer stall the whole cycle; a small thread pool bounds the cycle to roughly
# one printer's timeout instead of the sum. DB writes stay on the main thread.
_REFRESH_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="poller-refresh")


def run() -> None:
    # One long-lived connection, reused across poll cycles. Reconnecting every
    # cycle (and re-running the full schema DDL each time) is a connection storm
    # plus catalog-lock churn against the DB every few seconds — the schema only
    # needs to be ensured once per connection.
    conn: psycopg.Connection | None = None
    schema_ready = False

    while True:
        try:
            if conn is None or conn.closed:
                conn = psycopg.connect(db_url())
                schema_ready = False
            if not schema_ready:
                ensure_schema(conn)
                schema_ready = True

            printers = list_printers(conn)
            active_ids = {printer["id"] for printer in printers}
            prune_bambu_clients(active_ids)
            prune_print_time_tracking(active_ids)
            webhooks = list_discord_webhooks(conn)
            slicer_estimates = list_slicer_estimates(conn)

            # Concurrent, side-effect-free refresh; DB writes and the
            # _PRINTING_SINCE tracker run sequentially on this thread below
            # (psycopg connections and that dict are not shared across threads).
            next_printers = (
                list(_REFRESH_POOL.map(compute_next_printer, printers)) if printers else []
            )

            for printer, next_printer in zip(printers, next_printers):
                # For a Bambu print with no estimate yet (e.g. started from Studio /
                # the SD card, not the slicer-proxy), pull its .3mf off the printer
                # over FTPS and record the exact slicer figure (bambuddy parity).
                maybe_record_bambu_3mf_estimate(conn, printer, next_printer, slicer_estimates)
                # Prefer the slicer's exact 3MF estimate over the AMS-delta
                # fallback before analytics/persistence read filamentUsed.
                apply_slicer_filament_estimate(next_printer, slicer_estimates)
                next_printer["totalPrintTime"] = accumulate_total_print_time(next_printer)
                collect_analytics_for_transition(conn, printer, next_printer)
                notify_for_transition(webhooks, printer, next_printer)
                upsert_printer(conn, next_printer)
            conn.commit()
        except Exception as error:
            print(f"printer poller error: {error}", flush=True)
            # The connection may be in an aborted-transaction state after an
            # error; drop it so the next cycle reconnects cleanly.
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            conn = None
            schema_ready = False

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
