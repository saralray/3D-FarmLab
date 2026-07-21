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
  Fan,
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
  Pencil,
  AlertCircle,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  MOTION_STEP_OPTIONS,
  buildPrinterWebcamPlayerUrl,
  buildPrinterWebcamMjpegUrl,
  buildPrinterWebcamSnapshotUrl,
  disablePrinterMotors,
  homePrinterAxes,
  loadPrinterFilament,
  movePrinterAxis,
  normalizePrinter,
  PRINTER_PROFILES,
  PRINTER_FANS,
  profileHasChamberTemp,
  getNozzleLabel,
  getNozzleDisplayOrder,
  isBambuProfile,
  isH2Profile,
  printerSupportsAirFilter,
  printerSupportsCoolingControl,
  printerSupportsFilamentControl,
  printerSupportsFilamentEdit,
  setPrinterFilament,
  FILAMENT_MATERIALS,
  FILAMENT_VENDORS,
  printerSupportsLight,
  printerSupportsLiveMjpeg,
  printerSupportsMotionControl,
  printerSupportsTemperatureControl,
  printerSupportsWebcamStream,
  sendPrinterCommand,
  setPrinterAirFilter,
  setPrinterFanSpeed,
  setPrinterLight,
  setPrinterTemperature,
  unloadPrinterFilament,
  type FanDescriptor,
  type MotionAxis,
} from '../lib/printerProfiles';
import { fetchCameraHealth, type CameraHealth } from '../lib/cameraApi';
import { StatusLightCard } from '../components/StatusLightCard';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { toast } from 'sonner';
import { fetchPrinter, removePrinter, savePrinter } from '../lib/printersApi';
import { useAuth } from '../contexts/AuthContext';
import { formatMaxTwoDecimals } from '../lib/numberFormat';
import { PrinterCardLayout } from '../components/PrinterCardLayout';
import { FilamentSpoolIcon } from '../components/FilamentSpoolIcon';
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
  // Friendly slot name (e.g. "AMS HT", "External") overriding the default
  // "Slot N"/"Tool N" label. Undefined falls back to the numbered label.
  label?: string;
  // Remaining filament reported by the poller from the AMS (Bambu RFID spools):
  // percentage and grams left. Undefined when the printer doesn't report it.
  remaining?: number;
  weight?: number;
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

// Friendly label for a Bambu spool slot. Bambu assigns AMS HT units ids >= 128
// (global tray id >= 512), so the bare "Slot 513" reads wrong — those are
// single-slot high-temp units and should show "AMS HT". Returns undefined for
// regular AMS trays so they keep the numbered "Slot N" label.
function bambuSlotLabel(trayId: number | undefined): string | undefined {
  if (trayId === undefined) return undefined;
  if (trayId === 254) return 'External';
  const unit = Math.floor(trayId / 4);
  if (unit >= 128) {
    const index = unit - 128;
    return index > 0 ? `AMS HT ${index + 1}` : 'AMS HT';
  }
  return undefined;
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
  max = 350,
}: {
  label: string;
  value: string;
  inFlight: boolean;
  disabled: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
  onBlur: () => void;
  max?: number;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
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

// Small status pill overlaid on the live MJPEG view, reflecting the server
// camera hub's supervisor state: green "Live" when frames are flowing, amber
// "Reconnecting" while it restarts a stalled feed, grey "Connecting" on startup.
function CameraHealthBadge({
  health,
  imageErrored,
}: {
  health: CameraHealth | null;
  imageErrored: boolean;
}) {
  if (!health) return null;

  const reconnecting = imageErrored || health.status === 'error';
  const live = health.online && !reconnecting;

  const dotClass = live
    ? 'bg-green-500'
    : reconnecting
      ? 'bg-amber-500 animate-pulse'
      : 'bg-muted-foreground/70';
  const label = live ? 'Live' : reconnecting ? 'Reconnecting' : 'Connecting';
  const title =
    health.restarts > 0
      ? `${label} · ${health.restarts} reconnect${health.restarts === 1 ? '' : 's'}${
          health.lastError ? ` · ${health.lastError}` : ''
        }`
      : label;

  return (
    <div
      title={title}
      className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm"
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      {label}
    </div>
  );
}

// Inner blue tint on hover for the interactive control buttons (motion, light,
// filament, edit layout), matching the dashboard sidebar tab's hover/active fill
// rather than an outer halo. `!` overrides the outline variant's grey accent
// hover; it fades out automatically while a button is disabled.
const CONTROL_GLOW =
  'hover:bg-blue-50! hover:text-blue-600! dark:hover:bg-blue-900/30! dark:hover:text-blue-400!';

// Every live readout on this page (temps, grams, percentages, coordinates,
// timers) shares this instrument-panel numeral treatment — monospaced with
// tabular figures, distinct from the prose labels around it, so the page
// reads like a bank of gauges rather than another settings form.
const READOUT = 'font-mono tabular-nums';

// A heater's color should reflect how hot it actually is, not the printer's
// job status (a paused printer with a hot bed is still hot) — this three-stop
// scale is fixed to 0–max regardless of the current reading, matching how a
// physical printer's own display colors its heater digits.
function thermalTextClass(percent: number): string {
  if (percent >= 66) return 'text-thermal-hot';
  if (percent >= 33) return 'text-thermal-warm';
  return 'text-thermal-cold';
}

// Heater gauge: the track always shows the full cold→warm→hot scale so a
// glance at *where* the fill ends tells you the temperature, not just a
// generic percentage bar. `clip-path` reveals a fixed-position slice of that
// scale rather than restretching a gradient to the current value, so the
// color at any given fill length is always the same physical temperature.
function ThermalBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'linear-gradient(90deg, var(--thermal-cold) 0%, var(--thermal-warm) 50%, var(--thermal-hot) 100%)',
          clipPath: `inset(0 ${100 - clamped}% 0 0)`,
        }}
      />
    </div>
  );
}

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Editable printer-information fields admins can change from the detail page.
interface PrinterInfoDraft {
  name: string;
  model: string;
  ipAddress: string;
  apiKeyHeader: string;
  serial: string;
  callbackUrl: string;
  lastMaintenance: string;
}

