import { useCallback, useMemo, useState } from 'react';
import { Lightbulb, Usb, Terminal } from 'lucide-react';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { useAuth } from '../contexts/AuthContext';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { fetchStatusLightDevices, type StatusLightDevice } from '../lib/statusLightApi';
import { isWebSerialSupported } from '../lib/statusLightSerial';
import { StatusLightFlashDialog } from './StatusLightFlashDialog';
import { StatusLightSerialMonitor } from './StatusLightSerialMonitor';

const DEVICE_POLL_INTERVAL_MS = 10000;

// Physical color code the firmware drives — kept in sync with
// firmware/status-light/src/main.cpp and the dashboard's own status colors.
const COLOR_LEGEND: { label: string; dotClass: string; pulse?: boolean }[] = [
  { label: 'Idle', dotClass: 'bg-green-500' },
  { label: 'Printing', dotClass: 'bg-blue-500' },
  { label: 'Paused', dotClass: 'bg-orange-500' },
  { label: 'Error', dotClass: 'bg-red-500' },
  { label: 'Offline', dotClass: 'bg-red-500', pulse: true },
];

// Settings → Status Lights: pick a printer, see whether its ESP32 light is
// connected to the embedded MQTT broker, flash/provision one over Web Serial,
// and open a read-only serial monitor. Moved here from the printer-detail page.
export function StatusLightSettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [devices, setDevices] = useState<StatusLightDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [dialogMode, setDialogMode] = useState<'flash' | 'provision' | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);

  const refreshDevices = useCallback(() => {
    fetchStatusLightDevices()
      .then((list) => {
        setDevices(list);
        // Default the picker to the first printer once the roster loads.
        setSelectedId((current) => current || (list[0]?.printerId ?? ''));
      })
      .catch(() => {
        // Transient poll failure — keep the last known roster.
      });
  }, []);
  useAutoRefresh(refreshDevices, DEVICE_POLL_INTERVAL_MS);

  const webSerialAvailable = isWebSerialSupported();
  const selected = useMemo(
    () => devices.find((d) => d.printerId === selectedId) ?? null,
    [devices, selectedId],
  );
  const selectedName = selected?.name || selectedId;
  const connected = selected?.connected === true;

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Lightbulb className="size-5" />
            Status Lights
          </h2>
          <p className="text-sm text-muted-foreground">
            Flash and provision a printer's ESP32 RGB status light, or open a
            serial monitor to watch a device over USB.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="status-light-printer">Printer</Label>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger id="status-light-printer" className="sm:max-w-sm">
              <SelectValue placeholder="Select a printer…" />
            </SelectTrigger>
            <SelectContent>
              {devices.map((device) => (
                <SelectItem key={device.printerId} value={device.printerId}>
                  {device.name || device.printerId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selected && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">ESP32 light</span>
              <Badge variant={connected ? 'outline' : 'secondary'} className="gap-2">
                <span
                  className={`size-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`}
                  aria-hidden="true"
                />
                {connected ? 'Connected' : 'Disconnected'}
              </Badge>
            </div>
            {selected.lastSeen && (
              <p className="text-sm text-muted-foreground">
                Last seen {new Date(selected.lastSeen).toLocaleString()}
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {COLOR_LEGEND.map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={`size-2 rounded-full ${entry.dotClass} ${entry.pulse ? 'animate-pulse' : ''}`}
                aria-hidden="true"
              />
              {entry.label}
            </span>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <>
                <Button
                  size="sm"
                  disabled={!webSerialAvailable || !selectedId}
                  onClick={() => setDialogMode('flash')}
                >
                  <Usb className="mr-2 size-4" />
                  Flash &amp; provision
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!webSerialAvailable || !selectedId}
                  onClick={() => setDialogMode('provision')}
                >
                  Re-provision only
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!webSerialAvailable}
              onClick={() => setMonitorOpen(true)}
            >
              <Terminal className="mr-2 size-4" />
              Open serial monitor
            </Button>
          </div>
          {!webSerialAvailable && (
            <p className="text-xs text-muted-foreground">
              Serial features need Web Serial: open this page in Chrome or Edge over HTTPS (or
              localhost), then plug the ESP32-C3 in over USB.
            </p>
          )}
        </div>
      </div>

      {dialogMode !== null && selected && (
        <StatusLightFlashDialog
          mode={dialogMode}
          printerId={selected.printerId}
          printerName={selectedName}
          onClose={() => {
            setDialogMode(null);
            refreshDevices();
          }}
        />
      )}

      {monitorOpen && <StatusLightSerialMonitor onClose={() => setMonitorOpen(false)} />}
    </Card>
  );
}
