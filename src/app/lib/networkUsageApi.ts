// Client for GET /api/network-usage — an admin-only, approximate breakdown of
// app-layer response traffic (see server/metrics.js + the network_usage_daily
// table) backing the Network page. "Approximate" because it's Node counting
// response chunk bytes, not TLS/HTTP framing or nginx-only paths.

export interface NetworkUsageTotal {
  bytesOut: number;
  bytesIn: number;
  requests: number;
}

export interface NetworkUsageDailyPoint {
  date: string;
  bytesOut: number;
  bytesIn: number;
  requests: number;
}

export interface NetworkUsageByRoute {
  route: string;
  bytesOut: number;
  bytesIn: number;
  requests: number;
}

// The poller's own traffic to/from the printers themselves (HTTP/MQTT/FTP) —
// a separate source from everything above, which is the web tier's traffic to
// browsers/clients. Only the latest cycle per shard is kept (poller_health
// has no history), so there's no daily series for this one.
export interface PollerShardTraffic {
  shard: number;
  shardCount: number;
  lastRunAt: string;
  cycleDurationMs: number;
  printersPolled: number;
  rowsWritten: number;
  refreshFailures: number;
  bytesOut: number;
  bytesIn: number;
}

export interface NetworkUsageResponse {
  today: NetworkUsageTotal;
  monthToDate: NetworkUsageTotal;
  daily: NetworkUsageDailyPoint[];
  byRoute: NetworkUsageByRoute[];
  poller: PollerShardTraffic[];
  processStartedAt: string;
}

export async function fetchNetworkUsage(): Promise<NetworkUsageResponse> {
  const response = await fetch('/api/network-usage', {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<NetworkUsageResponse>;
}

// Cumulative-since-process-start totals, sampled cheaply (no DB query) so it's
// safe to poll every couple of seconds. The caller diffs two samples over the
// elapsed wall-clock time to derive a live bytes/sec rate.
export interface NetworkUsageLiveSample {
  bytesOut: number;
  bytesIn: number;
  timestamp: number;
}

export async function fetchNetworkUsageLive(): Promise<NetworkUsageLiveSample> {
  const response = await fetch('/api/network-usage/live', {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<NetworkUsageLiveSample>;
}

// Friendly labels for the low-cardinality route classes emitted by
// classifyRoute() in server/metrics.js. Unknown routes fall back to the raw
// value so a newly added route still renders something sensible.
const ROUTE_LABELS: Record<string, string> = {
  webcam: 'Webcam snapshots/streams',
  printer_proxy: 'Printer hardware proxy',
  api_v1: 'API (/api/v1)',
  api_printers: 'Printers API',
  api_queue: 'Queue API',
  api_analytics: 'Analytics API',
  api_notifications: 'Notifications API',
  api_maintenance: 'Maintenance API',
  api_settings: 'Settings API',
  api_users: 'Users API',
  api_auth: 'Auth API',
  'api_audit-logs': 'Audit log API',
  api_admin: 'Admin API',
  api_version: 'Version check API',
  'api_network-usage': 'Network usage API',
  api_other: 'Other API',
  static: 'Static assets (JS/CSS/images)',
  app: 'App shell (HTML)',
  healthz: 'Health check',
  readyz: 'Readiness check',
  metrics: 'Metrics endpoint',
};

export function routeLabel(route: string): string {
  return ROUTE_LABELS[route] ?? route;
}
