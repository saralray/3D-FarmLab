// Presence tracker for the ESP32 per-printer status lights.
//
// The lights used to hold an MQTT subscription to an embedded broker; they now
// poll a plain HTTP endpoint instead (GET /api/status-light/printers/:id, see
// server/app.js). There is no broker anymore — this module just remembers when
// each device last polled so the dashboard's Status Light card can still show a
// Connected / Last-seen badge.
//
// A device is considered "connected" while it has polled within STALE_MS; if it
// stops polling (unplugged, WiFi dropped) it goes stale and the card shows it as
// disconnected. Single-process only, like eventStream.js: the map is in-memory,
// matching the documented single-`web`-replica assumption. It is rebuilt from
// live polls after every restart.

const DEFAULT_POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.STATUS_LIGHT_POLL_INTERVAL_MS || '5000', 10) || 5000,
);

// A device counts as connected until it has been silent for a few poll cycles.
const STALE_MS = Math.max(
  DEFAULT_POLL_INTERVAL_MS * 3,
  Number.parseInt(process.env.STATUS_LIGHT_STALE_MS || '0', 10) || 0,
);

export function statusLightEnabled() {
  // STATUS_LIGHT_ENABLED is the current knob; STATUS_LIGHT_MQTT_ENABLED is the
  // legacy name kept working so old .env files don't silently re-enable a
  // removed broker.
  if (process.env.STATUS_LIGHT_ENABLED === 'false') return false;
  if (process.env.STATUS_LIGHT_MQTT_ENABLED === 'false') return false;
  return true;
}

export function statusLightPollIntervalMs() {
  return DEFAULT_POLL_INTERVAL_MS;
}

// printerId → last-poll epoch millis.
const lastSeen = new Map();

// Called each time a status light polls its printer's status endpoint.
export function recordDevicePoll(printerId) {
  if (typeof printerId !== 'string' || !printerId) return;
  lastSeen.set(printerId, Date.now());
}

export function getStatusLightDevices() {
  const now = Date.now();
  return [...lastSeen.entries()].map(([printerId, seenAt]) => ({
    printerId,
    connected: now - seenAt < STALE_MS,
    lastSeen: new Date(seenAt).toISOString(),
  }));
}
