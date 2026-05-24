import calendar
import json
import os
import ssl
import threading
import time
from io import BytesIO
from typing import Any

import paho.mqtt.client as mqtt
import psycopg
import requests

POLL_INTERVAL_SECONDS = max(int(os.getenv("PRINTER_POLL_INTERVAL_MS", "5000")) / 1000, 1)
REQUEST_TIMEOUT_SECONDS = max(int(os.getenv("PRINTER_REQUEST_TIMEOUT_MS", "3000")) / 1000, 1)
OFFLINE_GRACE_SECONDS = max(int(os.getenv("PRINTER_OFFLINE_GRACE_SECONDS", "30")), 0)
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
ALTER TABLE printers ADD COLUMN IF NOT EXISTS serial TEXT;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS light_on BOOLEAN;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS nozzle_targets JSONB;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS bed_target DOUBLE PRECISION;
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
SELECT pg_advisory_unlock(90210);
"""

SNAPMAKER_STATUS_PATH = (
    "/printer/objects/query?print_stats&extruder=temperature,target"
    "&extruder1=temperature,target&extruder2=temperature,target"
    "&extruder3=temperature,target&heater_bed=temperature,target"
    "&virtual_sdcard=progress"
)

# Bambu Lab printers report over MQTT-over-TLS in LAN mode (no HTTP status API).
# Auth is the LAN access code (stored in the printer's api_key_header field) with a
# fixed "bblp" username; the serial is learned from the report topic.
BAMBU_MQTT_PORT = 8883
BAMBU_MQTT_USERNAME = "bblp"
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
              json_build_object('nozzle', temperature_nozzle, 'bed', temperature_bed) AS temperature,
              progress,
              last_maintenance AS "lastMaintenance",
              total_print_time AS "totalPrintTime",
              success_rate AS "successRate",
              current_job AS "currentJob",
              nozzle_temperatures AS "nozzleTemperatures",
              nozzle_targets AS "nozzleTargets",
              bed_target AS "bedTarget",
              spools,
              light_on AS "lightOn",
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
              progress,
              last_maintenance,
              total_print_time,
              success_rate,
              current_job,
              nozzle_temperatures,
              nozzle_targets,
              bed_target,
              spools,
              light_on,
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
              %(progress)s,
              %(lastMaintenance)s,
              %(totalPrintTime)s,
              %(successRate)s,
              %(currentJob)s::jsonb,
              %(nozzleTemperatures)s::jsonb,
              %(nozzleTargets)s::jsonb,
              %(bedTarget)s,
              %(spools)s::jsonb,
              %(lightOn)s,
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
              progress = EXCLUDED.progress,
              last_maintenance = EXCLUDED.last_maintenance,
              total_print_time = EXCLUDED.total_print_time,
              success_rate = EXCLUDED.success_rate,
              current_job = EXCLUDED.current_job,
              nozzle_temperatures = EXCLUDED.nozzle_temperatures,
              nozzle_targets = EXCLUDED.nozzle_targets,
              bed_target = EXCLUDED.bed_target,
              spools = EXCLUDED.spools,
              light_on = EXCLUDED.light_on,
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
                "progress": printer.get("progress", 0),
                "lastMaintenance": printer["lastMaintenance"],
                "totalPrintTime": printer.get("totalPrintTime", 0),
                "successRate": printer.get("successRate", 0),
                "currentJob": json.dumps(printer.get("currentJob")),
                "nozzleTemperatures": json.dumps(printer.get("nozzleTemperatures")),
                "nozzleTargets": json.dumps(printer.get("nozzleTargets")),
                "bedTarget": printer.get("bedTarget"),
                "spools": json.dumps(printer.get("spools")),
                "lightOn": printer.get("lightOn"),
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
              webhook_url AS "webhookUrl"
            FROM discord_webhooks
            ORDER BY created_at ASC
            """
        )
        return list(cur.fetchall())


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
        "temperature": {"nozzle": 0, "bed": 0},
        "nozzleTemperatures": [0 for _ in nozzle_temperatures] if nozzle_temperatures else [0],
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
        remaining = (
            max(0, min(100, round(remain)))
            if isinstance(remain, (int, float)) and remain >= 0
            else 0
        )
        try:
            weight = float(tray.get("tray_weight") or 0)
        except (TypeError, ValueError):
            weight = 0
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
    raw_nozzle = print_data.get("nozzle_temper")
    raw_bed = print_data.get("bed_temper")
    nozzle_temperature = round(raw_nozzle) if isinstance(raw_nozzle, (int, float)) else fallback_nozzle
    bed_temperature = round(raw_bed) if isinstance(raw_bed, (int, float)) else fallback_bed

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

    return {
        "status": status,
        "currentJob": build_bambu_current_job(
            print_data, printer.get("currentJob"), progress, status, remaining_minutes
        ),
        "progress": progress,
        "rawPrintState": gcode_state.lower() if isinstance(gcode_state, str) else None,
        "temperature": {"nozzle": nozzle_temperature, "bed": bed_temperature},
        "nozzleTemperatures": [nozzle_temperature],
        "nozzleTargets": [nozzle_target],
        "bedTarget": bed_target,
        "spools": build_bambu_spools(print_data) or printer.get("spools"),
        "lightOn": light_on,
    }


