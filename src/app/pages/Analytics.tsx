import { useEffect, useState } from 'react';
import { mockAnalytics, mockPrinters } from '../data/mockData';
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
import { TrendingUp, Package, Clock, CheckCircle } from 'lucide-react';
import { Printer } from '../types';
import { fetchPrinters } from '../lib/printersApi';
import { normalizePrinter } from '../lib/printerProfiles';
import { Button } from '../components/ui/button';
import { useAuth } from '../contexts/AuthContext';

export function Analytics() {
  const { user } = useAuth();
  const [printers, setPrinters] = useState<Printer[]>(mockPrinters.map(normalizePrinter));
  const [analyticsData, setAnalyticsData] = useState(mockAnalytics);
  const [resetInFlight, setResetInFlight] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const refreshAnalytics = async () => {
      try {
        const response = await fetch('/api/analytics/daily', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Analytics request failed with ${response.status}`);
        }

        const payload = await response.json();
        if (!isCancelled && Array.isArray(payload)) {
          setAnalyticsData(payload);
        }
      } catch {
        if (!isCancelled) {
          setAnalyticsData(mockAnalytics);
        }
      }
    };

    refreshAnalytics();
    const interval = window.setInterval(refreshAnalytics, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    const refreshFromServer = async () => {
      try {
        const nextPrinters = (await fetchPrinters()).map(normalizePrinter);
        if (!isCancelled) {
          setPrinters(nextPrinters);
        }
      } catch {
        // Leave the last good snapshot on screen if the refresh fails.
      }
    };

    refreshFromServer();
    const interval = window.setInterval(refreshFromServer, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const totalJobs = analyticsData.reduce(
    (acc, day) => acc + day.completedJobs + day.failedJobs,
    0
  );
  const completedJobs = analyticsData.reduce((acc, day) => acc + day.completedJobs, 0);
  const totalPrintTime = analyticsData.reduce((acc, day) => acc + day.printTime, 0);
  const totalFilament = analyticsData.reduce((acc, day) => acc + day.filamentUsed, 0);

  const successRate = totalJobs > 0 ? ((completedJobs / totalJobs) * 100).toFixed(1) : '0.0';

  const statusData = [
    { name: 'Printing', value: printers.filter((p) => p.status === 'printing').length },
    { name: 'Idle', value: printers.filter((p) => p.status === 'idle').length },
    { name: 'Paused', value: printers.filter((p) => p.status === 'paused').length },
    { name: 'Error', value: printers.filter((p) => p.status === 'error').length },
    { name: 'Offline', value: printers.filter((p) => p.status === 'offline').length },
  ].filter((status) => status.value > 0);

  const COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#6b7280'];

  const printerUtilization = printers.map((p) => ({
    name: p.name.split(' ')[0] + ' ' + p.name.split('#')[1],
    hours: p.totalPrintTime,
    success: p.successRate,
  }));

  const handleResetAnalytics = async () => {
    if (user?.role !== 'admin' || resetInFlight) {
      return;
    }

    setResetInFlight(true);

    try {
      const response = await fetch('/api/analytics/daily/reset', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Reset failed with ${response.status}`);
      }

      const refreshed = await fetch('/api/analytics/daily', { cache: 'no-store' });
      if (!refreshed.ok) {
        throw new Error(`Analytics refresh failed with ${refreshed.status}`);
      }

      const payload = await refreshed.json();
      if (Array.isArray(payload)) {
        setAnalyticsData(payload);
      }
    } finally {
      setResetInFlight(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 dark:text-white">Analytics</h1>
          <p className="text-gray-600 dark:text-gray-400">Performance insights and statistics</p>
        </div>
        {user?.role === 'admin' && (
          <Button
            type="button"
            variant="destructive"
            onClick={handleResetAnalytics}
            disabled={resetInFlight}
          >
            {resetInFlight ? 'Resetting...' : 'Set Zero'}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/30 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Total Jobs</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">{totalJobs}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Last 7 days</div>
            </div>
            <TrendingUp className="size-8 text-blue-500" />
          </div>
        </Card>

        <Card className="p-4 bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/30 dark:to-green-800/30 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Success Rate</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">{successRate}%</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {completedJobs} completed
              </div>
            </div>
            <CheckCircle className="size-8 text-green-500" />
          </div>
        </Card>

        <Card className="p-4 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/30 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Print Time</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">{totalPrintTime}h</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Last 7 days</div>
            </div>
            <Clock className="size-8 text-purple-500" />
          </div>
        </Card>

        <Card className="p-4 bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/30 dark:to-orange-800/30 border-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Filament Used</div>
              <div className="text-3xl font-bold mt-1 dark:text-white">{(totalFilament / 1000).toFixed(1)}kg</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Last 7 days</div>
            </div>
            <Package className="size-8 text-orange-500" />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 dark:text-white">Daily Performance</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={analyticsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
              <XAxis dataKey="date" tickFormatter={(value) => value.split('-')[2]} className="text-gray-600 dark:text-gray-400" />
              <YAxis className="text-gray-600 dark:text-gray-400" />
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
        </Card>

        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 dark:text-white">Current Status</h2>
          <ResponsiveContainer width="100%" height={300}>
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
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 dark:text-white">Printer Utilization (Hours)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={printerUtilization}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
              <XAxis dataKey="name" className="text-gray-600 dark:text-gray-400" />
              <YAxis className="text-gray-600 dark:text-gray-400" />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }} />
              <Legend />
              <Bar dataKey="hours" fill="#3b82f6" name="Total Hours" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 dark:text-white">Filament Usage (g)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={analyticsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
              <XAxis dataKey="date" tickFormatter={(value) => value.split('-')[2]} className="text-gray-600 dark:text-gray-400" />
              <YAxis className="text-gray-600 dark:text-gray-400" />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }} />
              <Legend />
              <Bar dataKey="filamentUsed" fill="#f97316" name="Filament (g)" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}
