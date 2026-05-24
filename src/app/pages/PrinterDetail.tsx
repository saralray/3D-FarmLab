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
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Home,
  Move,
  Power,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import {
  MOTION_STEP_OPTIONS,
  buildPrinterWebcamPlayerUrl,
  buildPrinterWebcamSnapshotUrl,
  disablePrinterMotors,
  homePrinterAxes,
  loadPrinterFilament,
  movePrinterAxis,
  normalizePrinter,
  printerSupportsFilamentControl,
  printerSupportsLight,
  printerSupportsMotionControl,
  printerSupportsTemperatureControl,
  printerSupportsWebcamStream,
  sendPrinterCommand,
  setPrinterLight,
  setPrinterTemperature,
  unloadPrinterFilament,
  type MotionAxis,
} from '../lib/printerProfiles';
import { Input } from '../components/ui/input';
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
  // Bambu global tray id (AMS unit * 4 + tray, or 254 for the external spool)
  // used to target load/unload commands; undefined for Snapmaker tool slots.
  trayId?: number;
}

// Derive a Bambu global tray id from a poller spool id (e.g. "ams0-2" → 2,
// "ams1-0" → 4, "external" → 254).
function bambuTrayId(spoolId: string): number | undefined {
  if (spoolId === 'external') {
    return 254;
  }
  const match = /^ams(\d+)-(\d+)$/.exec(spoolId);
  return match ? Number(match[1]) * 4 + Number(match[2]) : undefined;
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

function TemperatureTargetControl({
  label,
  value,
  inFlight,
  disabled,
  onChange,
  onSubmit,
  onFocus,
  onBlur,
}: {
  label: string;
  value: string;
  inFlight: boolean;
  disabled: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      max={350}
      value={value}
      disabled={disabled}
      placeholder={inFlight ? 'Setting…' : 'Set °C'}
      aria-label={`Set ${label} target temperature, press Enter to apply`}
      title="Type a target and press Enter"
      onChange={(event) => onChange(event.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit();
        }
      }}
      className="h-8 w-20"
    />
  );
}

// Format a reported target temperature for the input box: a positive target is
// shown as an integer; 0 / off / missing falls back to the empty placeholder.
function formatTargetForInput(target: number | undefined): string {
  return typeof target === 'number' && target > 0 ? String(Math.round(target)) : '';
}

function formatMinutesAsHourDotMinute(totalMinutes: number) {
  const normalizedMinutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  return `${hours}.${String(minutes).padStart(2, '0')}`;
}

