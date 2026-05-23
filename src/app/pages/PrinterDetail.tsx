import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Printer } from '../types';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { Badge } from '../components/ui/badge';
import {
  ArrowLeft,
  Activity,
  Thermometer,
  Clock,
  KeyRound,
  Network,
  Trash2,
  Wrench,
  Play,
  Pause,
  Square,
  CheckCircle,
  Palette,
  Lightbulb,
  LayoutGrid,
  Check,
} from 'lucide-react';
import {
  buildPrinterWebcamSnapshotUrl,
  normalizePrinter,
  printerSupportsLight,
  sendPrinterCommand,
  setPrinterLight,
} from '../lib/printerProfiles';
import { fetchPrinters, removePrinter } from '../lib/printersApi';
import { useAuth } from '../contexts/AuthContext';
import { formatMaxTwoDecimals } from '../lib/numberFormat';
import { PrinterCardLayout } from '../components/PrinterCardLayout';
import {
  DEFAULT_CARD_LAYOUT,
  fetchCardLayout,
  saveCardLayout,
  type CardId,
  type CardLayout,
} from '../lib/cardLayoutApi';

interface PrinterTaskConfig {
  filament_vendor?: string[];
  filament_type?: string[];
  filament_sub_type?: string[];
  filament_color_rgba?: string[];
  filament_exist?: boolean[];
  extruders_used?: boolean[];
  auto_replenish_filament?: boolean;
}

interface FilamentSlot {
  slot: number;
  vendor: string;
  type: string;
  subType: string;
  color: string;
  isLoaded: boolean;
  isInUse: boolean;
}

function FilamentSpoolIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 256 500"
      width="28"
      height="40"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M202.1.3h-5v2.3C179 19 165 123.6 165 250s14 231.1 32.2 247.5v2.3h5c20.5 0 37.2-111.9 37.2-249.8S222.7.3 202.1.3"
        fill="#9b7242"
      />
      <path
        d="M197.1.3c20.5 0 37.2 111.9 37.2 249.8s-16.7 249.8-37.2 249.8S160 387.9 160 250 176.6.3 197.1.3"
        fill="#c08f4f"
      />
      <path
        d="m194.6 166.9-145.5.1c6.9 0 12.4 37.2 12.4 83.2 0 44.1-5.1 80.3-11.6 83h144.7c6.9 0 12.4-37.2 12.4-83.2 0-45.8-5.6-83.1-12.4-83.1"
        fill="#594226"
      />
      <path
        d="M35 31c18.8-12.1 138-10.4 162.1 0 24.9 10.4 41.1 398.9 0 438.1-37.2 12.2-147.7 11.4-162.1 0C22 458.8 16.2 43 35 31"
        fill={color}
      />
      <path
        d="M42.5.3h-5v2.3C19.3 19 5.3 123.6 5.3 250s14 231.1 32.2 247.5v2.3h5c20.5 0 37.2-111.9 37.2-249.8S63 .3 42.5.3"
        fill="#9b7242"
      />
      <path
        d="M37.5.3C58 .3 74.6 112.2 74.6 250S58 499.8 37.5 499.8.3 387.9.3 250 16.9.3 37.5.3"
        fill="#c08f4f"
      />
      <path
        d="M35.5 171.6c6.5 0 11.6 35.1 11.6 78.4s-5.3 78.4-11.6 78.4-11.6-35.1-11.6-78.4 5.1-78.4 11.6-78.4"
        fill="#231a0f"
      />
    </svg>
  );
}

function formatMinutesAsHourDotMinute(totalMinutes: number) {
  const normalizedMinutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  return `${hours}.${String(minutes).padStart(2, '0')}`;
}