export function PrinterDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [commandInFlight, setCommandInFlight] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  // Snapmaker reports its cavity LED via Moonraker, so the displayed state is
  // synced from the hardware below. Bambu has no HTTP readback, so for it this
  // just tracks the last command sent.
  const [lightOn, setLightOn] = useState(false);
  const [lightInFlight, setLightInFlight] = useState(false);
  // While set in the future, the hardware/poller sync won't overwrite the
  // light state — it covers the command plus the lag before the printer reports.
  const lightSyncBlockedUntil = useRef(0);
  const [removeInFlight, setRemoveInFlight] = useState(false);
  // Admin "edit printer information" dialog. The draft is held separately from
  // `printer` so the 10s auto-refresh doesn't clobber in-progress edits.
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<PrinterInfoDraft | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // Temperature target inputs keyed per heater ("nozzle-<index>" or "bed"). The
  // box mirrors the printer's reported target (synced in the effect below) so it
  // reflects changes made from the printer screen or slicer.
  const [tempInputs, setTempInputs] = useState<Record<string, string>>({});
  const [tempInFlight, setTempInFlight] = useState<string | null>(null);
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
  // Keyed "load-<slot>"/"unload-<slot>" while a filament command is in flight.
  const [filamentInFlight, setFilamentInFlight] = useState<string | null>(null);
  // The filament slot the user has selected (its 1-based `slot`). Load/Unload/Edit
  // act on this slot, so the controls stay disabled until a spool is picked.
  const [selectedFilamentSlot, setSelectedFilamentSlot] = useState<number | null>(null);
  // "Edit filament" dialog: the slot being edited plus its draft vendor/material/color.
  const [filamentEditSlot, setFilamentEditSlot] = useState<FilamentSlot | null>(null);
  const [filamentEditDraft, setFilamentEditDraft] = useState<{
    vendor: string;
    type: string;
    color: string;
  }>({
    vendor: '',
    type: 'PLA',
    color: '#808080',
  });
  const [filamentEditSaving, setFilamentEditSaving] = useState(false);
  // Cooling-fan slider positions keyed by fan id ("part"/"aux"/"chamber"), each
  // a 0–100 percentage. Synced from the printer's reported speeds below unless
  // the user is dragging or a command is in flight / inside its grace window.
  const [fanInputs, setFanInputs] = useState<Record<string, number>>({});
  const [fanInFlight, setFanInFlight] = useState<string | null>(null);
  // Per-fan timestamps; while set in the future the hardware sync won't overwrite
  // that slider, covering a just-sent speed plus the printer's report lag.
  const fanSyncBlockedUntil = useRef<Record<string, number>>({});
  // H2-series air filter on/off. Synced from the poller's reported state
  // (printer.airFilterOn, from the airduct filtration submode); an optimistic
  // toggle holds the sync off briefly via the grace window below.
  const [airFilterOn, setAirFilterOn] = useState(false);
  const [airFilterInFlight, setAirFilterInFlight] = useState(false);
  // While set in the future the hardware sync won't overwrite the just-sent
  // filter state — covers the command plus the printer's report lag.
  const airFilterSyncBlockedUntil = useRef(0);
  const [snapshotNonce, setSnapshotNonce] = useState(() => Date.now());
  // Bambu snapshots are refreshed load-driven (see the webcam effect): the next
  // frame is requested only after the current <img> finishes, via this timer.
  const snapshotTimerRef = useRef<number | undefined>(undefined);
  // True when the latest Bambu snapshot failed to load (e.g. the H2S camera
  // rejects the request) so the UI shows a placeholder instead of a broken image.
  const [snapshotErrored, setSnapshotErrored] = useState(false);
  // Tracks whether this browser tab is in the foreground. The live view (MJPEG
  // stream, snapshot polling, Snapmaker iframe player) is torn down while the
  // tab is hidden so a backgrounded/minimized dashboard tab stops pulling
  // camera bytes — this is the single biggest source of avoidable webcam
  // network traffic since the feed otherwise runs indefinitely unattended.
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  // Live-view camera health from the server hub (supervisor status, restarts,
  // frame freshness), polled while an H2/X1 live MJPEG feed is shown.
  const [cameraHealth, setCameraHealth] = useState<CameraHealth | null>(null);
  const [taskConfig, setTaskConfig] = useState<PrinterTaskConfig | null>(null);
  const [taskConfigError, setTaskConfigError] = useState<string | null>(null);
  // Shared card layout for every printer detail page; admins reorder it by drag.
  const [cardLayout, setCardLayout] = useState<CardLayout>(DEFAULT_CARD_LAYOUT);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const [showCredential, setShowCredential] = useState(false);

  useEffect(() => {
    if (!id) {
      setPrinter(null);
      return;
    }
    fetchPrinter(id)
      .then((fetched) => {
        setPrinter(fetched ? normalizePrinter(fetched) : null);
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
        const fetched = await fetchPrinter(id);
        const nextPrinter = fetched ? normalizePrinter(fetched) : null;
        if (!isCancelled) {
          setPrinter(nextPrinter);
        }
      } catch {
        // Keep the current snapshot if the server refresh fails.
      }
    };

    // Pause the interval while the tab is hidden — a backgrounded printer
    // detail page has no reason to keep polling — and resume with an
    // immediate refresh when it becomes visible again.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(refreshFromServer, 15000);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshFromServer();
        startInterval();
      } else {
        stopInterval();
      }
    };

    refreshFromServer();
    if (document.visibilityState === 'visible') {
      startInterval();
    }
    window.addEventListener('online', refreshFromServer);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      isCancelled = true;
      stopInterval();
      window.removeEventListener('online', refreshFromServer);
      document.removeEventListener('visibilitychange', onVisible);
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
      sync('chamber', printer.chamberTarget);
      return changed ? next : prev;
    });
  }, [printer, tempEditingKey, tempInFlight]);

  // Keep each fan slider in sync with the printer's reported speed, unless a
  // command is in flight for it or it's inside the post-send grace window.
  useEffect(() => {
    if (!printer?.fanSpeeds) {
      return;
    }
    const now = Date.now();
    setFanInputs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const { id, speed } of printer.fanSpeeds ?? []) {
        if (fanInFlight === id || now < (fanSyncBlockedUntil.current[id] ?? 0)) {
          continue;
        }
        const value = Math.max(0, Math.min(100, Math.round(speed)));
        if (next[id] !== value) {
          next[id] = value;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [printer?.fanSpeeds, fanInFlight]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      setIsTabVisible(visible);
      if (visible) {
        // Reconnect with a fresh src rather than resuming a stale/broken one.
        setSnapshotNonce(Date.now());
        setSnapshotErrored(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    setSnapshotNonce(Date.now());
    setSnapshotErrored(false);
    setAirFilterOn(false);

    // Snapmaker shows a live MJPEG/H264 stream (iframe), so it doesn't poll
    // snapshots. For snapshot-only profiles (Bambu) the refresh is driven by the
    // <img> onLoad/onError handlers below rather than a fixed timer: the Bambu
    // camera serves one slow frame (~5 s) per connection, so a 2 s timer just
    // aborts each in-flight load and nothing ever renders. Clear any pending
    // refresh when the printer/online state changes or the page unmounts.
    return () => {
      window.clearTimeout(snapshotTimerRef.current);
    };
  }, [isOnline, printer?.id]);

  // Poll the live-view camera health while an H2/X1 MJPEG feed is on screen so
  // the badge reflects the hub's supervisor state (running / reconnecting).
  useEffect(() => {
    setCameraHealth(null);
    if (!printer || !isOnline || !printerSupportsLiveMjpeg(printer)) {
      return;
    }

    const printerId = printer.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const health = await fetchCameraHealth(printerId);
        if (!cancelled) setCameraHealth(health);
      } catch {
        if (!cancelled) setCameraHealth(null);
      }
    };
    // Pause while the tab is hidden — a backgrounded detail page has no
    // reason to keep polling camera health every 10s.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(poll, 10000);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        startInterval();
      } else {
        stopInterval();
      }
    };

    poll();
    if (document.visibilityState === 'visible') {
      startInterval();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, [isOnline, printer?.id, printer?.profile]);

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

    // Pause while the tab is hidden — a backgrounded detail page has no
    // reason to keep polling Moonraker every 10s.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(refreshTaskConfig, 10000);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshTaskConfig();
        startInterval();
      } else {
        stopInterval();
      }
    };

    refreshTaskConfig();
    if (document.visibilityState === 'visible') {
      startInterval();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
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

    // Pause while the tab is hidden — a backgrounded detail page has no
    // reason to keep polling Moonraker every 10s.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(refreshLight, 10000);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshLight();
        startInterval();
      } else {
        stopInterval();
      }
    };

    refreshLight();
    if (document.visibilityState === 'visible') {
      startInterval();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, [isOnline, printer?.id, printer?.profile]);

  // Bambu reports its chamber light over MQTT, captured by the poller into the
  // printer record — reflect that persisted state (unless a toggle just ran).
  useEffect(() => {
    if (!printer || !isBambuProfile(printer.profile)) {
      return;
    }
    if (typeof printer.lightOn === 'boolean' && Date.now() >= lightSyncBlockedUntil.current) {
      setLightOn(printer.lightOn);
    }
  }, [printer?.profile, printer?.lightOn]);

  // The H2 air-filter state is reported by the poller (airduct submode) into the
  // printer record — reflect that persisted state (unless a toggle just ran).
  useEffect(() => {
    if (!printer || !isBambuProfile(printer.profile)) {
      return;
    }
    if (
      typeof printer.airFilterOn === 'boolean' &&
      Date.now() >= airFilterSyncBlockedUntil.current
    ) {
      setAirFilterOn(printer.airFilterOn);
    }
  }, [printer?.profile, printer?.airFilterOn]);

  if (!printer) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <p className="text-muted-foreground">Printer not found</p>
          <Button onClick={() => navigate('/')} className="mt-4">
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // Full utility class names are spelled out per status (rather than built
  // from an interpolated token) so Tailwind's static source scan can see and
  // generate them — a template-built class name like `bg-${token}` never
  // makes it into the compiled CSS.
  const getStatusColor = () => {
    switch (printer.status) {
      case 'printing':
        return 'text-status-printing';
      case 'idle':
        return 'text-status-idle';
      case 'error':
        return 'text-destructive';
      case 'offline':
        return 'text-muted-foreground';
      case 'paused':
        return 'text-status-paused';
    }
  };

  const getStatusDotColor = () => {
    switch (printer.status) {
      case 'printing':
        return 'bg-status-printing';
      case 'idle':
        return 'bg-status-idle';
      case 'error':
        return 'bg-destructive';
      case 'offline':
        return 'bg-muted-foreground';
      case 'paused':
        return 'bg-status-paused';
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
  // Fan speed is safe to change mid-print (unlike motion/filament), so it's live
  // whenever the printer is connected — no idle gate.
  const canControlCooling =
    canControlPrinter && isOnline && printerSupportsCoolingControl(printer);
  const printerFans = PRINTER_FANS[printer.profile] ?? [];
  const supportsAirFilter = printerSupportsAirFilter(printer);
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
  const canEditFilament = canControlPrinter && printerSupportsFilamentEdit(printer);
  const canViewSensitiveInfo = user?.role !== 'viewer';
  // The printer's IP is a connection secret operators shouldn't need, so it is
  // admin-only — a tighter gate than the rest of the sensitive info block.
  const canViewIpAddress = user?.role === 'admin';
  const supportsWebcamStream = printerSupportsWebcamStream(printer);
  const supportsLiveMjpeg = printerSupportsLiveMjpeg(printer);
  const webcamSnapshotUrl = `${buildPrinterWebcamSnapshotUrl(printer)}?t=${snapshotNonce}`;
  // The nonce lets onError force a fresh connection by changing the src.
  const webcamMjpegUrl = `${buildPrinterWebcamMjpegUrl(printer)}?t=${snapshotNonce}`;
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
  const spoolSlots: FilamentSlot[] = (printer.spools ?? []).map((spool, index) => {
    const trayId = bambuTrayId(spool.id);
    return {
      // Show the physical tray position (trayId 0-based → 1-based slot) so the
      // slot number matches the AMS, not just the order spools were reported.
      // The external spool (254) and non-Bambu profiles fall back to index+1.
      slot: trayId !== undefined && trayId !== 254 ? trayId + 1 : index + 1,
      vendor: spool.vendor || '',
      type: spool.material || 'Unknown',
      subType: '',
      color: spool.color || '#808080',
      isLoaded: true,
      isInUse: printer.status === 'printing',
      trayId,
      label: bambuSlotLabel(trayId),
      remaining: spool.remaining,
      weight: spool.weight,
    };
  });
  const filamentSlots: FilamentSlot[] =
    taskConfigSlots.length > 0 ? taskConfigSlots : spoolSlots;
  const selectedSlot = filamentSlots.find((s) => s.slot === selectedFilamentSlot) ?? null;
  const formattedTimeRemaining = formatMinutesAsHourDotMinute(printer.currentJob?.timeRemaining ?? 0);
  const formattedPrintingTime = formatMinutesAsHourDotMinute(printer.currentJob?.printingTime ?? 0);

  const handlePrinterCommand = async (command: 'pause' | 'resume' | 'cancel') => {
    if (!canControlPrinter) {
      toast.error('You do not have permission to control this printer.');
      return;
    }

    setCommandInFlight(command);

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
      toast.error(error instanceof Error ? error.message : 'Unable to send printer command');
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

    try {
      await setPrinterLight(printer, next);
    } catch (error) {
      setLightOn(previous);
      lightSyncBlockedUntil.current = 0; // failed — let the real state resync
      toast.error(error instanceof Error ? error.message : 'Unable to toggle the light');
    } finally {
      setLightInFlight(false);
    }
  };

  const handleSetTemperature = async (
    heater: 'nozzle' | 'bed' | 'chamber',
    nozzleIndex = 0,
  ) => {
    if (!canControlPrinter || !printer) {
      return;
    }

    const key = heater === 'bed' || heater === 'chamber' ? heater : `nozzle-${nozzleIndex}`;
    const raw = (tempInputs[key] ?? '').trim();
    const target = Number(raw);
    // The chamber heater tops out far lower than the hotend/bed.
    const maxTarget = heater === 'chamber' ? 60 : 350;
    if (raw === '' || !Number.isFinite(target) || target < 0 || target > maxTarget) {
      toast.error(`Enter a target between 0 and ${maxTarget}°C.`);
      return;
    }

    setTempInFlight(key);

    try {
      await setPrinterTemperature(printer, heater, target, nozzleIndex);
      // Show the just-sent target (placeholder for 0 = off) and hold it through
      // the printer's report lag before the hardware sync takes back over.
      setTempInputs((prev) => ({ ...prev, [key]: formatTargetForInput(target) }));
      tempSyncBlockedUntil.current[key] = Date.now() + 12000;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to set temperature');
    } finally {
      setTempInFlight(null);
    }
  };

  // Queue the next Bambu snapshot once the current frame settles. A short delay
  // after a successful load keeps it near real-time; a longer one after an error
  // (camera rejecting / printer busy) avoids hammering a failing camera.
  const scheduleSnapshotRefresh = (delayMs: number) => {
    window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = window.setTimeout(() => {
      setSnapshotNonce(Date.now());
    }, delayMs);
  };

  const handleSetFan = async (fan: FanDescriptor, percent: number) => {
    if (!canControlCooling || !printer) {
      return;
    }

    const value = Math.max(0, Math.min(100, Math.round(percent)));
    const previous = fanInputs[fan.id];
    setFanInputs((prev) => ({ ...prev, [fan.id]: value })); // optimistic
    setFanInFlight(fan.id);
    // Hold the displayed speed through the command and the printer's report lag.
    fanSyncBlockedUntil.current[fan.id] = Date.now() + 12000;

    try {
      await setPrinterFanSpeed(printer, fan, value);
    } catch (error) {
      setFanInputs((prev) => ({ ...prev, [fan.id]: previous ?? 0 }));
      fanSyncBlockedUntil.current[fan.id] = 0; // failed — let the real state resync
      toast.error(error instanceof Error ? error.message : 'Unable to set fan speed');
    } finally {
      setFanInFlight(null);
    }
  };

  const handleToggleAirFilter = async (next: boolean) => {
    if (!canControlCooling || !printer) {
      return;
    }

    const previous = airFilterOn;
    setAirFilterOn(next); // optimistic
    setAirFilterInFlight(true);
    airFilterSyncBlockedUntil.current = Date.now() + 12000;

    try {
      await setPrinterAirFilter(printer, next);
    } catch (error) {
      setAirFilterOn(previous);
      airFilterSyncBlockedUntil.current = 0; // failed — let the real state resync
      toast.error(error instanceof Error ? error.message : 'Unable to toggle the air filter');
    } finally {
      setAirFilterInFlight(false);
    }
  };

  const runMotionCommand = async (key: string, action: () => Promise<void>) => {
    if (!isMotionReady) {
      return;
    }

    setMotionInFlight(key);

    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to move the printer');
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

    try {
      if (action === 'load') {
        await loadPrinterFilament(printer, slot.slot, slot.trayId);
      } else {
        await unloadPrinterFilament(printer, slot.slot, slot.trayId);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to control filament');
    } finally {
      setFilamentInFlight(null);
    }
  };

  const openFilamentEdit = (slot: FilamentSlot) => {
    setFilamentEditSlot(slot);
    setFilamentEditDraft({
      vendor: slot.vendor && slot.vendor !== 'Unknown' ? slot.vendor : '',
      type: (slot.type || 'PLA').toUpperCase(),
      color: slot.color || '#808080',
    });
  };

  const saveFilamentEdit = async () => {
    if (!filamentEditSlot) {
      return;
    }
    setFilamentEditSaving(true);
    try {
      await setPrinterFilament(printer, filamentEditSlot.slot, filamentEditSlot.trayId, {
        type: filamentEditDraft.type,
        color: filamentEditDraft.color,
        vendor: filamentEditDraft.vendor,
      });
      toast.success('Filament updated');
      setFilamentEditSlot(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to update filament');
    } finally {
      setFilamentEditSaving(false);
    }
  };

  const openEditDialog = () => {
    if (!printer) {
      return;
    }
    setEditDraft({
      name: printer.name,
      model: printer.model,
      ipAddress: printer.ipAddress,
      apiKeyHeader: printer.apiKeyHeader,
      serial: printer.serial ?? '',
      callbackUrl: printer.callbackUrl ?? '',
      lastMaintenance: printer.lastMaintenance,
    });
    setIsEditOpen(true);
  };

  const handleSavePrinterInfo = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!printer || user?.role !== 'admin' || !editDraft) {
      return;
    }

    const name = editDraft.name.trim();
    const model = editDraft.model.trim();
    const ipAddress = editDraft.ipAddress.trim();
    const apiKeyHeader = editDraft.apiKeyHeader.trim();
    const serial = editDraft.serial.trim();
    const callbackUrl = editDraft.callbackUrl.trim();
    const lastMaintenance = editDraft.lastMaintenance.trim();
    const profileConfig = PRINTER_PROFILES[printer.profile];

    if (!name || !model || !ipAddress || !apiKeyHeader) {
      toast.error(`Name, model, IP address, and ${profileConfig.credentialLabel} are required.`);
      return;
    }

    if (!IPV4_PATTERN.test(ipAddress)) {
      toast.error('Enter a valid IPv4 address.');
      return;
    }

    if (isBambuProfile(printer.profile) && !serial) {
      toast.error('Bambu Lab printers require the device serial number.');
      return;
    }

    if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) {
      toast.error('Printer callback URL must start with http:// or https://');
      return;
    }

    setEditSaving(true);

    // Recompute the base URL from the (possibly changed) IP so the proxy and
    // poller keep reaching the printer. Other runtime fields are preserved.
    const updatedPrinter: Printer = {
      ...printer,
      name,
      model,
      ipAddress,
      url: profileConfig.buildBaseUrl(ipAddress),
      apiKeyHeader,
      serial: serial || undefined,
      callbackUrl: callbackUrl || undefined,
      lastMaintenance,
    };

    try {
      await savePrinter(updatedPrinter);
      setPrinter(updatedPrinter);
      setIsEditOpen(false);
      toast.success('Printer information saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save printer information.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemovePrinter = async () => {
    if (!printer || user?.role !== 'admin') {
      return;
    }

    setRemoveInFlight(true);

    try {
      await removePrinter(printer.id);
      navigate('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to remove printer');
    } finally {
      setRemoveInFlight(false);
    }
  };

  const handleCommitLayout = (next: CardLayout) => {
    setCardLayout(next);
    saveCardLayout(printer.profile, next).catch((error) => {
      toast.error(error instanceof Error ? error.message : 'Unable to save layout');
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
          <h1 className="text-3xl font-bold">{printer.name}</h1>
          <p className={`${READOUT} mt-1 inline-block rounded border border-border px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground`}>
            {printer.model}
          </p>
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
          <Badge variant="outline" className="gap-2 px-4 py-2 text-base capitalize">
            <span className={`size-2 rounded-full ${getStatusDotColor()}`} aria-hidden="true" />
            {isOnline ? printer.status : 'offline'}
          </Badge>
        </div>
      </div>

      {printer.errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border-2 border-destructive bg-card px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="size-5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Printer error</div>
            <div className="break-words">{printer.errorMessage}</div>
          </div>
        </div>
      )}

      {isLayoutEditing && (
        <p className="text-sm text-muted-foreground">
          Drag the handle on each card to rearrange. Changes apply to every {printer.model} (and other {printer.profile} printers) and save automatically.
        </p>
      )}

      <PrinterCardLayout
        layout={cardLayout}
        editable={isLayoutEditing && user?.role === 'admin'}
        onChange={setCardLayout}
        onCommit={handleCommitLayout}
        cards={{
          currentJob: (
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Activity className="size-5" />
            Current Job
          </h2>

          <div className="space-y-4">
            {/* Camera is always shown so staff can watch the printer regardless of job state.
                A fixed 16:9 box (aspect-video) is shared by every profile so the live feed
                fills the card edge-to-edge (object-cover) with no black letterbox bars. */}
            <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted">
              {isOnline && !isTabVisible ? (
                // Tab is backgrounded: tear the feed down entirely (no iframe/img
                // mounted) rather than merely hiding it, so the browser drops the
                // connection and the server-side camera hub can idle-shutdown.
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Live view paused (tab inactive)
                </div>
              ) : isOnline ? (
                supportsWebcamStream ? (
                  // Snapmaker's own real-time H264 player (jmuxer → <video>), which
                  // also falls back to snapshots on its own if H264 can't play.
                  <iframe
                    key={`webcam-${printer.id}`}
                    src={webcamPlayerUrl}
                    title={`${printer.name} live view`}
                    className="absolute inset-0 h-full w-full border-0"
                    allow="autoplay"
                  />
                ) : supportsLiveMjpeg ? (
                  // H2 series: live MJPEG stream (ffmpeg transcodes the RTSP feed
                  // server-side). The <img> holds one long-lived connection; on a
                  // drop, onError schedules a reconnect by bumping the src nonce.
                  <div className="absolute inset-0">
                    <img
                      key={`webcam-mjpeg-${printer.id}`}
                      src={webcamMjpegUrl}
                      alt={`${printer.name} live view`}
                      className={`h-full w-full object-cover ${snapshotErrored ? 'opacity-0' : ''}`}
                      onLoad={() => setSnapshotErrored(false)}
                      onError={() => {
                        setSnapshotErrored(true);
                        scheduleSnapshotRefresh(3000);
                      }}
                    />
                    <CameraHealthBadge health={cameraHealth} imageErrored={snapshotErrored} />
                    {snapshotErrored && (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                        Reconnecting…
                      </div>
                    )}
                  </div>
                ) : (
                  // A1 Mini: still-snapshot polling, refreshed load-driven (the img
                  // stays mounted to keep the loop alive even while erroring). On a
                  // rejected camera the server 502s, so onError shows a placeholder
                  // instead of a broken image.
                  <div className="absolute inset-0">
                    <img
                      key={`webcam-${printer.id}`}
                      src={webcamSnapshotUrl}
                      alt={`${printer.name} preview`}
                      className={`h-full w-full object-cover ${snapshotErrored ? 'opacity-0' : ''}`}
                      onLoad={() => {
                        setSnapshotErrored(false);
                        scheduleSnapshotRefresh(500);
                      }}
                      onError={() => {
                        setSnapshotErrored(true);
                        scheduleSnapshotRefresh(3000);
                      }}
                    />
                    {snapshotErrored && (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                        Webcam unavailable
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Webcam offline
                </div>
              )}

              {/* Chamber/cavity light toggle, overlaid on the live view rather than
                  taking up a card of its own. */}
              {canControlPrinter && printerSupportsLight(printer) && (
                <Button
                  type="button"
                  size="icon"
                  variant={lightOn ? 'default' : 'secondary'}
                  disabled={!isOnline || lightInFlight}
                  onClick={() => handleToggleLight(!lightOn)}
                  aria-pressed={lightOn}
                  aria-label={
                    printer.profile === 'snapmaker_u1' ? 'Cavity light' : 'Chamber light'
                  }
                  title={printer.profile === 'snapmaker_u1' ? 'Cavity Light' : 'Chamber Light'}
                  className={`absolute right-2 top-2 size-9 rounded-full shadow-md ${CONTROL_GLOW} ${
                    lightOn ? 'bg-amber-400 text-amber-950 hover:bg-amber-300' : ''
                  }`}
                >
                  <Lightbulb className={`size-5 ${lightOn ? 'fill-current' : ''}`} />
                </Button>
              )}
            </div>

            {/* Job details reserve a fixed height so the progress bar that follows
                always lands at the same vertical level, whether the printer is idle
                ("No active job") or printing (file / time / filament). */}
            <div className="min-h-[184px]">
              {printer.currentJob ? (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">File</div>
                    <div className="font-medium text-lg truncate">{printer.currentJob.filename}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Time Remaining</div>
                      <div className={`${READOUT} font-medium flex items-center gap-1`}>
                        <Clock className="size-4" />
                        {formattedTimeRemaining} h.
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Printing Time</div>
                      <div className={`${READOUT} font-medium`}>{formattedPrintingTime} h.</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Filament Used</div>
                      <div className={`${READOUT} font-medium`}>
                        {formatMaxTwoDecimals(printer.currentJob.filamentUsed)}g
                        {typeof printer.currentJob.estimatedFilament === 'number' &&
                          printer.currentJob.estimatedFilament > 0 && (
                            <span className="text-muted-foreground">
                              {' / '}
                              {formatMaxTwoDecimals(printer.currentJob.estimatedFilament)}g
                            </span>
                          )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="size-12 mx-auto mb-3 opacity-50" />
                  <p>No active job</p>
                  <p className="text-sm mt-1">This printer is ready for new tasks</p>
                </div>
              )}
            </div>

            {/* Progress bar is always rendered, right after the fixed-height details
                area, so it sits at the exact same level whether idle or printing. */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-muted-foreground">Progress</span>
                <span className={`${READOUT} font-medium`}>{formatMaxTwoDecimals(printer.progress)}%</span>
              </div>
              <Progress value={printer.progress} className="h-3" />
            </div>

            {printer.currentJob && canControlPrinter && (
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

            {printer.currentJob && !canControlPrinter && (
              <p className="pt-4 text-sm text-muted-foreground">
                Viewer accounts can monitor jobs but cannot pause, resume, or cancel them.
              </p>
            )}
          </div>
        </Card>
          ),
          temperature: (
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Thermometer className="size-5" />
              Temperature
            </h2>
            <div className="space-y-4">
              {/* Dual-nozzle printers (H2D) lay the two nozzles out side by side, in
                  the profile's display order (left nozzle first → left column). */}
              <div
                className={
                  nozzleTemperatures.length > 1 ? 'grid grid-cols-2 gap-4' : undefined
                }
              >
                {getNozzleDisplayOrder(printer.profile, nozzleTemperatures.length).map((index) => {
                  const temperature = nozzleTemperatures[index];
                  const key = `nozzle-${index}`;
                  const label = getNozzleLabel(printer.profile, index, nozzleTemperatures.length);
                  const multiNozzle = nozzleTemperatures.length > 1;
                  return (
                    <div key={`${printer.id}-detail-${key}`}>
                      {/* In the narrow side-by-side columns the label, value and
                          input can't share a line, so stack them; single-nozzle
                          printers keep the inline row like the bed/chamber rows. */}
                      <div
                        className={`flex gap-2 mb-2 ${
                          multiNozzle
                            ? 'flex-col items-start'
                            : 'justify-between items-center'
                        }`}
                      >
                        <span
                          className={`text-sm text-muted-foreground truncate ${
                            multiNozzle ? 'w-full' : 'min-w-0'
                          }`}
                        >
                          {label}
                        </span>
                        <div
                          className={`flex items-center gap-2 flex-wrap ${
                            multiNozzle ? '' : 'shrink-0'
                          }`}
                        >
                          <span
                            className={`${READOUT} font-bold text-lg ${thermalTextClass((temperature / 250) * 100)}`}
                          >
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
                      <ThermalBar percent={(temperature / 250) * 100} />
                    </div>
                  );
                })}
              </div>
              <div>
                <div className="flex justify-between items-center gap-2 mb-2">
                  <span className="text-sm text-muted-foreground">Bed</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`${READOUT} font-bold text-lg ${thermalTextClass((printer.temperature.bed / 100) * 100)}`}
                    >
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
                <ThermalBar percent={(printer.temperature.bed / 100) * 100} />
              </div>
              {profileHasChamberTemp(printer.profile) && (
                <div>
                  <div className="flex justify-between items-center gap-2 mb-2">
                    <span className="text-sm text-muted-foreground">Chamber</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`${READOUT} font-bold text-lg ${thermalTextClass(((printer.temperature.chamber ?? 0) / 60) * 100)}`}
                      >
                        {formatMaxTwoDecimals(printer.temperature.chamber ?? 0)}°C
                      </span>
                      {canControlTemp && (
                        <TemperatureTargetControl
                          label="Chamber"
                          max={60}
                          value={tempInputs.chamber ?? ''}
                          inFlight={tempInFlight === 'chamber'}
                          disabled={tempInFlight !== null}
                          onChange={(next) =>
                            setTempInputs((prev) => ({ ...prev, chamber: next }))
                          }
                          onSubmit={() => handleSetTemperature('chamber')}
                          onFocus={() => setTempEditingKey('chamber')}
                          onBlur={() =>
                            setTempEditingKey((current) => (current === 'chamber' ? null : current))
                          }
                        />
                      )}
                    </div>
                  </div>
                  <ThermalBar percent={((printer.temperature.chamber ?? 0) / 60) * 100} />
                </div>
              )}
            </div>
          </Card>
          ),
          filament: (
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Palette className="size-5" />
              Current Filament
            </h2>
            {taskConfigError ? (
              <p className="text-sm text-red-500">{taskConfigError}</p>
            ) : filamentSlots.length > 0 ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {filamentSlots.map((slot) => {
                    const isSelectable = canControlFilament || canEditFilament;
                    const isSelected = selectedFilamentSlot === slot.slot;
                    return (
                    <div
                      key={`${printer.id}-filament-${slot.slot}`}
                      role={isSelectable ? 'button' : undefined}
                      tabIndex={isSelectable ? 0 : undefined}
                      aria-pressed={isSelectable ? isSelected : undefined}
                      onClick={
                        isSelectable
                          ? () => setSelectedFilamentSlot(isSelected ? null : slot.slot)
                          : undefined
                      }
                      onKeyDown={
                        isSelectable
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedFilamentSlot(isSelected ? null : slot.slot);
                              }
                            }
                          : undefined
                      }
                      className={`rounded-lg border p-3 transition-colors ${
                        isSelectable ? 'cursor-pointer hover:border-primary/60' : ''
                      } ${
                        isSelected
                          ? 'border-primary ring-2 ring-primary/40'
                          : 'border-border'
                      }`}
                    >
                      <div className="flex h-full flex-col gap-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-10 w-8 items-center justify-center">
                            <FilamentSpoolIcon color={slot.color} />
                          </div>
                          <div>
                            <div className="font-medium">
                              {slot.label ?? `${isBambuProfile(printer.profile) ? 'Slot' : 'Tool'} ${slot.slot}`}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {`${slot.vendor} ${slot.type}`.trim()}{slot.subType ? ` / ${slot.subType}` : ''}
                            </div>
                          </div>
                        </div>
                        {typeof slot.weight === 'number' && slot.weight > 0 && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Remaining</span>
                              <span className={`${READOUT} font-medium`}>
                                {formatMaxTwoDecimals(slot.remaining ?? 0)}% · {formatMaxTwoDecimals(slot.weight)}g
                              </span>
                            </div>
                            <Progress value={slot.remaining ?? 0} className="h-2" />
                          </div>
                        )}
                        <div className="mt-auto flex flex-wrap items-center gap-2">
                          <Badge variant={slot.isLoaded ? 'outline' : 'secondary'}>
                            {slot.isLoaded ? 'Loaded' : 'Empty'}
                          </Badge>
                          {slot.isInUse && <Badge>In Use</Badge>}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
                {(canControlFilament || canEditFilament) && (
                  <div className="mt-4 border-t border-border pt-4">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {selectedSlot
                        ? `Selected: ${selectedSlot.label ?? `${isBambuProfile(printer.profile) ? 'Slot' : 'Tool'} ${selectedSlot.slot}`}`
                        : 'Select a filament spool above to load, unload, or edit it.'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {canControlFilament && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={`h-8 gap-1 px-3 text-xs ${CONTROL_GLOW}`}
                            disabled={!selectedSlot || filamentControlsDisabled}
                            onClick={() => selectedSlot && handleFilamentAction('load', selectedSlot)}
                          >
                            <ArrowDownToLine className="size-3.5" />
                            {selectedSlot && filamentInFlight === `load-${selectedSlot.slot}` ? '…' : 'Load'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={`h-8 gap-1 px-3 text-xs ${CONTROL_GLOW}`}
                            disabled={!selectedSlot || filamentControlsDisabled}
                            onClick={() => selectedSlot && handleFilamentAction('unload', selectedSlot)}
                          >
                            <ArrowUpFromLine className="size-3.5" />
                            {selectedSlot && filamentInFlight === `unload-${selectedSlot.slot}` ? '…' : 'Unload'}
                          </Button>
                        </>
                      )}
                      {canEditFilament && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={`h-8 gap-1 px-3 text-xs ${CONTROL_GLOW}`}
                          disabled={!selectedSlot}
                          onClick={() => selectedSlot && openFilamentEdit(selectedSlot)}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No live filament status available.
              </p>
            )}
          </Card>
          ),
          cooling:
            canControlPrinter && printerSupportsCoolingControl(printer) ? (
            <Card className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <Fan className="size-5" />
                  Cooling
                </h2>
                {supportsAirFilter && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Air Filter</span>
                    <Switch
                      checked={airFilterOn}
                      disabled={!canControlCooling || airFilterInFlight}
                      onCheckedChange={handleToggleAirFilter}
                      aria-label="Air filter"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-5">
                {printerFans.map((fan) => {
                  const value = fanInputs[fan.id] ?? 0;
                  return (
                    <div key={`${printer.id}-fan-${fan.id}`}>
                      <div className="flex justify-between items-center gap-2 mb-2">
                        <span className="text-sm text-muted-foreground">{fan.label}</span>
                        <span className={`${READOUT} font-bold text-lg`}>
                          {formatMaxTwoDecimals(value)}%
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <Slider
                          value={[value]}
                          min={0}
                          max={100}
                          step={1}
                          disabled={!canControlCooling || fanInFlight === fan.id}
                          aria-label={`${fan.label} fan speed`}
                          onValueChange={(next) =>
                            setFanInputs((prev) => ({ ...prev, [fan.id]: next[0] ?? 0 }))
                          }
                          onValueCommit={(next) => handleSetFan(fan, next[0] ?? 0)}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={`h-8 px-3 ${CONTROL_GLOW}`}
                          disabled={!canControlCooling || fanInFlight === fan.id || value === 0}
                          onClick={() => handleSetFan(fan, 0)}
                        >
                          {fanInFlight === fan.id ? '…' : 'Off'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!isOnline && (
                  <p className="text-sm text-muted-foreground">
                    Connect the printer to control its cooling fans.
                  </p>
                )}
              </div>
            </Card>
          ) : null,
          motion: canControlMotion ? (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Move className="size-5" />
                Motion Control
              </h2>
              <div className="space-y-5">
                <div>
                  <div className="text-sm text-muted-foreground mb-2">Step size (mm)</div>
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
                    <div className="mt-2 text-center text-xs text-muted-foreground">X / Y</div>
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
                    <div className="mt-2 text-center text-xs text-muted-foreground">Z</div>
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

                {!isMotionReady && !isOnline && (
                  <p className="text-sm text-muted-foreground">
                    Connect the printer to control its motion.
                  </p>
                )}
              </div>
            </Card>
          ) : null,
          information: (
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Information</h2>
            <div className="space-y-3">
              {canViewIpAddress && (
                <div className="flex items-start gap-2">
                  <Network className="size-4 mt-0.5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-sm text-muted-foreground">IP Address</div>
                    <div className={`${READOUT} font-medium`}>{printer.ipAddress}</div>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <CheckCircle className="size-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm text-muted-foreground">Connection</div>
                  <div className="font-medium capitalize">
                    {isOnline ? 'online' : 'offline'}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Activity className="size-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm text-muted-foreground">Activity</div>
                  <div className="font-medium capitalize">{activityLabel}</div>
                </div>
              </div>
              {canViewSensitiveInfo && (
                <div className="flex items-start gap-2">
                  <Activity className="size-4 mt-0.5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-sm text-muted-foreground">Profile</div>
                    <div className="font-medium">{printer.profile}</div>
                  </div>
                </div>
              )}
              {canViewSensitiveInfo && (
                <div className="flex items-start gap-2">
                  <KeyRound className="size-4 mt-0.5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-sm text-muted-foreground">
                      {PRINTER_PROFILES[printer.profile]?.credentialLabel ?? 'API Key Header'}
                    </div>
                    {user?.role === 'admin' && printer.apiKeyHeader ? (
                      <div className="flex items-center gap-2">
                        <span className="font-medium font-mono break-all">
                          {showCredential ? printer.apiKeyHeader : '••••••••'}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowCredential((v) => !v)}
                          className="text-muted-foreground hover:text-foreground flex-shrink-0"
                          aria-label={showCredential ? 'Hide credential' : 'Show credential'}
                        >
                          {showCredential ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                      </div>
                    ) : (
                      <div className="font-medium">
                        {printer.apiKeyHeader ? 'Configured' : 'Not configured'}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <Wrench className="size-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm text-muted-foreground">Last Maintenance</div>
                  <div className="font-medium">
                    {printer.lastMaintenanceAt
                      ? new Date(printer.lastMaintenanceAt).toLocaleString()
                      : printer.lastMaintenance}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Clock className="size-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm text-muted-foreground">Total Print Time</div>
                  <div className={`${READOUT} font-medium`}>
                    {formatMaxTwoDecimals(printer.totalPrintTime)}h
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="size-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm text-muted-foreground">Success Rate</div>
                  <div className={`${READOUT} font-medium`}>
                    {formatMaxTwoDecimals(printer.successRate)}%
                  </div>
                </div>
              </div>
              {user?.role === 'admin' && (
                <div className="space-y-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className={`w-full ${CONTROL_GLOW}`}
                    onClick={openEditDialog}
                  >
                    <Pencil className="mr-2 size-4" />
                    Edit Printer
                  </Button>
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
                </div>
              )}
            </div>
          </Card>
          ),
          statusLight: <StatusLightCard printerId={printer.id} printerName={printer.name} />,
        }}
      />

      {user?.role === 'admin' && editDraft && (
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Printer</DialogTitle>
              <DialogDescription>
                Update this printer's information. Connection changes take effect on the next status check.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSavePrinterInfo} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="edit-printer-name">Printer Name</Label>
                  <Input
                    id="edit-printer-name"
                    value={editDraft.name}
                    onChange={(event) =>
                      setEditDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))
                    }
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-printer-model">Model</Label>
                  <Input
                    id="edit-printer-model"
                    value={editDraft.model}
                    onChange={(event) =>
                      setEditDraft((prev) => (prev ? { ...prev, model: event.target.value } : prev))
                    }
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="edit-printer-ip">Printer IP</Label>
                  <Input
                    id="edit-printer-ip"
                    value={editDraft.ipAddress}
                    onChange={(event) =>
                      setEditDraft((prev) =>
                        prev ? { ...prev, ipAddress: event.target.value.trim() } : prev,
                      )
                    }
                    placeholder="192.168.1.120"
                    inputMode="numeric"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-printer-credential">
                    {PRINTER_PROFILES[printer.profile].credentialLabel}
                  </Label>
                  <Input
                    id="edit-printer-credential"
                    type="password"
                    value={editDraft.apiKeyHeader}
                    onChange={(event) =>
                      setEditDraft((prev) =>
                        prev ? { ...prev, apiKeyHeader: event.target.value } : prev,
                      )
                    }
                    placeholder={PRINTER_PROFILES[printer.profile].credentialPlaceholder}
                    autoComplete="off"
                    required
                  />
                </div>
              </div>

              {isBambuProfile(printer.profile) && (
                <div className="space-y-2">
                  <Label htmlFor="edit-printer-serial">Serial Number</Label>
                  <Input
                    id="edit-printer-serial"
                    value={editDraft.serial}
                    onChange={(event) =>
                      setEditDraft((prev) =>
                        prev ? { ...prev, serial: event.target.value.trim() } : prev,
                      )
                    }
                    placeholder="e.g. 0309CA000000000"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>
              )}

              {isH2Profile(printer.profile) && (
                <div className="space-y-2">
                  <Label htmlFor="edit-printer-callback-url">Printer callback URL (override)</Label>
                  <p className="text-xs text-muted-foreground">
                    This printer's firmware fetches a staged print file back from the
                    farm server over HTTP rather than accepting an FTP write. Set a LAN
                    address <span className="font-medium">this printer</span> can reach
                    (e.g. <code>http://192.168.1.50:8080</code>) if it's on a different
                    subnet than the site-wide default in Settings → Slicer Upload. Leave
                    blank to use that default.
                  </p>
                  <Input
                    id="edit-printer-callback-url"
                    value={editDraft.callbackUrl}
                    onChange={(event) =>
                      setEditDraft((prev) =>
                        prev ? { ...prev, callbackUrl: event.target.value.trim() } : prev,
                      )
                    }
                    placeholder="http://192.168.1.50:8080"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="edit-printer-maintenance">Last Maintenance</Label>
                <Input
                  id="edit-printer-maintenance"
                  type="date"
                  value={editDraft.lastMaintenance}
                  onChange={(event) =>
                    setEditDraft((prev) =>
                      prev ? { ...prev, lastMaintenance: event.target.value } : prev,
                    )
                  }
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditOpen(false)}
                  disabled={editSaving}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={editSaving}>
                  {editSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {canEditFilament && (
        <Dialog
          open={filamentEditSlot !== null}
          onOpenChange={(open) => {
            if (!open) setFilamentEditSlot(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Filament</DialogTitle>
              <DialogDescription>
                {filamentEditSlot
                  ? `Set the vendor, material and color for ${
                      filamentEditSlot.label ??
                      `${isBambuProfile(printer.profile) ? 'Slot' : 'Tool'} ${filamentEditSlot.slot}`
                    }.`
                  : ''}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="filament-vendor">Vendor</Label>
                <Select
                  value={filamentEditDraft.vendor}
                  onValueChange={(value) =>
                    setFilamentEditDraft((draft) => ({
                      ...draft,
                      vendor: value,
                    }))
                  }
                >
                  <SelectTrigger id="filament-vendor">
                    <SelectValue placeholder="Select vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {FILAMENT_VENDORS.map((vendor) => (
                      <SelectItem key={vendor} value={vendor}>
                        {vendor}
                      </SelectItem>
                    ))}
                    {/* Keep a current vendor that isn't in the preset list (e.g. one
                        reported back by a Bambu spool) selectable rather than dropped. */}
                    {filamentEditDraft.vendor &&
                      !FILAMENT_VENDORS.includes(
                        filamentEditDraft.vendor as (typeof FILAMENT_VENDORS)[number],
                      ) && (
                        <SelectItem value={filamentEditDraft.vendor}>
                          {filamentEditDraft.vendor}
                        </SelectItem>
                      )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filament-type">Material</Label>
                <Select
                  value={filamentEditDraft.type}
                  onValueChange={(value) =>
                    setFilamentEditDraft((draft) => ({ ...draft, type: value }))
                  }
                >
                  <SelectTrigger id="filament-type">
                    <SelectValue placeholder="Select material" />
                  </SelectTrigger>
                  <SelectContent>
                    {FILAMENT_MATERIALS.map((material) => (
                      <SelectItem key={material} value={material}>
                        {material}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filament-color">Color</Label>
                <div className="flex items-center gap-3">
                  <input
                    id="filament-color"
                    type="color"
                    value={filamentEditDraft.color}
                    onChange={(event) =>
                      setFilamentEditDraft((draft) => ({ ...draft, color: event.target.value }))
                    }
                    className="h-10 w-16 cursor-pointer rounded border border-input bg-transparent"
                  />
                  <Input
                    value={filamentEditDraft.color}
                    onChange={(event) =>
                      setFilamentEditDraft((draft) => ({ ...draft, color: event.target.value }))
                    }
                    className="w-32"
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFilamentEditSlot(null)}>
                Cancel
              </Button>
              <Button onClick={saveFilamentEdit} disabled={filamentEditSaving}>
                {filamentEditSaving ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
