import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Card } from '../components/ui/card';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, Package, Clock, CheckCircle, Timer, LayoutGrid, Check } from 'lucide-react';
import { AnalyticsData } from '../types';
import { usePrinters } from '../contexts/PrintersContext';
import { Button } from '../components/ui/button';
import { useAuth } from '../contexts/AuthContext';
import { formatMaxTwoDecimals, roundToMaxTwoDecimals } from '../lib/numberFormat';
import { AnalyticsCardGrid } from '../components/AnalyticsCardGrid';
import {
  DEFAULT_ANALYTICS_LAYOUT,
  fetchAnalyticsLayout,
  normalizeAnalyticsLayout,
  saveAnalyticsLayout,
  type AnalyticsCardId,
  type AnalyticsLayout,
} from '../lib/analyticsLayoutApi';
import { useAutoRefresh } from '../lib/useAutoRefresh';

export function Analytics() {
  const { user } = useAuth();
  const { printers } = usePrinters();
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData[]>([]);
  const [layout, setLayout] = useState<AnalyticsLayout>(DEFAULT_ANALYTICS_LAYOUT);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  const refreshAnalytics = useCallback(async () => {
    try {
      const response = await fetch('/api/analytics/daily', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Analytics request failed with ${response.status}`);
      }
      const payload = await response.json();
      if (Array.isArray(payload)) setAnalyticsData(payload);
    } catch {
      // Leave the last good snapshot on screen if the refresh fails.
    }
  }, []);

  useAutoRefresh(refreshAnalytics, 10_000);

  useEffect(() => {
    let isCancelled = false;

    fetchAnalyticsLayout()
      .then((next) => {
        if (!isCancelled) {
          setLayout(next);
        }
      })
      .catch(() => {
        // Fall back to the default layout if the saved one can't be loaded.
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  const totalJobs = analyticsData.reduce(
    (acc, day) => acc + day.completedJobs + day.failedJobs,
    0
  );
  const completedJobs = analyticsData.reduce((acc, day) => acc + day.completedJobs, 0);
  const totalPrintTime = roundToMaxTwoDecimals(
    analyticsData.reduce((acc, day) => acc + day.printTime, 0)
  );
  const totalFilament = roundToMaxTwoDecimals(
    analyticsData.reduce((acc, day) => acc + day.filamentUsed, 0)
  );

  const successRate = totalJobs > 0 ? formatMaxTwoDecimals((completedJobs / totalJobs) * 100) : '0';

  const avgPrintTime = completedJobs > 0 ? roundToMaxTwoDecimals(totalPrintTime / completedJobs) : 0;

  const statusData = [
    { name: 'Printing', value: printers.filter((p) => p.status === 'printing').length },
    { name: 'Idle', value: printers.filter((p) => p.status === 'idle').length },
    { name: 'Paused', value: printers.filter((p) => p.status === 'paused').length },
    { name: 'Error', value: printers.filter((p) => p.status === 'error').length },
    { name: 'Offline', value: printers.filter((p) => p.status === 'offline').length },
  ].filter((status) => status.value > 0);

  const COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#6b7280'];

  const handleCommitLayout = (next: AnalyticsLayout) => {
    // Reconcile to the full card set before saving so a partial/empty layout
    // from the grid can never blank the page or drop a card.
    const reconciled = normalizeAnalyticsLayout(next);
    setLayout(reconciled);
    setLayoutError(null);
    saveAnalyticsLayout(reconciled).catch((error) => {
      setLayoutError(error instanceof Error ? error.message : 'Unable to save layout');
    });
  };

  const handleResetLayout = () => {
    handleCommitLayout(DEFAULT_ANALYTICS_LAYOUT);
  };

  const cards: Record<AnalyticsCardId, ReactNode> = {
    totalJobs: (
      <Card className="h-full p-4 bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/80 dark:to-blue-800/80 border-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Total Jobs</div>
            <div className="text-3xl font-bold mt-1 text-foreground">{totalJobs}</div>
            <div className="text-xs text-muted-foreground mt-1">Last 7 days</div>
          </div>
          <TrendingUp className="size-8 text-blue-500" />
        </div>
      </Card>
    ),
    successRate: (
      <Card className="h-full p-4 bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/80 dark:to-green-800/80 border-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Success Rate</div>
            <div className="text-3xl font-bold mt-1 text-foreground">{successRate}%</div>
            <div className="text-xs text-muted-foreground mt-1">
              {completedJobs} completed
            </div>
          </div>
          <CheckCircle className="size-8 text-green-500" />
        </div>
      </Card>
    ),
    printTime: (
      <Card className="h-full p-4 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/80 dark:to-purple-800/80 border-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Print Time</div>
            <div className="text-3xl font-bold mt-1 text-foreground">
              {formatMaxTwoDecimals(totalPrintTime)}h
            </div>
            <div className="text-xs text-muted-foreground mt-1">Last 7 days</div>
          </div>
          <Clock className="size-8 text-purple-500" />
        </div>
      </Card>
    ),
    avgPrintTime: (
      <Card className="h-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 dark:from-cyan-900/80 dark:to-cyan-800/80 border-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Avg Print Time</div>
            <div className="text-3xl font-bold mt-1 text-foreground">
              {formatMaxTwoDecimals(avgPrintTime)}h
            </div>
            <div className="text-xs text-muted-foreground mt-1">Per completed job</div>
          </div>
          <Timer className="size-8 text-cyan-500" />
        </div>
      </Card>
    ),
    filamentUsed: (
      <Card className="h-full p-4 bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/80 dark:to-orange-800/80 border-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Filament Used</div>
            <div className="text-3xl font-bold mt-1 text-foreground">
              {formatMaxTwoDecimals(totalFilament / 1000)}kg
            </div>
            <div className="text-xs text-muted-foreground mt-1">Last 7 days</div>
          </div>
          <Package className="size-8 text-orange-500" />
        </div>
      </Card>
    ),
    dailyPerformance: (
      <Card className="flex h-full flex-col p-6">
        <h2 className="text-xl font-semibold mb-4 text-foreground">Daily Performance</h2>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={analyticsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tickFormatter={(value) => value.split('-')[2]} className="text-muted-foreground" />
              <YAxis className="text-muted-foreground" />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }} />
              <Legend />
              <Line
                type="monotone"
                dataKey="completedJobs"
                stroke="#22c55e"
                strokeWidth={2}
                name="Completed"
              />
              <Line
                type="monotone"
                dataKey="failedJobs"
                stroke="#ef4444"
                strokeWidth={2}
                name="Failed"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    ),
    currentStatus: (
      <Card className="flex h-full flex-col p-6">
        <h2 className="text-xl font-semibold mb-4 text-foreground">Current Status</h2>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={statusData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, value }) => `${name}: ${value}`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {statusData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </Card>
    ),
    printerUtilization: (
      <Card className="flex h-full flex-col p-6">
        <h2 className="text-xl font-semibold mb-4 text-foreground">Print Time (Hours)</h2>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analyticsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tickFormatter={(value) => value.split('-')[2]} className="text-muted-foreground" />
              <YAxis className="text-muted-foreground" />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
                formatter={(value: number) => [`${formatMaxTwoDecimals(value)} h`, 'Print Time']}
              />
              <Legend />
              <Bar dataKey="printTime" fill="#a855f7" name="Print Time (h)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    ),
    filamentUsage: (
      <Card className="flex h-full flex-col p-6">
        <h2 className="text-xl font-semibold mb-4 text-foreground">Filament Usage (g)</h2>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analyticsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tickFormatter={(value) => value.split('-')[2]} className="text-muted-foreground" />
              <YAxis className="text-muted-foreground" />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }} />
              <Legend />
              <Bar dataKey="filamentUsed" fill="#f97316" name="Filament (g)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    ),
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-foreground">Analytics</h1>
          <p className="text-muted-foreground">Performance insights and statistics</p>
        </div>
        {user?.role === 'admin' && (
          <div className="flex flex-wrap items-center gap-2">
            {isLayoutEditing && (
              <Button type="button" variant="ghost" size="sm" onClick={handleResetLayout}>
                Reset layout
              </Button>
            )}
            <Button
              type="button"
              variant={isLayoutEditing ? 'default' : 'outline'}
              size="sm"
              onClick={() => setIsLayoutEditing((value) => !value)}
            >
              {isLayoutEditing ? (
                <>
                  <Check className="size-4 mr-2" />
                  Done
                </>
              ) : (
                <>
                  <LayoutGrid className="size-4 mr-2" />
                  Edit layout
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {isLayoutEditing && (
        <p className="text-sm text-muted-foreground">
          Drag a card by its handle onto another card to switch their places, or drag the
          bottom-right corner to resize. Changes are shared with everyone and save automatically.
        </p>
      )}
      {layoutError && <p className="text-sm text-red-500">{layoutError}</p>}

      <AnalyticsCardGrid
        layout={layout}
        cards={cards}
        editable={isLayoutEditing && user?.role === 'admin'}
        onCommit={handleCommitLayout}
      />
    </div>
  );
}