// Inner blue tint on hover for the interactive control buttons (motion, light,
// filament, edit layout), matching the dashboard sidebar tab's hover/active fill
// rather than an outer halo. `!` overrides the outline variant's grey accent
// hover; it fades out automatically while a button is disabled.
const CONTROL_GLOW =
  'hover:bg-blue-50! hover:text-blue-600! dark:hover:bg-blue-900/30! dark:hover:text-blue-400!';

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
  // Temperature target inputs keyed per heater ("nozzle-<index>" or "bed"). The
  // box mirrors the printer's reported target (synced in the effect below) so it
  // reflects changes made from the printer screen or slicer.
  const [tempInputs, setTempInputs] = useState<Record<string, string>>({});
  const [tempInFlight, setTempInFlight] = useState<string | null>(null);
  const [tempError, setTempError] = useState<string | null>(null);
  // The heater key the user is currently editing — its box isn't overwritten by
  // the hardware sync while focused.
  const [tempEditingKey, setTempEditingKey] = useState<string | null>(null);
  // Per-key timestamps; while set in the future the hardware sync won't overwrite
  // that box, covering a just-sent target plus the printer's report lag.
  const tempSyncBlockedUntil = useRef<Record<string, number>>({});
  // Manual jog/home controls. The selected step (mm) applies to every jog; the
  // in-flight key (e.g. "x+", "home") disables the pad while a command runs.
  const [motionStep, setMotionStep] = useState<number>(10);
  const [motionInFlight, setMotionInFlight] = useState<string | null>(null);
  const [motionError, setMotionError] = useState<string | null>(null);
  // Keyed "load-<slot>"/"unload-<slot>" while a filament command is in flight.
  const [filamentInFlight, setFilamentInFlight] = useState<string | null>(null);
  const [filamentError, setFilamentError] = useState<string | null>(null);
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

  // Keep each set-temp box in sync with the printer's reported target, unless the
  // user is editing that field, a command is in flight for it, or it's inside the
  // post-send grace window.
  useEffect(() => {
    if (!printer) {
      return;
    }
    const nozzleCount =
      printer.nozzleTemperatures && printer.nozzleTemperatures.length > 0
        ? printer.nozzleTemperatures.length
        : 1;
    const now = Date.now();
    setTempInputs((prev) => {
      let changed = false;
      const next = { ...prev };
      const sync = (key: string, target: number | undefined) => {
        if (key === tempEditingKey || tempInFlight === key) {
          return;
        }
        if (now < (tempSyncBlockedUntil.current[key] ?? 0)) {
          return;
        }
        const value = formatTargetForInput(target);
        if (next[key] !== value) {
          next[key] = value;
          changed = true;
        }
      };
      for (let index = 0; index < nozzleCount; index += 1) {
        sync(`nozzle-${index}`, printer.nozzleTargets?.[index]);
      }
      sync('bed', printer.bedTarget);
      return changed ? next : prev;
    });
  }, [printer, tempEditingKey, tempInFlight]);

  useEffect(() => {
    setSnapshotNonce(Date.now());

    // Snapmaker shows a live MJPEG stream (see the markup), so it doesn't need
    // snapshot polling — only refresh snapshots for snapshot-only profiles.
    if (!printer || !isOnline || printerSupportsWebcamStream(printer)) {
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
  const canControlTemp =
    canControlPrinter && isOnline && printerSupportsTemperatureControl(printer);
  // Jogging mid-print would wreck the job, so motion is only live when the
  // printer is connected and idle; otherwise the card shows a disabled note.
  const canControlMotion = canControlPrinter && printerSupportsMotionControl(printer);
  const isMotionReady = canControlMotion && isOnline && printer.status === 'idle';
  const motionControlsDisabled = !isMotionReady || motionInFlight !== null;
  // Loading/unloading mid-print would ruin the job, so filament swaps are only
  // live when the printer is connected and idle, mirroring the motion gate.
  const canControlFilament = canControlPrinter && printerSupportsFilamentControl(printer);
  const isFilamentReady = canControlFilament && isOnline && printer.status === 'idle';
  const filamentControlsDisabled = !isFilamentReady || filamentInFlight !== null;
  const canViewSensitiveInfo = user?.role !== 'viewer';
  const supportsWebcamStream = printerSupportsWebcamStream(printer);
  const webcamSnapshotUrl = `${buildPrinterWebcamSnapshotUrl(printer)}?t=${snapshotNonce}`;
  const webcamPlayerUrl = buildPrinterWebcamPlayerUrl(printer);
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
    trayId: bambuTrayId(spool.id),
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

  const handleSetTemperature = async (heater: 'nozzle' | 'bed', nozzleIndex = 0) => {
    if (!canControlPrinter || !printer) {
      return;
    }

    const key = heater === 'bed' ? 'bed' : `nozzle-${nozzleIndex}`;
    const raw = (tempInputs[key] ?? '').trim();
    const target = Number(raw);
    if (raw === '' || !Number.isFinite(target) || target < 0 || target > 350) {
      setTempError('Enter a target between 0 and 350°C.');
      return;
    }

    setTempInFlight(key);
    setTempError(null);

    try {
      await setPrinterTemperature(printer, heater, target, nozzleIndex);
      // Show the just-sent target (placeholder for 0 = off) and hold it through
      // the printer's report lag before the hardware sync takes back over.
      setTempInputs((prev) => ({ ...prev, [key]: formatTargetForInput(target) }));
      tempSyncBlockedUntil.current[key] = Date.now() + 12000;
    } catch (error) {
      setTempError(error instanceof Error ? error.message : 'Unable to set temperature');
    } finally {
      setTempInFlight(null);
    }
  };

  const runMotionCommand = async (key: string, action: () => Promise<void>) => {
    if (!isMotionReady) {
      return;
    }

    setMotionInFlight(key);
    setMotionError(null);

    try {
      await action();
    } catch (error) {
      setMotionError(error instanceof Error ? error.message : 'Unable to move the printer');
    } finally {
      setMotionInFlight(null);
    }
  };

  const handleJog = (axis: MotionAxis, direction: 1 | -1) =>
    runMotionCommand(`${axis}${direction > 0 ? '+' : '-'}`, () =>
      movePrinterAxis(printer, axis, direction * motionStep),
    );

  const handleHomeAll = () => runMotionCommand('home', () => homePrinterAxes(printer, 'all'));

  const handleDisableMotors = () =>
    runMotionCommand('disable', () => disablePrinterMotors(printer));

  const handleFilamentAction = async (action: 'load' | 'unload', slot: FilamentSlot) => {
    if (!isFilamentReady) {
      return;
    }

    setFilamentInFlight(`${action}-${slot.slot}`);
    setFilamentError(null);

    try {
      if (action === 'load') {
        await loadPrinterFilament(printer, slot.slot, slot.trayId);
      } else {
        await unloadPrinterFilament(printer, slot.slot, slot.trayId);
      }
    } catch (error) {
      setFilamentError(error instanceof Error ? error.message : 'Unable to control filament');
    } finally {
      setFilamentInFlight(null);
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
              className={CONTROL_GLOW}
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
                supportsWebcamStream ? (
                  // Snapmaker's own real-time H264 player (jmuxer → <video>), which
                  // also falls back to snapshots on its own if H264 can't play.
                  <iframe
                    key={`webcam-${printer.id}`}
                    src={webcamPlayerUrl}
                    title={`${printer.name} live view`}
                    className="h-80 w-full border-0 bg-black"
                    allow="autoplay"
                  />
                ) : (
                  <img
                    src={webcamSnapshotUrl}
                    alt={`${printer.name} preview`}
                    className="h-80 w-full object-cover"
                    loading="lazy"
                  />
                )
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
              {nozzleTemperatures.map((temperature, index) => {
                const key = `nozzle-${index}`;
                const label = nozzleTemperatures.length > 1 ? `Nozzle ${index + 1}` : 'Nozzle';
                return (
                  <div key={`${printer.id}-detail-${key}`}>
                    <div className="flex justify-between items-center gap-2 mb-2">
                      <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className={`font-bold text-lg ${getStatusColor()}`}>
                          {formatMaxTwoDecimals(temperature)}°C
                        </span>
                        {canControlTemp && (
                          <TemperatureTargetControl
                            label={label}
                            value={tempInputs[key] ?? ''}
                            inFlight={tempInFlight === key}
                            disabled={tempInFlight !== null}
                            onChange={(next) =>
                              setTempInputs((prev) => ({ ...prev, [key]: next }))
                            }
                            onSubmit={() => handleSetTemperature('nozzle', index)}
                            onFocus={() => setTempEditingKey(key)}
                            onBlur={() => setTempEditingKey((current) => (current === key ? null : current))}
                          />
                        )}
                      </div>
                    </div>
                    <Progress value={(temperature / 250) * 100} className="h-2" />
                  </div>
                );
              })}
              <div>
                <div className="flex justify-between items-center gap-2 mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Bed</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-bold text-lg ${getStatusColor()}`}>
                      {formatMaxTwoDecimals(printer.temperature.bed)}°C
                    </span>
                    {canControlTemp && (
                      <TemperatureTargetControl
                        label="Bed"
                        value={tempInputs.bed ?? ''}
                        inFlight={tempInFlight === 'bed'}
                        disabled={tempInFlight !== null}
                        onChange={(next) => setTempInputs((prev) => ({ ...prev, bed: next }))}
                        onSubmit={() => handleSetTemperature('bed')}
                        onFocus={() => setTempEditingKey('bed')}
                        onBlur={() => setTempEditingKey((current) => (current === 'bed' ? null : current))}
                      />
                    )}
                  </div>
                </div>
                <Progress value={(printer.temperature.bed / 100) * 100} className="h-2" />
              </div>
              {canControlTemp && tempError && (
                <p className="text-sm text-red-500">{tempError}</p>
              )}
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
                        {canControlFilament && (
                          <div className="flex gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className={`h-7 min-w-0 flex-1 gap-1 px-2 text-xs ${CONTROL_GLOW}`}
                              disabled={filamentControlsDisabled}
                              onClick={() => handleFilamentAction('load', slot)}
                            >
                              <ArrowDownToLine className="size-3.5" />
                              {filamentInFlight === `load-${slot.slot}` ? '…' : 'Load'}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className={`h-7 min-w-0 flex-1 gap-1 px-2 text-xs ${CONTROL_GLOW}`}
                              disabled={filamentControlsDisabled}
                              onClick={() => handleFilamentAction('unload', slot)}
                            >
                              <ArrowUpFromLine className="size-3.5" />
                              {filamentInFlight === `unload-${slot.slot}` ? '…' : 'Unload'}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No live filament status available.
              </p>
            )}
            {canControlFilament && filamentSlots.length > 0 && !isFilamentReady && (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                Filament can only be loaded or unloaded while the printer is online and idle.
              </p>
            )}
            {canControlFilament && filamentError && (
              <p className="mt-3 text-sm text-red-500">{filamentError}</p>
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
                className={`h-14 w-full justify-center text-base font-semibold ${CONTROL_GLOW} ${
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
          motion: canControlMotion ? (
            <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 dark:text-white">
                <Move className="size-5" />
                Motion Control
              </h2>
              <div className="space-y-5">
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">Step size (mm)</div>
                  <div className="grid grid-cols-4 gap-2">
                    {MOTION_STEP_OPTIONS.map((step) => (
                      <Button
                        key={step}
                        type="button"
                        size="sm"
                        variant={motionStep === step ? 'default' : 'outline'}
                        className={CONTROL_GLOW}
                        onClick={() => setMotionStep(step)}
                      >
                        {step}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex items-start justify-center gap-6">
                  <div>
                    <div className="grid grid-cols-3 gap-2">
                      <div />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('y', 1)}
                        aria-label="Jog Y positive"
                      >
                        <ArrowUp className="size-5" />
                      </Button>
                      <div />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('x', -1)}
                        aria-label="Jog X negative"
                      >
                        <ArrowLeft className="size-5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={handleHomeAll}
                        aria-label="Home all axes"
                      >
                        <Home className="size-5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('x', 1)}
                        aria-label="Jog X positive"
                      >
                        <ArrowRight className="size-5" />
                      </Button>
                      <div />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('y', -1)}
                        aria-label="Jog Y negative"
                      >
                        <ArrowDown className="size-5" />
                      </Button>
                      <div />
                    </div>
                    <div className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">X / Y</div>
                  </div>

                  <div>
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('z', 1)}
                        aria-label="Jog Z up"
                      >
                        <ArrowUp className="size-5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className={CONTROL_GLOW}
                        disabled={motionControlsDisabled}
                        onClick={() => handleJog('z', -1)}
                        aria-label="Jog Z down"
                      >
                        <ArrowDown className="size-5" />
                      </Button>
                    </div>
                    <div className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">Z</div>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className={`w-full ${CONTROL_GLOW}`}
                  disabled={motionControlsDisabled}
                  onClick={handleDisableMotors}
                >
                  <Power className="size-4 mr-2" />
                  {motionInFlight === 'disable' ? 'Disabling…' : 'Disable motors'}
                </Button>

                {!isMotionReady && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {isOnline
                      ? 'Motion control is available when the printer is idle.'
                      : 'Connect the printer to control its motion.'}
                  </p>
                )}
                {motionError && <p className="text-sm text-red-500">{motionError}</p>}
              </div>
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
