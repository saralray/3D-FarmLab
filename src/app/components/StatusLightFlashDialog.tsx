import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
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
import {
  flashFirmware,
  provisionDevice,
  requestSerialPort,
  type SerialPortLike,
} from '../lib/statusLightSerial';

type Step = 'intro' | 'flashing' | 'form' | 'writing' | 'done';

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
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState<StatusLightProvisioningInfo | null>(null);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const [firmwareAvailable, setFirmwareAvailable] = useState<boolean | null>(mode === 'flash' ? null : true);
  const [flashProgress, setFlashProgress] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [transport, setTransport] = useState<MqttTransport>(defaultTransport);
  const [mqttHost, setMqttHost] = useState(() => window.location.hostname);
  const [mqttPort, setMqttPort] = useState(() => String(defaultPortFor(defaultTransport(), null)));
  const [ledPolarity, setLedPolarity] = useState<LedPolarity>('common_cathode');

  const portRef = useRef<SerialPortLike | null>(null);

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
  const introBlocked =
    brokerDisabled || provisioningError !== null || (mode === 'flash' && firmwareAvailable === false);

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

  const handleStart = async () => {
    setError(null);
    try {
      portRef.current = await requestSerialPort();
    } catch {
      return; // user cancelled the port picker
    }
    if (mode === 'flash') {
      setStep('flashing');
      setFlashProgress(0);
      try {
        const firmware = await fetchFirmwareBinary();
        await flashFirmware(portRef.current, firmware, ({ written, total }) => {
          setFlashProgress(total > 0 ? Math.round((written / total) * 100) : 0);
        });
        // Give the freshly flashed firmware a moment to boot its USB CDC
        // before we reopen the port for provisioning.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        setStep('form');
      } catch (err) {
        setError(
          err instanceof Error
            ? `${err.message} — if the device wasn't detected, hold BOOT while plugging it in and retry.`
            : String(err),
        );
        setStep('intro');
      }
    } else {
      setStep('form');
    }
  };

  const handleProvision = async () => {
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
      const outcome = await provisionDevice(port, {
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
      });
      setResult(
        outcome.ok
          ? { ok: true, message: 'Device provisioned. It will join WiFi and light up with the printer status.' }
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'flash' ? 'Flash status light' : 'Re-provision status light'} — {printerName}
          </DialogTitle>
          <DialogDescription>
            {mode === 'flash'
              ? 'Flashes the ESP32-C3 firmware over USB, then writes the WiFi and broker settings.'
              : 'Writes new WiFi and broker settings to an already-flashed device over USB.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {step === 'intro' && (
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
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={introBlocked || (mode === 'flash' && firmwareAvailable === null)}>
                Select device
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
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleProvision}>Send settings</Button>
            </DialogFooter>
          </div>
        )}

        {step === 'writing' && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Writing settings to the device…
          </p>
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
