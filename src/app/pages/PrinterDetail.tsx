import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { mockPrinters } from '../data/mockData';
import { Printer } from '../types';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { Badge } from '../components/ui/badge';
import { SpoolIndicator } from '../components/SpoolIndicator';
import {
  ArrowLeft,
  Activity,
  Thermometer,
  Clock,
  KeyRound,
  Network,
  Wrench,
  Play,
  Pause,
  Square,
  CheckCircle,
  Palette,
} from 'lucide-react';
import { fetchPrinterLiveStatus, normalizePrinter } from '../lib/printerProfiles';
import { fetchPrinters } from '../lib/printersApi';

export function PrinterDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [printer, setPrinter] = useState<Printer | null>(null);

  useEffect(() => {
    fetchPrinters()
      .then((printers) => {
        setPrinter(printers.map(normalizePrinter).find((candidate) => candidate.id === id) || null);
      })
      .catch(() => {
        setPrinter(mockPrinters.find((candidate) => candidate.id === id) || null);
      });
  }, [id]);

  useEffect(() => {
    if (!printer || printer.profile === 'generic') {
      return;
    }

    let isCancelled = false;

    const pollPrinterStatus = async () => {
      try {
        const liveStatus = await fetchPrinterLiveStatus(printer);
        if (!isCancelled) {
          setPrinter((prev) => (prev ? { ...prev, ...liveStatus } : prev));
        }
      } catch {
        if (!isCancelled) {
          setPrinter((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'offline',
                  currentJob: undefined,
                  progress: 0,
                  temperature: { nozzle: 0, bed: 0 },
                }
              : prev
          );
        }
      }
    };

    pollPrinterStatus();
    const interval = window.setInterval(pollPrinterStatus, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [printer]);

  if (!printer) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">Printer not found</p>
          <Button onClick={() => navigate('/')} className="mt-4">
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  const getStatusColor = () => {
    switch (printer.status) {
      case 'printing':
        return 'text-blue-500';
      case 'idle':
        return 'text-green-500';
      case 'error':
        return 'text-red-500';
      case 'offline':
        return 'text-gray-500';
      case 'paused':
        return 'text-yellow-500';
    }
  };

  const nozzleTemperatures =
    printer.nozzleTemperatures && printer.nozzleTemperatures.length > 0
      ? printer.nozzleTemperatures
      : [printer.temperature.nozzle];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="size-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold dark:text-white">{printer.name}</h1>
          <p className="text-gray-600 dark:text-gray-400">{printer.model}</p>
        </div>
        <Badge className="text-base px-4 py-2 capitalize">{printer.status}</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Current Job */}
        <Card className="lg:col-span-2 p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
            <Activity className="size-5" />
            Current Job
          </h2>

          {printer.currentJob ? (
            <div className="space-y-4">
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">File</div>
                <div className="font-medium text-lg dark:text-white">{printer.currentJob.filename}</div>
              </div>

              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-gray-600 dark:text-gray-400">Progress</span>
                  <span className="font-medium dark:text-white">{printer.progress}%</span>
                </div>
                <Progress value={printer.progress} className="h-3" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Time Remaining</div>
                  <div className="font-medium flex items-center gap-1 dark:text-white">
                    <Clock className="size-4" />
                    {printer.currentJob.timeRemaining} min
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Estimated Total</div>
                  <div className="font-medium dark:text-white">{printer.currentJob.estimatedTime} min</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Filament Used</div>
                  <div className="font-medium dark:text-white">{printer.currentJob.filamentUsed}g</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Priority</div>
                  <Badge className="capitalize">{printer.currentJob.priority}</Badge>
                </div>
              </div>

              <div className="flex gap-2 pt-4">
                {printer.status === 'printing' && (
                  <>
                    <Button variant="outline" className="flex-1">
                      <Pause className="size-4 mr-2" />
                      Pause
                    </Button>
                    <Button variant="outline" className="flex-1">
                      <Square className="size-4 mr-2" />
                      Cancel
                    </Button>
                  </>
                )}
                {printer.status === 'paused' && (
                  <>
                    <Button className="flex-1">
                      <Play className="size-4 mr-2" />
                      Resume
                    </Button>
                    <Button variant="outline" className="flex-1">
                      <Square className="size-4 mr-2" />
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <CheckCircle className="size-12 mx-auto mb-3 opacity-50" />
              <p>No active job</p>
              <p className="text-sm mt-1">This printer is ready for new tasks</p>
            </div>
          )}
        </Card>

        {/* Printer Stats */}
        <div className="space-y-6">
          {printer.spools && (
            <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
                <Palette className="size-5" />
                Filament Spools
              </h2>
              <SpoolIndicator spools={printer.spools} />
            </Card>
          )}

          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
              <Thermometer className="size-5" />
              Temperature
            </h2>
            <div className="space-y-4">
              {nozzleTemperatures.map((temperature, index) => (
                <div key={`${printer.id}-detail-nozzle-${index}`}>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {nozzleTemperatures.length > 1 ? `Nozzle ${index + 1}` : 'Nozzle'}
                    </span>
                    <span className={`font-bold text-lg ${getStatusColor()}`}>
                      {temperature}°C
                    </span>
                  </div>
                  <Progress
                    value={(temperature / 250) * 100}
                    className="h-2"
                  />
                </div>
              ))}
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Bed</span>
                  <span className={`font-bold text-lg ${getStatusColor()}`}>
                    {printer.temperature.bed}°C
                  </span>
                </div>
                <Progress
                  value={(printer.temperature.bed / 100) * 100}
                  className="h-2"
                />
              </div>
            </div>
          </Card>

          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 dark:text-white">Information</h2>
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <Network className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">IP Address</div>
                  <div className="font-medium dark:text-white">{printer.ipAddress}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Activity className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Profile</div>
                  <div className="font-medium dark:text-white">{printer.profile}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <KeyRound className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">API Key Header</div>
                  <div className="font-medium dark:text-white">
                    {printer.apiKeyHeader ? 'Configured' : 'Not configured'}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Wrench className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Last Maintenance</div>
                  <div className="font-medium dark:text-white">{printer.lastMaintenance}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Clock className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Total Print Time</div>
                  <div className="font-medium dark:text-white">{printer.totalPrintTime}h</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Success Rate</div>
                  <div className="font-medium dark:text-white">{printer.successRate}%</div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
