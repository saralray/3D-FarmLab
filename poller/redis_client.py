"""Optional Redis acceleration layer for the poller.

Redis is strictly optional. When REDIS_URL is unset this module is inert and every
helper is a no-op (returns False / None), so the poller keeps writing telemetry to
Postgres exactly as before. When REDIS_URL is set, the poller additionally publishes
each printer's live telemetry to a Redis hash so the web tier and exporter can read
hot state without hitting Postgres on every request.

Hard rule: nothing here may raise into the poll loop. Every call is wrapped; on any
error (down, timeout) we log once and degrade to a no-op. The client is created with
short socket timeouts so a dead Redis never stalls a poll cycle.
"""

import json
import os

try:
    import redis as _redis_lib
except ImportError:  # redis-py not installed — treat as disabled.
    _redis_lib = None

_REDIS_URL = (os.getenv("REDIS_URL") or "").strip()

_client = None
_warned = False


def _warn_once(message, err=None):
    global _warned
    if _warned:
        return
    _warned = True
    suffix = f": {err}" if err else ""
    print(f"[redis] {message}{suffix} — telemetry cache disabled", flush=True)


def is_redis_enabled():
    return bool(_REDIS_URL) and _redis_lib is not None


def _get_client():
    """Lazily build a fail-fast client. Short timeouts so a dead Redis can't stall
    the poll loop; health_check keeps a pooled socket honest across cycles."""
    global _client
    if not is_redis_enabled():
        return None
    if _client is not None:
        return _client
    try:
        _client = _redis_lib.Redis.from_url(
            _REDIS_URL,
            socket_connect_timeout=3,
            socket_timeout=3,
            health_check_interval=30,
            decode_responses=True,
        )
    except Exception as err:  # noqa: BLE001 — never let init break the poller
        _warn_once("failed to initialize", err)
        _client = None
    return _client


def publish_printer_telemetry(printer_id, telemetry, ttl_seconds=0):
    """Write a printer's live telemetry as a Redis hash (printer:<id>:live), values
    JSON-encoded so nested objects survive. Best-effort: returns True on success,
    False on any miss. Never raises."""
    client = _get_client()
    if client is None or not printer_id:
        return False
    try:
        key = f"printer:{printer_id}:live"
        mapping = {
            field: value if isinstance(value, str) else json.dumps(value, default=str)
            for field, value in telemetry.items()
        }
        if not mapping:
            return False
        client.hset(key, mapping=mapping)
        if ttl_seconds and ttl_seconds > 0:
            client.expire(key, int(ttl_seconds))
        return True
    except Exception as err:  # noqa: BLE001
        _warn_once("telemetry publish failed", err)
        return False
