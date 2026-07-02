import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw, Wifi, Gauge, CalendarDays } from 'lucide-react';
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
  routeLabel,
  type NetworkUsageResponse,
} from '../lib/networkUsageApi';
import { formatBytes, formatMaxTwoDecimals } from '../lib/numberFormat';
import { useAutoRefresh } from '../lib/useAutoRefresh';

function formatShortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

const EMPTY: NetworkUsageResponse = {
  today: { bytes: 0, requests: 0 },
  monthToDate: { bytes: 0, requests: 0 },
  daily: [],
  byRoute: [],
  processStartedAt: new Date().toISOString(),
};

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
  const dailyAverageBytes = data.monthToDate.bytes / Math.max(1, daysElapsedThisMonth);

  const totalRouteBytes = data.byRoute.reduce((acc, row) => acc + row.bytes, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 flex items-center gap-2 text-3xl font-bold dark:text-white">
            <Wifi className="size-7" />
            Network Usage
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Approximate app-layer response traffic, by category — measured at the
            web server, not including TLS/HTTP framing overhead or traffic that
            never reaches the app (e.g. the Prometheus UI proxied by nginx).
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
                {formatBytes(data.today.bytes)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {formatMaxTwoDecimals(data.today.requests)} requests
              </div>
            </div>
            <Wifi className="size-8 text-blue-500" />
          </div>
        </Card>
        <Card className="h-full p-4 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/80 dark:to-purple-800/80 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">This month</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">
                {formatBytes(data.monthToDate.bytes)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {formatMaxTwoDecimals(data.monthToDate.requests)} requests
              </div>
            </div>
            <CalendarDays className="size-8 text-purple-500" />
          </div>
        </Card>
        <Card className="h-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 dark:from-cyan-900/80 dark:to-cyan-800/80 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Daily average</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">
                {formatBytes(dailyAverageBytes)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">This month so far</div>
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
                formatter={(value: number) => [formatBytes(value), 'Traffic']}
              />
              <Bar dataKey="bytes" fill="#3b82f6" name="Traffic" radius={[4, 4, 0, 0]} />
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
              <TableHead>Traffic</TableHead>
              <TableHead>Share</TableHead>
              <TableHead>Requests</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byRoute.map((row) => (
              <TableRow key={row.route}>
                <TableCell className="font-medium dark:text-gray-200">{routeLabel(row.route)}</TableCell>
                <TableCell className="dark:text-gray-200">{formatBytes(row.bytes)}</TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400">
                  {totalRouteBytes > 0
                    ? formatMaxTwoDecimals((row.bytes / totalRouteBytes) * 100)
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
                <TableCell colSpan={4} className="py-8 text-center text-gray-500 dark:text-gray-400">
                  No traffic recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