export function PrinterDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [commandInFlight, setCommandInFlight] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  // Snapmaker reports its cavity LED via Moonraker, so the displayed state is
  // synced from the hardware below. Bambu has no HTTP readback, so for it this
  // just tracks the last command sent.
  const [lightOn, setLightOn] = useState(false);
  const [lightInFlight, setLightInFlight] = useState(false);
  // While set in the future, the hardware/poller sync won't overwrite the
  // light state — it covers the command plus the lag before the printer reports.
  const lightSyncBlockedUntil = useRef(0);
  const [lightError, setLightError] = useState<string | null>(null);
  const [removeInFlight, setRemoveInFlight] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [snapshotNonce, setSnapshotNonce] = useState(() => Date.now());
  const [taskConfig, setTaskConfig] = useState<PrinterTaskConfig | null>(null);
  const [taskConfigError, setTaskConfigError] = useState<string | null>(null);
  // Shared card layout for every printer detail page; admins reorder it by drag.
  const [cardLayout, setCardLayout] = useState<CardLayout>(DEFAULT_CARD_LAYOUT);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  useEffect(() => {
    fetchPrinters()
      .then((printers) => {
        setPrinter(printers.map(normalizePrinter).find((candidate) => candidate.id === id) || null);
      })
      .catch(() => {
        setPrinter(null);
      });
  }, [id]);

  // The card layout is shared by all printers of the same profile, so reload
  // it whenever the printer's profile becomes known or changes.
  const printerProfile = printer?.profile;
  useEffect(() => {
    if (!printerProfile) {
      return;
    }
    let isCancelled = false;
    setCardLayout(DEFAULT_CARD_LAYOUT);
    fetchCardLayout(printerProfile)
      .then((layout) => {
        if (!isCancelled) {
          setCardLayout(layout);
        }
      })
      .catch(() => {
        // Fall back to the default layout if it can't be loaded.
      });
    return () => {
      isCancelled = true;
    };
  }, [printerProfile]);

  useEffect(() => {
    if (!id) {
      return;
    }

    let isCancelled = false;

    const refreshFromServer = async () => {
      try {
        const printers = await fetchPrinters();
        const nextPrinter = printers.map(normalizePrinter).find((candidate) => candidate.id === id) || null;
        if (!isCancelled) {
          setPrinter(nextPrinter);
        }
      } catch {
        // Keep the current snapshot if the server refresh fails.
      }
    };

    refreshFromServer();
    const interval = window.setInterval(refreshFromServer, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [id]);

  const isOnline = printer?.status !== 'offline' && printer !== null;

  useEffect(() => {
    setSnapshotNonce(Date.now());

    if (!printer || !isOnline) {
      return;
    }

    const interval = window.setInterval(() => {
      setSnapshotNonce(Date.now());
    }, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isOnline, printer?.id]);

  useEffect(() => {
    setTaskConfig(null);
    setTaskConfigError(null);

    // Only Snapmaker/Moonraker exposes this HTTP endpoint; other profiles
    // (e.g. Bambu) surface filament via printer.spools instead.
    if (!printer || !isOnline || printer.profile !== 'snapmaker_u1') {
      return;
    }

    let isCancelled = false;

    const refreshTaskConfig = async () => {
      try {
        const response = await fetch(
          `/__printer_proxy/${printer.id}/printer/objects/query?print_task_config`,
          { cache: 'no-store' },
        );

        if (!response.ok) {
          throw new Error(`Task config request failed with ${response.status}`);
        }

        const payload = (await response.json()) as {
          result?: {
            status?: {
              print_task_config?: PrinterTaskConfig;
            };
          };
        };

        if (!isCancelled) {
          setTaskConfig(payload.result?.status?.print_task_config ?? null);
          setTaskConfigError(null);
        }
      } catch (error) {
        if (!isCancelled) {
          setTaskConfig(null);
          setTaskConfigError(error instanceof Error ? error.message : 'Unable to load filament status');
        }
      }
    };

    refreshTaskConfig();
    const interval = window.setInterval(refreshTaskConfig, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [isOnline, printer?.id]);

  // Snapmaker U1 exposes its cavity LED via Moonraker, so reflect the real
  // hardware state — it persists across page loads instead of resetting to off.
  useEffect(() => {
    if (!printer || !isOnline || printer.profile !== 'snapmaker_u1') {
      return;
    }

    let isCancelled = false;

    const refreshLight = async () => {
      try {
        const response = await fetch(
          `/__printer_proxy/${printer.id}/printer/objects/query?led%20cavity_led`,
          { cache: 'no-store' },
        );

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as {
          result?: { status?: { 'led cavity_led'?: { color_data?: number[][] } } };
        };

        const channels = payload.result?.status?.['led cavity_led']?.color_data?.[0];
        const isLit = Array.isArray(channels) && channels.some((channel) => channel > 0);

        // Don't overwrite the state right after a manual toggle.
        if (!isCancelled && Date.now() >= lightSyncBlockedUntil.current) {
          setLightOn(isLit);
        }
      } catch {
        // Leave the last-known state if the query fails.
      }
    };

    refreshLight();
    const interval = window.setInterval(refreshLight, 10000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [isOnline, printer?.id, printer?.profile]);

  // Bambu reports its chamber light over MQTT, captured by the poller into the
  // printer record — reflect that persisted state (unless a toggle just ran).
  useEffect(() => {
    if (!printer || printer.profile !== 'bambulab_a1_mini') {
      return;
    }
    if (typeof printer.lightOn === 'boolean' && Date.now() >= lightSyncBlockedUntil.current) {
      setLightOn(printer.lightOn);
    }
  }, [printer?.profile, printer?.lightOn]);

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
  const activityLabel = isOnline ? printer.status : 'unreachable';
  const canControlPrinter = user?.role === 'admin' || user?.role === 'operator';
  const canViewSensitiveInfo = user?.role !== 'viewer';
  const webcamSnapshotUrl = `${buildPrinterWebcamSnapshotUrl(printer)}?t=${snapshotNonce}`;
  const taskConfigSlots: FilamentSlot[] =
    taskConfig?.filament_type?.map((type, index) => ({
      slot: index + 1,
      vendor: taskConfig.filament_vendor?.[index] || 'Unknown',
      type: type || 'Unknown',
      subType: taskConfig.filament_sub_type?.[index] || '',
      color: `#${(taskConfig.filament_color_rgba?.[index] || '808080FF').slice(0, 6)}`,
      isLoaded: Boolean(taskConfig.filament_exist?.[index]),
      isInUse: Boolean(taskConfig.extruders_used?.[index]),
    })) ?? [];
  // Profiles without a Moonraker task config (e.g. Bambu) report loaded
  // filament through printer.spools, populated by the poller.
  const spoolSlots: FilamentSlot[] = (printer.spools ?? []).map((spool, index) => ({
    slot: index + 1,
    vendor: '',
    type: spool.material || 'Unknown',
    subType: '',
    color: spool.color || '#808080',
    isLoaded: true,
    isInUse: printer.status === 'printing',
  }));
  const filamentSlots: FilamentSlot[] =
    taskConfigSlots.length > 0 ? taskConfigSlots : spoolSlots;
  const formattedTimeRemaining = formatMinutesAsHourDotMinute(printer.currentJob?.timeRemaining ?? 0);
  const formattedPrintingTime = formatMinutesAsHourDotMinute(printer.currentJob?.printingTime ?? 0);

  const handlePrinterCommand = async (command: 'pause' | 'resume' | 'cancel') => {
    if (!canControlPrinter) {
      setCommandError('You do not have permission to control this printer.');
      return;
    }

    setCommandInFlight(command);
    setCommandError(null);

    try {
      await sendPrinterCommand(printer, command);
      setPrinter((prev) => {
        if (!prev) {
          return prev;
        }

        if (command === 'pause') {
          return {
            ...prev,
            status: 'paused',
            currentJob: prev.currentJob
              ? {
                  ...prev.currentJob,
                  status: 'paused',
                }
              : prev.currentJob,
          };
        }

        if (command === 'resume') {
          return {
            ...prev,
            status: 'printing',
            currentJob: prev.currentJob
              ? {
                  ...prev.currentJob,
                  status: 'printing',
                }
              : prev.currentJob,
          };
        }

        return {
          ...prev,
          status: 'idle',
          currentJob: undefined,
          progress: 0,
        };
      });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : 'Unable to send printer command');
    } finally {
      setCommandInFlight(null);
    }
  };

  const handleToggleLight = async (next: boolean) => {
    if (!canControlPrinter || !printer) {
      return;
    }

    const previous = lightOn;
    setLightOn(next); // optimistic — reverted if the command fails
    setLightInFlight(true);
    // Hold the displayed state through the command and the printer's report lag.
    lightSyncBlockedUntil.current = Date.now() + 12000;
    setLightError(null);

    try {
      await setPrinterLight(printer, next);
    } catch (error) {
      setLightOn(previous);
      lightSyncBlockedUntil.current = 0; // failed — let the real state resync
      setLightError(error instanceof Error ? error.message : 'Unable to toggle the light');
    } finally {
      setLightInFlight(false);
    }
  };

  const handleRemovePrinter = async () => {
    if (!printer || user?.role !== 'admin') {
      return;
    }

    setRemoveInFlight(true);
    setRemoveError(null);

    try {
      await removePrinter(printer.id);
      navigate('/');
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Unable to remove printer');
    } finally {
      setRemoveInFlight(false);
    }
  };

  const handleCommitLayout = (next: CardLayout) => {
    setCardLayout(next);
    setLayoutError(null);
    saveCardLayout(printer.profile, next).catch((error) => {
      setLayoutError(error instanceof Error ? error.message : 'Unable to save layout');
    });
  };

  const handleResetLayout = () => {
    handleCommitLayout(DEFAULT_CARD_LAYOUT);
  };

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
        {user?.role === 'admin' && (
          <div className="flex items-center gap-2">
            {isLayoutEditing && (
              <Button type="button" variant="ghost" size="sm" onClick={handleResetLayout}>
                Reset
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
        <div className="flex flex-col items-end gap-2">
          <Badge className="text-base px-4 py-2 capitalize">
            {isOnline ? 'online' : 'offline'}
          </Badge>
        </div>
      </div>

      {isLayoutEditing && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Drag the handle on each card to rearrange. Changes apply to every {printer.model} (and other {printer.profile} printers) and save automatically.
        </p>
      )}
      {layoutError && <p className="text-sm text-red-500">{layoutError}</p>}

      <PrinterCardLayout
        layout={cardLayout}
        editable={isLayoutEditing && user?.role === 'admin'}
        onChange={setCardLayout}
        onCommit={handleCommitLayout}
        cards={{
          currentJob: (
        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
            <Activity className="size-5" />
            Current Job
          </h2>

          <div className="space-y-4">
            {/* Camera is always shown so staff can watch the printer regardless of job state. */}
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-900">
              {isOnline ? (
                <img
                  src={webcamSnapshotUrl}
                  alt={`${printer.name} preview`}
                  className="h-80 w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-80 w-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                  Webcam offline
                </div>
              )}
            </div>

            {printer.currentJob ? (
              <>
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">File</div>
                  <div className="font-medium text-lg dark:text-white">{printer.currentJob.filename}</div>
                </div>

                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-600 dark:text-gray-400">Progress</span>
                    <span className="font-medium dark:text-white">{formatMaxTwoDecimals(printer.progress)}%</span>
                  </div>
                  <Progress value={printer.progress} className="h-3" />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Time Remaining</div>
                    <div className="font-medium flex items-center gap-1 dark:text-white">
                      <Clock className="size-4" />
                      {formattedTimeRemaining} h.
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Printing Time</div>
                    <div className="font-medium dark:text-white">{formattedPrintingTime} h.</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Filament Used</div>
                    <div className="font-medium dark:text-white">
                      {formatMaxTwoDecimals(printer.currentJob.filamentUsed)}g
                    </div>
                  </div>
                </div>

                {canControlPrinter && (
                  <div className="flex gap-2 pt-4">
                    {printer.status === 'printing' && (
                      <>
                        <Button
                          variant="outline"
                          className="flex-1"
                          disabled={commandInFlight !== null}
                          onClick={() => handlePrinterCommand('pause')}
                        >
                          <Pause className="size-4 mr-2" />
                          {commandInFlight === 'pause' ? 'Pausing...' : 'Pause'}
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1"
                          disabled={commandInFlight !== null}
                          onClick={() => handlePrinterCommand('cancel')}
                        >
                          <Square className="size-4 mr-2" />
                          {commandInFlight === 'cancel' ? 'Cancelling...' : 'Cancel'}
                        </Button>
                      </>
                    )}
                    {printer.status === 'paused' && (
                      <>
                        <Button
                          className="flex-1"
                          disabled={commandInFlight !== null}
                          onClick={() => handlePrinterCommand('resume')}
                        >
                          <Play className="size-4 mr-2" />
                          {commandInFlight === 'resume' ? 'Resuming...' : 'Resume'}
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1"
                          disabled={commandInFlight !== null}
                          onClick={() => handlePrinterCommand('cancel')}
                        >
                          <Square className="size-4 mr-2" />
                          {commandInFlight === 'cancel' ? 'Cancelling...' : 'Cancel'}
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {!canControlPrinter && (
                  <p className="pt-4 text-sm text-gray-500 dark:text-gray-400">
                    Viewer accounts can monitor jobs but cannot pause, resume, or cancel them.
                  </p>
                )}

                {commandError && <p className="text-sm text-red-500">{commandError}</p>}
              </>
            ) : (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <CheckCircle className="size-12 mx-auto mb-3 opacity-50" />
                <p>No active job</p>
                <p className="text-sm mt-1">This printer is ready for new tasks</p>
              </div>
            )}
          </div>
        </Card>
          ),
          temperature: (
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
                      {formatMaxTwoDecimals(temperature)}°C
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
                    {formatMaxTwoDecimals(printer.temperature.bed)}°C
                  </span>
                </div>
                <Progress
                  value={(printer.temperature.bed / 100) * 100}
                  className="h-2"
                />
              </div>
            </div>
          </Card>
          ),
          filament: (
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
              <Palette className="size-5" />
              Current Filament
            </h2>
            {taskConfigError ? (
              <p className="text-sm text-red-500">{taskConfigError}</p>
            ) : filamentSlots.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {filamentSlots.map((slot) => (
                    <div
                      key={`${printer.id}-filament-${slot.slot}`}
                      className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                    >
                      <div className="flex h-full flex-col gap-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-10 w-8 items-center justify-center">
                            <FilamentSpoolIcon color={slot.color} />
                          </div>
                          <div>
                            <div className="font-medium dark:text-white">Tool {slot.slot}</div>
                            <div className="text-sm text-gray-600 dark:text-gray-400">
                              {`${slot.vendor} ${slot.type}`.trim()}{slot.subType ? ` / ${slot.subType}` : ''}
                            </div>
                          </div>
                        </div>
                        <div className="mt-auto flex flex-wrap items-center gap-2">
                          <Badge variant={slot.isLoaded ? 'outline' : 'secondary'}>
                            {slot.isLoaded ? 'Loaded' : 'Empty'}
                          </Badge>
                          {slot.isInUse && <Badge>In Use</Badge>}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No live filament status available.
              </p>
            )}
          </Card>
          ),
          light:
            canControlPrinter && printerSupportsLight(printer) ? (
            <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
                <Lightbulb className="size-5" />
                {printer.profile === 'snapmaker_u1' ? 'Cavity Light' : 'Chamber Light'}
              </h2>
              <Button
                type="button"
                size="lg"
                variant={lightOn ? 'default' : 'outline'}
                disabled={!isOnline || lightInFlight}
                onClick={() => handleToggleLight(!lightOn)}
                className={`h-14 w-full justify-center text-base font-semibold ${
                  lightOn ? 'bg-amber-400 text-amber-950 hover:bg-amber-300' : ''
                }`}
                aria-pressed={lightOn}
              >
                <Lightbulb className={`size-6 mr-2 ${lightOn ? 'fill-current' : ''}`} />
                {lightInFlight
                  ? 'Switching…'
                  : lightOn
                    ? 'Light On — tap to turn off'
                    : 'Light Off — tap to turn on'}
              </Button>
              {!isOnline && (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  Connect the printer to control its light.
                </p>
              )}
              {lightError && <p className="mt-3 text-sm text-red-500">{lightError}</p>}
            </Card>
          ) : null,
          information: (
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 dark:text-white">Information</h2>
            <div className="space-y-3">
              {canViewSensitiveInfo && (
                <div className="flex items-start gap-2">
                  <Network className="size-4 mt-0.5 text-gray-400" />
                  <div className="flex-1">
                    <div className="text-sm text-gray-600 dark:text-gray-400">IP Address</div>
                    <div className="font-medium dark:text-white">{printer.ipAddress}</div>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <CheckCircle className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Connection</div>
                  <div className="font-medium capitalize dark:text-white">
                    {isOnline ? 'online' : 'offline'}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Activity className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Activity</div>
                  <div className="font-medium capitalize dark:text-white">{activityLabel}</div>
                </div>
              </div>
              {canViewSensitiveInfo && (
                <div className="flex items-start gap-2">
                  <Activity className="size-4 mt-0.5 text-gray-400" />
                  <div className="flex-1">
                    <div className="text-sm text-gray-600 dark:text-gray-400">Profile</div>
                    <div className="font-medium dark:text-white">{printer.profile}</div>
                  </div>
                </div>
              )}
              {canViewSensitiveInfo && (
                <div className="flex items-start gap-2">
                  <KeyRound className="size-4 mt-0.5 text-gray-400" />
                  <div className="flex-1">
                    <div className="text-sm text-gray-600 dark:text-gray-400">API Key Header</div>
                    <div className="font-medium dark:text-white">
                      {printer.apiKeyHeader ? 'Configured' : 'Not configured'}
                    </div>
                  </div>
                </div>
              )}
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
                  <div className="font-medium dark:text-white">
                    {formatMaxTwoDecimals(printer.totalPrintTime)}h
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="size-4 mt-0.5 text-gray-400" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Success Rate</div>
                  <div className="font-medium dark:text-white">
                    {formatMaxTwoDecimals(printer.successRate)}%
                  </div>
                </div>
              </div>
              {user?.role === 'admin' && (
                <div className="pt-4">
                  <Button
                    type="button"
                    variant="destructive"
                    className="w-full"
                    disabled={removeInFlight}
                    onClick={handleRemovePrinter}
                  >
                    <Trash2 className="mr-2 size-4" />
                    {removeInFlight ? 'Removing...' : 'Remove Printer'}
                  </Button>
                  {removeError && <p className="mt-2 text-sm text-red-500">{removeError}</p>}
                </div>
              )}
            </div>
          </Card>
          ),
        }}
      />
    </div>
  );
}
