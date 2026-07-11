import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle, Copy, Loader2, Usb, Wrench } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Progress } from './ui/progress';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  checkFirmwareAvailable,
  fetchFirmwareBinary,
  fetchStatusLightProvisioning,
  type LedPolarity,
  type StatusLightProvisioningInfo,
} from '../lib/statusLightApi';
import { STATUS_LIGHT_FIRMWARE_SOURCE } from '../lib/statusLightFirmwareSource';
import {
  flashFirmware,
  provisionDevice,
  requestSerialPort,
  type NetConnectionState,
  type SerialPortLike,
} from '../lib/statusLightSerial';

type Step = 'intro' | 'form' | 'flashing' | 'writing' | 'done';

const NET_STATUS_LABEL: Record<NetConnectionState, string> = {
  idle: 'Writing settings…',
  'wifi-connecting': 'Connecting to WiFi…',
  polling: 'Reaching the dashboard…',
  connected: 'Connected!',
};

const DEFAULT_POLL_INTERVAL_MS = 5000;

interface StatusLightFlashDialogProps {
  mode: 'flash' | 'provision';
  printerId: string;
  printerName: string;
  onClose: () => void;
}

// Stepper dialog: pick the USB serial device, optionally flash the merged
// firmware image, then ask for WiFi + server settings and write the
// provisioning JSON over serial (firmware protocol in
// firmware/status-light/README.md).
export function StatusLightFlashDialog({ mode, printerId, printerName, onClose }: StatusLightFlashDialogProps) {
  const [step, setStep] = useState<Step>('intro');
  // Only meaningful when mode === 'flash': null until the user picks how
  // they want to get firmware onto the device. 'provision' mode never
  // flashes, so it's pinned to 'web' (the shared serial-port/settings flow).
  const [flashMethod, setFlashMethod] = useState<'web' | 'manual' | null>(mode === 'flash' ? null : 'web');
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState<StatusLightProvisioningInfo | null>(null);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const [firmwareAvailable, setFirmwareAvailable] = useState<boolean | null>(mode === 'flash' ? null : true);
  const [flashProgress, setFlashProgress] = useState(0);
  const [netStatus, setNetStatus] = useState<NetConnectionState>('idle');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [serverUrl, setServerUrl] = useState(() => window.location.origin);
  const [pollInterval, setPollInterval] = useState(String(DEFAULT_POLL_INTERVAL_MS));
  const [ledPolarity, setLedPolarity] = useState<LedPolarity>('common_cathode');
  const [sourceFileIndex, setSourceFileIndex] = useState(0);
  const [sourceCopied, setSourceCopied] = useState(false);

  const portRef = useRef<SerialPortLike | null>(null);

  useEffect(() => {
    fetchStatusLightProvisioning()
      .then((info) => {
        setProvisioning(info);
        if (info.pollIntervalMs) {
          setPollInterval((current) =>
            current === String(DEFAULT_POLL_INTERVAL_MS) ? String(info.pollIntervalMs) : current,
          );
        }
      })
      .catch((err: Error) => setProvisioningError(err.message));
    if (mode === 'flash') {
      checkFirmwareAvailable().then(setFirmwareAvailable);
    }
  }, [mode]);

  const featureDisabled = provisioning !== null && provisioning.enabled === false;
  // Gates the serial-port picker for flows that don't flash over the browser
  // (manual esptool flash, or re-provisioning an already-flashed device).
  const provisioningBlocked = featureDisabled || provisioningError !== null;
  const introBlocked = provisioningBlocked || (mode === 'flash' && firmwareAvailable === false);

  const introNotice = useMemo(() => {
    if (provisioningError) {
      return `Could not load the status-light settings: ${provisioningError}`;
    }
    if (featureDisabled) {
      return 'The status-light feature is disabled on this server (STATUS_LIGHT_ENABLED=false).';
    }
    if (mode === 'flash' && firmwareAvailable === false) {
      return 'The firmware image has not been built yet — build firmware/status-light with PlatformIO first (see its README), then rebuild the web image.';
    }
    return null;
  }, [provisioningError, featureDisabled, mode, firmwareAvailable]);

  const handleCopySource = async () => {
    try {
      await navigator.clipboard.writeText(STATUS_LIGHT_FIRMWARE_SOURCE[sourceFileIndex].content);
      setSourceCopied(true);
      setTimeout(() => setSourceCopied(false), 1500);
    } catch {
      // Clipboard permission denied/unavailable — the code is still selectable by hand.
    }
  };

  const handleStart = async () => {
    setError(null);
    try {
      portRef.current = await requestSerialPort();
    } catch {
      return; // user cancelled the port picker
    }
    // WiFi/server settings are collected before flashing, not after — that
    // way a flash immediately rolls into provisioning with no extra dialog
    // in between (and holding BOOT for the flash is the very next click).
    setStep('form');
  };

  const handleSubmit = async () => {
    const port = portRef.current;
    if (!port) {
      setError('No serial port selected.');
      return;
    }
    const trimmedUrl = serverUrl.trim().replace(/\/+$/, '');
    const intervalNumber = Number.parseInt(pollInterval, 10);
    if (!wifiSsid.trim() || !/^https?:\/\/.+/i.test(trimmedUrl)) {
      setError('WiFi SSID and a server URL (http:// or https://) are required.');
      return;
    }
    const pollIntervalMs = Number.isFinite(intervalNumber) && intervalNumber >= 1000 ? intervalNumber : DEFAULT_POLL_INTERVAL_MS;
    setError(null);

    if (mode === 'flash' && flashMethod === 'web') {
      setStep('flashing');
      setFlashProgress(0);
      try {
        const firmware = await fetchFirmwareBinary();
        await flashFirmware(port, firmware, ({ written, total }) => {
          setFlashProgress(total > 0 ? Math.round((written / total) * 100) : 0);
        });
        // Give the freshly flashed firmware a moment to boot its USB CDC
        // before we reopen the port for provisioning — the C3's native USB
        // fully drops and re-enumerates after the post-flash reset, which
        // can take a few seconds.
        await new Promise((resolve) => setTimeout(resolve, 4000));
      } catch (err) {
        setError(
          err instanceof Error
            ? `${err.message} — if the device wasn't detected, hold BOOT while plugging it in and retry.`
            : String(err),
        );
        setStep('form');
        return;
      }
    }

    setNetStatus('idle');
    setStep('writing');
    try {
      const outcome = await provisionDevice(
        port,
        {
          wifiSsid: wifiSsid.trim(),
          wifiPassword,
          serverUrl: trimmedUrl,
          pollIntervalMs,
          printerId,
          ledPolarity,
        },
        {
          onStatus: setNetStatus,
          // Surface exactly what the device emits during provisioning so a
          // failed flash/provision is diagnosable from the browser console.
          onRaw: (text) => console.debug('[status-light serial]', JSON.stringify(text)),
        },
      );
      setResult(
        outcome.ok
          ? {
              ok: true,
              message:
                outcome.net === 'connected'
                  ? 'Device provisioned and connected — it will light up with the printer status.'
                  : "Settings written, but the device hasn't reached the dashboard yet — double-check the WiFi password and server URL. It will keep retrying on its own.",
            }
          : { ok: false, message: outcome.error || 'The device rejected the configuration.' },
      );
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('form');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={
          mode === 'flash' && flashMethod === 'manual' && step === 'intro' ? 'sm:max-w-xl' : 'sm:max-w-md'
        }
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'flash' ? 'Flash status light' : 'Re-provision status light'} — {printerName}
          </DialogTitle>
          <DialogDescription>
            {mode === 'provision'
              ? 'Writes new WiFi and server settings to an already-flashed device over USB.'
              : flashMethod === 'manual'
                ? "Writes WiFi and server settings to a device you've flashed yourself."
                : 'Flashes the ESP32-C3 firmware over USB, then writes the WiFi and server settings.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {step === 'intro' && mode === 'flash' && flashMethod === null && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Choose how to get the firmware onto the device.</p>
            <button
              type="button"
              onClick={() => setFlashMethod('web')}
              className="w-full flex items-start gap-3 rounded-md border p-3 text-left hover:bg-accent"
            >
              <Usb className="size-4 shrink-0 mt-0.5" />
              <span>
                <span className="block text-sm font-medium">Use the web flasher</span>
                <span className="block text-xs text-muted-foreground">
                  Flashes over USB right from this browser (Chrome/Edge), then sends WiFi and server
                  settings.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFlashMethod('manual')}
              className="w-full flex items-start gap-3 rounded-md border p-3 text-left hover:bg-accent"
            >
              <Wrench className="size-4 shrink-0 mt-0.5" />
              <span>
                <span className="block text-sm font-medium">I'll flash it myself</span>
                <span className="block text-xs text-muted-foreground">
                  View the firmware source, build it yourself (PlatformIO), and flash it with esptool,
                  then come back here to send WiFi and server settings.
                </span>
              </span>
            </button>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'intro' && mode === 'flash' && flashMethod === 'manual' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Copy these files into a PlatformIO project (matching <code>firmware/status-light/</code> —
              see its README), run <code>pio run</code>, then flash the build output at offset{' '}
              <code>0x0</code>:
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
              esptool.py --chip esp32c3 write_flash 0x0 .pio/build/esp32c3/firmware.bin
            </pre>
            <div className="space-y-2">
              <Select
                value={String(sourceFileIndex)}
                onValueChange={(value) => {
                  setSourceFileIndex(Number(value));
                  setSourceCopied(false);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_LIGHT_FIRMWARE_SOURCE.map((file, index) => (
                    <SelectItem key={file.path} value={String(index)}>
                      {file.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative">
                <ScrollArea className="h-64 rounded-md border bg-muted">
                  <pre className="p-3 text-xs">
                    <code>{STATUS_LIGHT_FIRMWARE_SOURCE[sourceFileIndex].content}</code>
                  </pre>
                </ScrollArea>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="absolute top-2 right-4"
                  onClick={handleCopySource}
                >
                  {sourceCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {sourceCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Once it's flashed, plug the device back in and pick its serial port to send WiFi and
              server settings.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFlashMethod(null)}>
                Back
              </Button>
              <Button onClick={handleStart} disabled={provisioningBlocked}>
                Select device
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'intro' && (mode === 'provision' || flashMethod === 'web') && (
          <div className="space-y-4">
            {introNotice ? (
              <p className="text-sm text-muted-foreground">{introNotice}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect the ESP32-C3 Super Mini over USB, then pick its serial port. If the browser
                doesn't list it, hold the BOOT button while plugging it in.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => (mode === 'flash' ? setFlashMethod(null) : onClose())}>
                {mode === 'flash' ? 'Back' : 'Cancel'}
              </Button>
              <Button onClick={handleStart} disabled={introBlocked || (mode === 'flash' && firmwareAvailable === null)}>
                Select device
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'form' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="status-light-ssid">WiFi network (SSID)</Label>
              <Input
                id="status-light-ssid"
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="Lab-WiFi"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status-light-password">WiFi password</Label>
              <Input
                id="status-light-password"
                type="password"
                value={wifiPassword}
                onChange={(event) => setWifiPassword(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="space-y-2">
                <Label htmlFor="status-light-server">Server URL</Label>
                <Input
                  id="status-light-server"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="http://10.0.0.5:8080"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status-light-interval">Poll (ms)</Label>
                <Input
                  id="status-light-interval"
                  inputMode="numeric"
                  value={pollInterval}
                  onChange={(event) => setPollInterval(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>LED type</Label>
              <Select value={ledPolarity} onValueChange={(value) => setLedPolarity(value as LedPolarity)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="common_cathode">Common cathode</SelectItem>
                  <SelectItem value="common_anode">Common anode</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              The device must be able to reach this dashboard URL from its WiFi network. Use an
              http:// or https:// address (https validates against public CAs, so use http on a LAN
              with a self-signed cert).
            </p>
            {mode === 'flash' && flashMethod === 'web' && (
              <p className="text-xs text-muted-foreground">
                Hold the ESP32's BOOT button now, then click Flash — release it once the progress bar
                starts moving.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>
                {mode === 'flash' && flashMethod === 'web' ? 'Flash & connect' : 'Send settings & connect'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'flashing' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Flashing firmware… keep the device plugged in.
            </p>
            <Progress value={flashProgress} />
            <p className="text-sm text-muted-foreground text-right">{flashProgress}%</p>
          </div>
        )}

        {step === 'writing' && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {NET_STATUS_LABEL[netStatus]}
            </p>
            {netStatus !== 'idle' && netStatus !== 'connected' && (
              <p className="text-xs text-muted-foreground">
                Checking the device's connection to the dashboard — this can take a few seconds.
              </p>
            )}
          </div>
        )}

        {step === 'done' && result && (
          <div className="space-y-4">
            <div
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                result.ok
                  ? 'border-green-600/40 bg-green-500/10'
                  : 'border-destructive/50 bg-destructive/10 text-destructive'
              }`}
            >
              {result.ok ? (
                <CheckCircle className="size-4 shrink-0 mt-0.5 text-green-600" />
              ) : (
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
              )}
              <span className="break-words">{result.message}</span>
            </div>
            <DialogFooter>
              {!result.ok && (
                <Button variant="outline" onClick={() => setStep('form')}>
                  Back
                </Button>
              )}
              <Button onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
