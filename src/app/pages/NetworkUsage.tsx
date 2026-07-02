import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw, Wifi, Gauge, CalendarDays, ArrowDown, ArrowUp } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { toast } from 'sonner';
import {
  fetchNetworkUsage,
  fetchNetworkUsageLive,
  routeLabel,
  type NetworkUsageLiveSample,
  type NetworkUsageResponse,
  type PollerShardTraffic,
} from '../lib/networkUsageApi';
import { formatBytes, formatBytesPerSecond, formatMaxTwoDecimals } from '../lib/numberFormat';
import { useAutoRefresh } from '../lib/useAutoRefresh';

// How often the live bytes/sec rate is sampled. Cheap (in-memory, no DB
// query) on the server, so a short interval is fine.
const LIVE_POLL_MS = 2_000;

// Out (server -> client, e.g. webcam/API responses) and In (client -> server,
// e.g. print-request/slicer uploads) get distinct, fixed colors throughout —
// out is by far the larger number for this app, so it keeps the primary blue
// used elsewhere in the dashboard's charts; in gets a secondary color.
const COLOR_OUT = '#3b82f6';
const COLOR_IN = '#22c55e';

function formatShortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

const EMPTY: NetworkUsageResponse = {
  today: { bytesOut: 0, bytesIn: 0, requests: 0 },
  monthToDate: { bytesOut: 0, bytesIn: 0, requests: 0 },
  daily: [],
  byRoute: [],
  poller: [],
  processStartedAt: new Date().toISOString(),
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function LiveRateCard({ rateOut, rateIn }: { rateOut: number | null; rateIn: number | null }) {
  return (
    <Card className="p-4 dark:bg-gray-800 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-green-500" />
          </span>
          <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
            Live — current overall throughput
          </span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <ArrowUp className="size-4" style={{ color: COLOR_OUT }} />
            <span className="text-xl font-bold tabular-nums dark:text-white">
              {rateOut === null ? '—' : formatBytesPerSecond(rateOut)}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">out</span>
          </div>
          <div className="flex items-center gap-2">
            <ArrowDown className="size-4" style={{ color: COLOR_IN }} />
            <span className="text-xl font-bold tabular-nums dark:text-white">
              {rateIn === null ? '—' : formatBytesPerSecond(rateIn)}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">in</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function OutInLine({ bytesOut, bytesIn }: { bytesOut: number; bytesIn: number }) {
  return (
    <div className="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
      <div className="flex items-center gap-1">
        <ArrowUp className="size-3" style={{ color: COLOR_OUT }} />
        <span>{formatBytes(bytesOut)} out</span>
      </div>
      <div className="flex items-center gap-1">
        <ArrowDown className="size-3" style={{ color: COLOR_IN }} />
        <span>{formatBytes(bytesIn)} in</span>
      </div>
    </div>
  );
}

export function NetworkUsage() {
  const [data, setData] = useState<NetworkUsageResponse>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  // Separate from isLoading (which only ever fires for the very first mount,
  // matching the Logs page convention) so a manual click always gives visible
  // spinner/disabled feedback, even though the periodic auto-refresh doesn't.
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Briefly true right after a successful load, to flash the stat tiles —
  // otherwise a refresh that returns unchanged numbers (likely, since the
  // server only flushes traffic totals once a minute) looks like nothing
  // happened at all.
  const [justUpdated, setJustUpdated] = useState(false);
  const hasData = useRef(false);
  const flashTimerRef = useRef<number | undefined>(undefined);

  // Live bytes/sec rate: two cumulative-counter samples diffed over the
  // elapsed wall-clock time between them, polled independently of (and much
  // more often than) the historical data above.
  const [liveRateOut, setLiveRateOut] = useState<number | null>(null);
  const [liveRateIn, setLiveRateIn] = useState<number | null>(null);
  const lastLiveSampleRef = useRef<NetworkUsageLiveSample | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchNetworkUsage();
      setData(next);
      hasData.current = true;
      window.clearTimeout(flashTimerRef.current);
      setJustUpdated(true);
      flashTimerRef.current = window.setTimeout(() => setJustUpdated(false), 500);
    } catch {
      if (!hasData.current) {
        toast.error('Unable to load network usage. Check the server and database connection.');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useAutoRefresh(load, 60_000);

  const loadLive = useCallback(async () => {
    try {
      const sample = await fetchNetworkUsageLive();
      const previous = lastLiveSampleRef.current;
      if (previous) {
        const elapsedSeconds = (sample.timestamp - previous.timestamp) / 1000;
        // A counter smaller than the last sample means the process restarted
        // between polls — clamp to 0 for this one tick rather than showing a
        // negative rate; the next tick resumes normally.
        if (elapsedSeconds > 0) {
          setLiveRateOut(Math.max(0, sample.bytesOut - previous.bytesOut) / elapsedSeconds);
          setLiveRateIn(Math.max(0, sample.bytesIn - previous.bytesIn) / elapsedSeconds);
        }
      }
      lastLiveSampleRef.current = sample;
    } catch {
      // Silent — the main 60s load() already surfaces a connectivity toast;
      // a live-rate hiccup every 2s shouldn't spam another one.
    }
  }, []);

  useAutoRefresh(loadLive, LIVE_POLL_MS);

  useEffect(() => {
    return () => window.clearTimeout(flashTimerRef.current);
  }, []);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await load();
    } finally {
      setIsRefreshing(false);
    }
  }, [load]);

  const daysElapsedThisMonth = (() => {
    const now = new Date();
    return now.getDate();
  })();
  const dailyAverageOut = data.monthToDate.bytesOut / Math.max(1, daysElapsedThisMonth);
  const dailyAverageIn = data.monthToDate.bytesIn / Math.max(1, daysElapsedThisMonth);

  const totalRouteBytesOut = data.byRoute.reduce((acc, row) => acc + row.bytesOut, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 flex items-center gap-2 text-3xl font-bold dark:text-white">
            <Wifi className="size-7" />
            Network Usage
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Approximate app-layer traffic, split by direction — <strong>out</strong> is
            what the server sends (webcam snapshots, API responses, pages/assets);{' '}
            <strong>in</strong> is what it receives (print-request and slicer
            uploads). Measured at the web server, not including TLS/HTTP framing
            overhead or traffic that never reaches the app (e.g. the Prometheus UI
            proxied by nginx).
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleManualRefresh}
          disabled={isLoading || isRefreshing}
          className="transition-transform active:scale-95"
        >
          <RefreshCw
            className={`size-4 mr-2 transition-transform duration-500 ${
              isLoading || isRefreshing ? 'animate-spin' : ''
            }`}
          />
          Refresh
        </Button>
      </div>

      <LiveRateCard rateOut={liveRateOut} rateIn={liveRateIn} />

      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-3 transition-opacity duration-500 ${
          justUpdated ? 'opacity-60' : 'opacity-100'
        }`}
      >
        <Card className="h-full p-4 bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/80 dark:to-blue-800/80 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Today</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">
                {formatBytes(data.today.bytesOut + data.today.bytesIn)}
              </div>
              <OutInLine bytesOut={data.today.bytesOut} bytesIn={data.today.bytesIn} />
            </div>
            <Wifi className="size-8 text-blue-500" />
          </div>
        </Card>
        <Card className="h-full p-4 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/80 dark:to-purple-800/80 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">This month</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">
                {formatBytes(data.monthToDate.bytesOut + data.monthToDate.bytesIn)}
              </div>
              <OutInLine bytesOut={data.monthToDate.bytesOut} bytesIn={data.monthToDate.bytesIn} />
            </div>
            <CalendarDays className="size-8 text-purple-500" />
          </div>
        </Card>
        <Card className="h-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 dark:from-cyan-900/80 dark:to-cyan-800/80 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Daily average</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">
                {formatBytes(dailyAverageOut + dailyAverageIn)}
              </div>
              <OutInLine bytesOut={dailyAverageOut} bytesIn={dailyAverageIn} />
            </div>
            <Gauge className="size-8 text-cyan-500" />
          </div>
        </Card>
      </div>

      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <h2 className="text-xl font-semibold mb-4 dark:text-white">Last 30 days</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.daily}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" tickFormatter={formatShortDate} minTickGap={24} />
              <YAxis tickFormatter={(value: number) => formatBytes(value)} width={80} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
                labelFormatter={(label: string) => formatShortDate(label)}
                formatter={(value: number, name: string) => [formatBytes(value), name]}
              />
              <Legend />
              <Bar dataKey="bytesOut" fill={COLOR_OUT} name="Out" radius={[4, 4, 0, 0]} />
              <Bar dataKey="bytesIn" fill={COLOR_IN} name="In" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-4 space-y-4 dark:bg-gray-800 dark:border-gray-700">
        <h2 className="text-xl font-semibold dark:text-white">By category — last 30 days</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>In</TableHead>
              <TableHead>Share (out)</TableHead>
              <TableHead>Requests</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byRoute.map((row) => (
              <TableRow key={row.route}>
                <TableCell className="font-medium dark:text-gray-200">{routeLabel(row.route)}</TableCell>
                <TableCell className="dark:text-gray-200">{formatBytes(row.bytesOut)}</TableCell>
                <TableCell className="dark:text-gray-200">{formatBytes(row.bytesIn)}</TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400">
                  {totalRouteBytesOut > 0
                    ? formatMaxTwoDecimals((row.bytesOut / totalRouteBytesOut) * 100)
                    : '0'}
                  %
                </TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400">
                  {formatMaxTwoDecimals(row.requests)}
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && data.byRoute.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-gray-500 dark:text-gray-400">
                  No traffic recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-4 space-y-4 dark:bg-gray-800 dark:border-gray-700">
        <div>
          <h2 className="text-xl font-semibold dark:text-white">Poller ↔ printers</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            A separate traffic source: the poller talking directly to the printers
            (HTTP, Bambu MQTT/FTP) — not browser/client traffic. Shown per shard,
            last poll cycle only (no history).
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shard</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Printers polled</TableHead>
              <TableHead>Cycle time</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>In</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.poller.map((shard: PollerShardTraffic) => (
              <TableRow key={shard.shard}>
                <TableCell className="font-medium dark:text-gray-200">
                  {shard.shard + 1} / {shard.shardCount}
                </TableCell>
                <TableCell className="whitespace-nowrap text-gray-600 dark:text-gray-400">
                  {formatDateTime(shard.lastRunAt)}
                </TableCell>
                <TableCell className="dark:text-gray-200">{shard.printersPolled}</TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400">
                  {formatMaxTwoDecimals(shard.cycleDurationMs / 1000)}s
                </TableCell>
                <TableCell className="dark:text-gray-200">{formatBytes(shard.bytesOut)}</TableCell>
                <TableCell className="dark:text-gray-200">{formatBytes(shard.bytesIn)}</TableCell>
              </TableRow>
            ))}
            {!isLoading && data.poller.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-gray-500 dark:text-gray-400">
                  No poller activity recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
