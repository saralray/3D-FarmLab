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
  type MqttTransport,
  type StatusLightProvisioningInfo,
} from '../lib/statusLightApi';
import { STATUS_LIGHT_FIRMWARE_SOURCE } from '../lib/statusLightFirmwareSource';
import { SerialTerminal } from './SerialTerminal';
import {
  connectToDevice,
  flashOnDevice,
  provisionDevice,
  requestSerialPort,
  type DeviceConnection,
  type SerialPortLike,
} from '../lib/statusLightSerial';

type Step = 'intro' | 'ready' | 'form' | 'flashing' | 'writing' | 'done';

interface StatusLightFlashDialogProps {
  mode: 'flash' | 'provision';
  printerId: string;
  printerName: string;
  onClose: () => void;
}

function defaultTransport(): MqttTransport {
  return window.location.protocol === 'https:' ? 'wss' : 'tcp';
}

function defaultPortFor(transport: MqttTransport, provisioning: StatusLightProvisioningInfo | null): number {
  if (transport === 'tcp') {
    return provisioning?.mqttPort ?? 1883;
  }
  const pagePort = Number.parseInt(window.location.port, 10);
  if (Number.isFinite(pagePort) && pagePort > 0) {
    return pagePort;
  }
  return transport === 'wss' ? 443 : 80;
}

