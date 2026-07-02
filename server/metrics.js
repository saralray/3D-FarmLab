// In-process Prometheus metrics for the web tier, exposed at GET /metrics (kept
// internal — nginx returns 404 for it, and Prometheus scrapes web:5173 directly
// over the compose network). Hand-rolled rather than pulling in a client library
// so it stays dependency-free and auditable; the exposition format is the simple
// Prometheus text format. The exporter service covers print-farm DATA metrics
// from Postgres; this covers the web server's own HTTP request behavior, which
// only the process itself can see.
//
// Cardinality is kept deliberately low: HTTP requests are labelled by a small
// fixed set of route classes (see classifyRoute), the request method, and the
// status code — never the raw path (which carries ids), so the series count
// stays bounded no matter how many printers/jobs exist.

const PROCESS_START_SECONDS = Date.now() / 1000;

// Histogram buckets in seconds — typical web latencies from a few ms up to 10s.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// requests_total counter, keyed by "method|status|route".
const requestCounts = new Map();
// duration histogram, keyed by route -> { buckets:number[], sum, count }.
const durationByRoute = new Map();
// Response bytes and request counts, keyed by route only (coarser than
// requestCounts — this feeds both /metrics and the network-usage page's
// periodic DB flush, neither of which needs the method/status breakdown).
const bytesByRoute = new Map();
// Inbound (request body) bytes, by route. Recorded from the actual bytes read
// off each request (see the req.emit wrapper in app.js's handleRequest) —
// exact for whatever the body parser actually consumes; a body no handler
// ever reads (shouldn't happen for a well-behaved route) wouldn't be seen.
const bytesInByRoute = new Map();
const requestsByRoute = new Map();
let inFlight = 0;

// Live overall (all routes combined) bytes/sec, sampled every 2s by diffing
// the cumulative counters above over the elapsed wall-clock time — the same
// "diff two samples" approach GET /api/network-usage/live uses for the
// Network Usage page's Live card, just computed here so it's directly
// queryable as a Prometheus gauge (printfarm_web_bytes_out_live /
// printfarm_web_bytes_in_live) instead of requiring rate()/irate() in PromQL.
const LIVE_SAMPLE_INTERVAL_MS = 2000;
let liveBytesOutPerSec = 0;
let liveBytesInPerSec = 0;
let lastLiveSample = null;

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}

function sampleLiveRates() {
  const bytesOut = sumMapValues(bytesByRoute);
  const bytesIn = sumMapValues(bytesInByRoute);
  const timestamp = Date.now();
  if (lastLiveSample) {
    const elapsedSeconds = (timestamp - lastLiveSample.timestamp) / 1000;
    // A counter smaller than the last sample means bytesByRoute/bytesInByRoute
    // reset (process restart) — clamp to 0 for this one tick rather than a
    // negative rate; the next tick resumes normally.
    if (elapsedSeconds > 0) {
      liveBytesOutPerSec = Math.max(0, bytesOut - lastLiveSample.bytesOut) / elapsedSeconds;
      liveBytesInPerSec = Math.max(0, bytesIn - lastLiveSample.bytesIn) / elapsedSeconds;
    }
  }
  lastLiveSample = { bytesOut, bytesIn, timestamp };
}

setInterval(sampleLiveRates, LIVE_SAMPLE_INTERVAL_MS).unref();

// Collapse a request path to a low-cardinality route label. The resource segment
// of /api/<resource>/... is a bounded vocabulary (printers, queue, auth, ...),
// so it is safe to keep; ids deeper in the path are dropped.
export function classifyRoute(pathname) {
  if (pathname === '/healthz' || pathname === '/readyz' || pathname === '/metrics') {
    return pathname.slice(1);
  }
  if (pathname.startsWith('/api/v1')) {
    return 'api_v1';
  }
  if (pathname.startsWith('/__printer_proxy')) {
    return 'printer_proxy';
  }
  if (pathname.startsWith('/__printer_webcam') || pathname.startsWith('/webcam')) {
    return 'webcam';
  }
  if (pathname.startsWith('/api/')) {
    const resource = pathname.split('/')[2] || 'root';
    // Guard against an unexpectedly id-like segment so cardinality stays bounded.
    return /^[a-z][a-z0-9-]{0,30}$/i.test(resource) ? `api_${resource}` : 'api_other';
  }
  if (/\.[a-z0-9]{1,8}$/i.test(pathname)) {
    return 'static';
  }
  return 'app';
}

