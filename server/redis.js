// ── Optional Redis acceleration layer ────────────────────────────────────────
// Redis is strictly optional. When REDIS_URL is unset the whole module is inert
// and every helper resolves to a "miss" (null / false / 0), so callers fall back
// to their existing PostgreSQL / in-memory behavior with no change. When REDIS_URL
// is set, Redis is used as a *cache and shared counter* in front of Postgres —
// never as the source of truth — so a Redis outage degrades to the pre-Redis
// behavior rather than failing requests.
//
// Hard rule: nothing here may throw into a request path or the poll loop. Every
// command is wrapped; on any error (down, timeout, parse) we log once-ish and
// return the miss value. ioredis is configured to fail fast (enableOfflineQueue
// off, low per-command retry) so a dead Redis never hangs a request waiting to
// connect.

import Redis from 'ioredis';

const REDIS_URL = (process.env.REDIS_URL || '').trim();

let client = null;
let warned = false;

function warnOnce(message, err) {
  if (warned) {
    return;
  }
  warned = true;
  console.warn(`[redis] ${message}${err ? `: ${err.message || err}` : ''} — falling back to Postgres/in-memory`);
}

// Lazily construct the singleton ioredis client the first time Redis is used.
// enableOfflineQueue:false makes commands reject immediately while disconnected
// instead of buffering forever; maxRetriesPerRequest:1 bounds per-command waits.
function getClient() {
  if (!REDIS_URL) {
    return null;
  }
  if (client) {
    return client;
  }
  try {
    client = new Redis(REDIS_URL, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      // Reconnect with capped backoff; ioredis keeps trying in the background
      // while individual commands fail fast.
      retryStrategy(times) {
        return Math.min(times * 200, 5000);
      },
    });
    // 'error' must have a listener or ioredis throws on the process; we only
    // surface it once and keep the client alive for background reconnects.
    client.on('error', (err) => warnOnce('connection error', err));
  } catch (err) {
    warnOnce('failed to initialize', err);
    client = null;
  }
  return client;
}

export function isRedisEnabled() {
  return Boolean(REDIS_URL);
}

// Is the client currently usable? ioredis exposes status; 'ready' means connected
// and authenticated. We treat anything else as a miss so we don't wait on connect.
function isReady() {
  const c = getClient();
  return Boolean(c && c.status === 'ready');
}

export async function redisGet(key) {
  if (!isReady()) {
    return null;
  }
  try {
    return await getClient().get(key);
  } catch (err) {
    warnOnce('GET failed', err);
    return null;
  }
}

export async function redisSet(key, value, ttlSeconds) {
  if (!isReady()) {
    return false;
  }
  try {
    if (ttlSeconds && ttlSeconds > 0) {
      await getClient().set(key, value, 'EX', Math.floor(ttlSeconds));
    } else {
      await getClient().set(key, value);
    }
    return true;
  } catch (err) {
    warnOnce('SET failed', err);
    return false;
  }
}

export async function redisDel(...keys) {
  if (!isReady() || keys.length === 0) {
    return false;
  }
  try {
    await getClient().del(...keys);
    return true;
  } catch (err) {
    warnOnce('DEL failed', err);
    return false;
  }
}

// Atomic increment with a TTL applied on first creation — the shared building
// block for the login rate limiter across multiple web instances. Returns the
// new counter value, or null on any miss so the caller can fall back.
export async function redisIncrWithTtl(key, ttlSeconds) {
  if (!isReady()) {
    return null;
  }
  try {
    const c = getClient();
    const count = await c.incr(key);
    if (count === 1 && ttlSeconds > 0) {
      await c.expire(key, Math.floor(ttlSeconds));
    }
    return count;
  } catch (err) {
    warnOnce('INCR failed', err);
    return null;
  }
}

// Remaining TTL (seconds) for a key, or null on miss / no expiry.
export async function redisTtl(key) {
  if (!isReady()) {
    return null;
  }
  try {
    const ttl = await getClient().ttl(key);
    return ttl >= 0 ? ttl : null;
  } catch (err) {
    warnOnce('TTL failed', err);
    return null;
  }
}

// Read every field of a hash as a plain object, or null on miss. Used by the live
// telemetry overlay (one hash per printer).
export async function redisHGetAll(key) {
  if (!isReady()) {
    return null;
  }
  try {
    const out = await getClient().hgetall(key);
    return out && Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    warnOnce('HGETALL failed', err);
    return null;
  }
}