def refresh_status(printer: dict[str, Any]) -> dict[str, Any]:
    profile = printer.get("profile")
    if profile == "snapmaker_u1":
        live_status = fetch_snapmaker_status(printer)
        try:
            live_status["spools"] = fetch_snapmaker_task_config(printer)
        except Exception:
            live_status["spools"] = printer.get("spools")
    elif profile == "bambulab_a1_mini":
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


def fetch_printer_snapshot(printer: dict[str, Any]) -> bytes | None:
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


def send_discord_embed(
    webhooks: list[dict[str, Any]], embed: dict[str, Any], snapshot_bytes: bytes | None = None
) -> None:
    if not embed:
        return

    for webhook in webhooks:
        webhook_url = webhook.get("webhookUrl")
        if not webhook_url:
            continue

        try:
            if snapshot_bytes:
                embed_with_image = {**embed, "image": {"url": "attachment://snapshot.jpg"}}
                requests.post(
                    webhook_url,
                    data={
                        "payload_json": json.dumps(
                            {
                                "username": "PrintFarm Bot",
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
                        "username": "PrintFarm Bot",
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
    elif previous_status != "offline" and next_status == "offline":
        title = f"{printer_name} Offline"
        description = "Connection lost"
        status_value = "offline"
        color = discord_color_for_status("offline")
    else:
        return None

    return {
        "title": title,
        "description": description,
        "color": color,
        "fields": [
            {"name": "Printer", "value": printer_name, "inline": True},
            {"name": "Status", "value": status_value, "inline": True},
        ],
        "timestamp": iso_timestamp(),
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
        else:
            next_status = next_printer.get("status")
            title = f"{printer_name} Print Completed" if next_status != "error" else f"{printer_name} Print Stopped"
            description = str(previous_filename)
            color = discord_color_for_status("failed" if next_status == "error" else "completed")
            include_snapshot = next_status != "error"

        return {
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
    elif previous_job_status == "printing" and next_job_status == "paused":
        title = f"{printer_name} Print Paused"
        status_color = "paused"
    else:
        return None

    return {
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


def notify_for_transition(
    webhooks: list[dict[str, Any]], previous_printer: dict[str, Any], next_printer: dict[str, Any]
) -> None:
    if not webhooks:
        return

    status_embed = build_status_transition_embed(previous_printer, next_printer)
    if status_embed:
        send_discord_embed(webhooks, status_embed)

    job_event = build_job_transition_event(previous_printer, next_printer)
    if not job_event:
        return

    snapshot_bytes = fetch_printer_snapshot(previous_printer) if job_event.get("includeSnapshot") else None
    send_discord_embed(webhooks, job_event["embed"], snapshot_bytes)


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
    """Forget print-time timestamps for printers that no longer exist."""
    for printer_id in list(_PRINTING_SINCE.keys()):
        if printer_id not in active_ids:
            _PRINTING_SINCE.pop(printer_id, None)


def run() -> None:
    while True:
        try:
            with psycopg.connect(db_url()) as conn:
                ensure_schema(conn)
                printers = list_printers(conn)
                active_ids = {printer["id"] for printer in printers}
                prune_bambu_clients(active_ids)
                prune_print_time_tracking(active_ids)
                webhooks = list_discord_webhooks(conn)
                for printer in printers:
                    try:
                        next_printer = refresh_status(printer)
                    except Exception:
                        next_printer = apply_offline_grace_period(printer)
                    next_printer["totalPrintTime"] = accumulate_total_print_time(next_printer)
                    collect_analytics_for_transition(conn, printer, next_printer)
                    notify_for_transition(webhooks, printer, next_printer)
                    upsert_printer(conn, next_printer)
                conn.commit()
        except Exception as error:
            print(f"printer poller error: {error}", flush=True)

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