function normalizeMethod(method) {
  const upper = (method || 'GET').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

export function recordRequestStart() {
  inFlight += 1;
}

export function recordRequestEnd(method, statusCode, route, durationMs) {
  if (inFlight > 0) {
    inFlight -= 1;
  }

  const status = Number.isFinite(statusCode) ? String(statusCode) : '0';
  const key = `${normalizeMethod(method)}|${status}|${route}`;
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  requestsByRoute.set(route, (requestsByRoute.get(route) || 0) + 1);

  let hist = durationByRoute.get(route);
  if (!hist) {
    hist = { buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
    durationByRoute.set(route, hist);
  }
  const seconds = Math.max(0, durationMs) / 1000;
  hist.sum += seconds;
  hist.count += 1;
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (seconds <= DURATION_BUCKETS[i]) {
      hist.buckets[i] += 1;
    }
  }
}

// Called incrementally as each response chunk is written (rather than once at
// the end), so a long-lived stream — the webcam MJPEG feed above all — is
// reflected in near-real time instead of only when the connection eventually
// closes.
export function recordResponseBytes(route, bytes) {
  if (!bytes) {
    return;
  }
  bytesByRoute.set(route, (bytesByRoute.get(route) || 0) + bytes);
}

// Called incrementally as each actual request-body chunk is observed (see the
// req.emit wrapper in app.js's handleRequest).
export function recordRequestBytes(route, bytes) {
  if (!bytes) {
    return;
  }
  bytesInByRoute.set(route, (bytesInByRoute.get(route) || 0) + bytes);
}

// Cumulative-since-process-start snapshots, consumed by the network-usage
// flush worker (server/app.js) to compute deltas for persistence. Returned as
// plain objects so the caller can't mutate the live maps.
export function snapshotBytesByRoute() {
  return Object.fromEntries(bytesByRoute);
}
export function snapshotBytesInByRoute() {
  return Object.fromEntries(bytesInByRoute);
}
export function snapshotRequestsByRoute() {
  return Object.fromEntries(requestsByRoute);
}

export function getProcessStartSeconds() {
  return PROCESS_START_SECONDS;
}

// Render the current metrics in Prometheus text exposition format.
export function renderMetrics() {
  const lines = [];

  lines.push('# HELP printfarm_web_http_requests_total Total HTTP requests handled by the web server.');
  lines.push('# TYPE printfarm_web_http_requests_total counter');
  for (const [key, value] of requestCounts) {
    const [method, status, route] = key.split('|');
    lines.push(
      `printfarm_web_http_requests_total{method="${method}",status="${status}",route="${route}"} ${value}`,
    );
  }

  lines.push('# HELP printfarm_web_http_request_duration_seconds HTTP request latency by route.');
  lines.push('# TYPE printfarm_web_http_request_duration_seconds histogram');
  for (const [route, hist] of durationByRoute) {
    let cumulative = 0;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      cumulative = hist.buckets[i];
      lines.push(
        `printfarm_web_http_request_duration_seconds_bucket{route="${route}",le="${DURATION_BUCKETS[i]}"} ${cumulative}`,
      );
    }
    lines.push(
      `printfarm_web_http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${hist.count}`,
    );
    lines.push(`printfarm_web_http_request_duration_seconds_sum{route="${route}"} ${hist.sum}`);
    lines.push(`printfarm_web_http_request_duration_seconds_count{route="${route}"} ${hist.count}`);
  }

  lines.push('# HELP printfarm_web_response_bytes_total Total response (outbound) bytes served, by route.');
  lines.push('# TYPE printfarm_web_response_bytes_total counter');
  for (const [route, bytes] of bytesByRoute) {
    lines.push(`printfarm_web_response_bytes_total{route="${route}"} ${bytes}`);
  }

  lines.push('# HELP printfarm_web_request_bytes_total Total request (inbound) bytes received, by route.');
  lines.push('# TYPE printfarm_web_request_bytes_total counter');
  for (const [route, bytes] of bytesInByRoute) {
    lines.push(`printfarm_web_request_bytes_total{route="${route}"} ${bytes}`);
  }

  lines.push('# HELP printfarm_web_bytes_out_live Live overall outbound bytes/sec (all routes combined), sampled every 2s.');
  lines.push('# TYPE printfarm_web_bytes_out_live gauge');
  lines.push(`printfarm_web_bytes_out_live ${liveBytesOutPerSec}`);

  lines.push('# HELP printfarm_web_bytes_in_live Live overall inbound bytes/sec (all routes combined), sampled every 2s.');
  lines.push('# TYPE printfarm_web_bytes_in_live gauge');
  lines.push(`printfarm_web_bytes_in_live ${liveBytesInPerSec}`);

  lines.push('# HELP printfarm_web_http_requests_in_flight HTTP requests currently being served.');
  lines.push('# TYPE printfarm_web_http_requests_in_flight gauge');
  lines.push(`printfarm_web_http_requests_in_flight ${inFlight}`);

  lines.push('# HELP printfarm_web_start_time_seconds Unix time the web process started.');
  lines.push('# TYPE printfarm_web_start_time_seconds gauge');
  lines.push(`printfarm_web_start_time_seconds ${PROCESS_START_SECONDS}`);

  lines.push('# HELP printfarm_web_resident_memory_bytes Resident set size of the web process.');
  lines.push('# TYPE printfarm_web_resident_memory_bytes gauge');
  lines.push(`printfarm_web_resident_memory_bytes ${process.memoryUsage().rss}`);

  return `${lines.join('\n')}\n`;
}