// Stepper dialog: pick the USB serial device, optionally flash the merged
// firmware image, then ask for WiFi + broker settings and write the
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
  const [chipName, setChipName] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Live serial output shown during provisioning (device boot banner, WiFi/
  // broker connection, JSON replies), bounded so it can't grow without limit.
  const [serialLog, setSerialLog] = useState('');

  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [transport, setTransport] = useState<MqttTransport>(defaultTransport);
  const [mqttHost, setMqttHost] = useState(() => window.location.hostname);
  const [mqttPort, setMqttPort] = useState(() => String(defaultPortFor(defaultTransport(), null)));
  const [ledPolarity, setLedPolarity] = useState<LedPolarity>('common_cathode');
  const [sourceFileIndex, setSourceFileIndex] = useState(0);
  const [sourceCopied, setSourceCopied] = useState(false);

  const portRef = useRef<SerialPortLike | null>(null);
  // The connected esptool transport/loader, held across the 'ready' step so a
  // failed flash can be retried without re-picking the device (see runFlash).
  const connectionRef = useRef<DeviceConnection | null>(null);

  useEffect(() => {
    fetchStatusLightProvisioning()
      .then((info) => {
        setProvisioning(info);
        setMqttPort((current) =>
          current === String(defaultPortFor(defaultTransport(), null))
            ? String(defaultPortFor(defaultTransport(), info))
            : current,
        );
      })
      .catch((err: Error) => setProvisioningError(err.message));
    if (mode === 'flash') {
      checkFirmwareAvailable().then(setFirmwareAvailable);
    }
  }, [mode]);

  const brokerDisabled = provisioning !== null && provisioning.enabled === false;
  // Gates the serial-port picker for flows that don't flash over the browser
  // (manual esptool flash, or re-provisioning an already-flashed device) —
  // those only need the broker credential, not the hosted firmware image.
  const provisioningBlocked = brokerDisabled || provisioningError !== null;
  const introBlocked = provisioningBlocked || (mode === 'flash' && firmwareAvailable === false);

  const introNotice = useMemo(() => {
    if (provisioningError) {
      return `Could not load the broker credential: ${provisioningError}`;
    }
    if (brokerDisabled) {
      return 'The status-light MQTT broker is disabled on this server (STATUS_LIGHT_MQTT_ENABLED=false).';
    }
    if (mode === 'flash' && firmwareAvailable === false) {
      return 'The firmware image has not been built yet — build firmware/status-light with PlatformIO first (see its README), then rebuild the web image.';
    }
    return null;
  }, [provisioningError, brokerDisabled, mode, firmwareAvailable]);

  const handleTransportChange = (next: MqttTransport) => {
    setTransport(next);
    setMqttPort(String(defaultPortFor(next, provisioning)));
  };

  const handleCopySource = async () => {
    try {
      await navigator.clipboard.writeText(STATUS_LIGHT_FIRMWARE_SOURCE[sourceFileIndex].content);
      setSourceCopied(true);
      setTimeout(() => setSourceCopied(false), 1500);
    } catch {
      // Clipboard permission denied/unavailable — the code is still selectable by hand.
    }
  };

  // Flashes the merged firmware image on the already-connected device (see
  // handleStart), then hands off to the settings form — mirrors the
  // standalone flasher's connect → flash → configure order, so BOOT-holding
  // and flashing happen before the user is asked for WiFi/broker details, not
  // after. Only ever called from the 'ready' step's explicit Flash button —
  // never automatically right after connecting — so there's always a
  // human-paced gap between the baud-rate change (which happened during
  // connect) and the sustained high-throughput compressed write starting; the
  // standalone flasher gets this for free from its own separate Connect/Flash
  // buttons.
  const runFlash = async () => {
    const connection = connectionRef.current;
    if (!connection) {
      setError('Device is not connected — go back and select it again.');
      setStep('intro');
      return;
    }
    setStep('flashing');
    setFlashProgress(0);
    try {
      const firmware = await fetchFirmwareBinary();
      await flashOnDevice(connection, firmware, ({ written, total }) => {
        setFlashProgress(total > 0 ? Math.round((written / total) * 100) : 0);
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} — if the device wasn't detected, hold BOOT while plugging it in and retry.`
          : String(err),
      );
      // flashOnDevice leaves the transport open on failure (matching the
      // standalone flasher) so Flash Firmware can just be clicked again
      // without re-picking the device or reconnecting.
      setStep('ready');
      return;
    }
    setStep('form');
  };

  const handleStart = async () => {
    setError(null);
    let port: SerialPortLike;
    try {
      port = await requestSerialPort();
    } catch {
      return; // user cancelled the port picker
    }
    portRef.current = port;
    if (mode === 'flash' && flashMethod === 'web') {
      // Mirrors the standalone flasher's Connect button: request the port and
      // sync the ROM bootloader (with retry-on-busy) together, show the
      // detected chip, and require a separate Flash click before the actual
      // (fragile) compressed write begins.
      try {
        const connection = await connectToDevice(port);
        connectionRef.current = connection;
        setChipName(connection.chipName);
        setStep('ready');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        portRef.current = null;
        setStep('intro');
      }
    } else {
      // Re-provisioning, or firmware already flashed manually: no in-browser
      // flash step, go straight to the settings form.
      setStep('form');
    }
  };

  const handleSubmit = async () => {
    const port = portRef.current;
    if (!port || !provisioning?.username || !provisioning.password) {
      setError('Missing serial port or broker credential.');
      return;
    }
    const portNumber = Number.parseInt(mqttPort, 10);
    if (!wifiSsid.trim() || !mqttHost.trim() || !Number.isFinite(portNumber) || portNumber <= 0) {
      setError('WiFi SSID, MQTT host, and a valid port are required.');
      return;
    }
    setError(null);
    setStep('writing');
    try {
      const outcome = await provisionDevice(
        port,
        {
          wifiSsid: wifiSsid.trim(),
          wifiPassword,
          mqttTransport: transport,
          mqttHost: mqttHost.trim(),
          mqttPort: portNumber,
          mqttPath: provisioning.wsPath ?? '/mqtt',
          mqttUsername: provisioning.username,
          mqttPassword: provisioning.password,
          printerId,
          ledPolarity,
        },
        {
          // Surface exactly what the device emits during provisioning in the
          // on-screen serial log so a failed flash/provision is diagnosable.
          onRaw: (text) =>
            setSerialLog((prev) => {
              const next = prev + text;
              return next.length > 64_000 ? next.slice(next.length - 64_000) : next;
            }),
        },
      );
      setResult(
        outcome.ok
          ? { ok: true, message: 'Settings written — the device will connect and light up shortly.' }
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
              ? 'Writes new WiFi and broker settings to an already-flashed device over USB.'
              : flashMethod === 'manual'
                ? "Writes WiFi and broker settings to a device you've flashed yourself."
                : 'Flashes the ESP32-C3 firmware over USB, then writes the WiFi and broker settings.'}
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
                  Flashes over USB right from this browser (Chrome/Edge), then sends WiFi and broker
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
                  then come back here to send WiFi and broker settings.
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
              broker settings.
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

        {step === 'ready' && (
          <div className="space-y-4">
            {chipName && (
              <p className="text-sm text-muted-foreground">
                Detected: <span className="font-medium text-foreground">{chipName}</span>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Hold the ESP32's BOOT button now, then click Flash — release it once the progress bar
              starts moving.
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  connectionRef.current?.transport.disconnect().catch(() => {});
                  connectionRef.current = null;
                  setChipName(null);
                  setStep('intro');
                }}
              >
                Back
              </Button>
              <Button onClick={runFlash}>Flash Firmware</Button>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Connection</Label>
                <Select value={transport} onValueChange={(value) => handleTransportChange(value as MqttTransport)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">MQTT (LAN, port {String(provisioning?.mqttPort ?? 1883)})</SelectItem>
                    <SelectItem value="ws">WebSocket (http)</SelectItem>
                    <SelectItem value="wss">WebSocket (https)</SelectItem>
                  </SelectContent>
                </Select>
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
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="space-y-2">
                <Label htmlFor="status-light-host">MQTT host</Label>
                <Input
                  id="status-light-host"
                  value={mqttHost}
                  onChange={(event) => setMqttHost(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status-light-port">Port</Label>
                <Input
                  id="status-light-port"
                  inputMode="numeric"
                  value={mqttPort}
                  onChange={(event) => setMqttPort(event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The device must be able to reach this address from its WiFi network. Use MQTT (LAN) when
              the server is on the same network; use WebSocket when only the website is reachable.
            </p>
            <p className="text-xs text-muted-foreground">
              The broker username and password are filled in automatically from this server's shared
              status-light credential — nothing to type here.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>Send settings &amp; connect</Button>
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
              Writing settings…
            </p>
            <SerialTerminal content={serialLog} emptyHint="Waiting for the device to respond…" />
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
            {serialLog && <SerialTerminal content={serialLog} />}
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
