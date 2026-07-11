import { useCallback, useState } from 'react';
import { Lightbulb, Usb } from 'lucide-react';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useAuth } from '../contexts/AuthContext';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { fetchStatusLightDevices, type StatusLightDevice } from '../lib/statusLightApi';
import { isWebSerialSupported } from '../lib/statusLightSerial';
import { StatusLightFlashDialog } from './StatusLightFlashDialog';

const DEVICE_POLL_INTERVAL_MS = 10000;

// The physical color code the firmware drives — kept in sync with
// firmware/status-light/src/main.cpp and the dashboard's own status colors
// (PrinterCard getStatusColor).
const COLOR_LEGEND: { label: string; dotClass: string; pulse?: boolean }[] = [
  { label: 'Idle', dotClass: 'bg-green-500' },
  { label: 'Printing', dotClass: 'bg-blue-500' },
  { label: 'Paused', dotClass: 'bg-orange-500' },
  { label: 'Error', dotClass: 'bg-red-500' },
  { label: 'Offline', dotClass: 'bg-red-500', pulse: true },
];

interface StatusLightCardProps {
  printerId: string;
  printerName: string;
}

// Per-printer ESP32 RGB status light: shows whether a light is polling the
// dashboard, and (admin) flashes/provisions one over Web Serial.
export function StatusLightCard({ printerId, printerName }: StatusLightCardProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [device, setDevice] = useState<StatusLightDevice | null>(null);
  const [dialogMode, setDialogMode] = useState<'flash' | 'provision' | null>(null);

  const refreshDevices = useCallback(() => {
    fetchStatusLightDevices()
      .then((devices) => {
        setDevice(devices.find((entry) => entry.printerId === printerId) ?? null);
      })
      .catch(() => {
        // Transient poll failure — keep the last known state.
      });
  }, [printerId]);
  useAutoRefresh(refreshDevices, DEVICE_POLL_INTERVAL_MS);

  const webSerialAvailable = isWebSerialSupported();
  const connected = device?.connected === true;

  return (
    <Card className="p-6">
      <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
        <Lightbulb className="size-5" />
        Status Light
      </h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">ESP32 light</span>
          <Badge variant={connected ? 'outline' : 'secondary'} className="gap-2">
            <span
              className={`size-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`}
              aria-hidden="true"
            />
            {connected ? 'Connected' : device ? 'Disconnected' : 'Not set up'}
          </Badge>
        </div>

        {device?.lastSeen && (
          <p className="text-sm text-muted-foreground">
            Last seen {new Date(device.lastSeen).toLocaleString()}
          </p>
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

        {isAdmin && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!webSerialAvailable} onClick={() => setDialogMode('flash')}>
                <Usb className="size-4 mr-2" />
                Flash & provision
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!webSerialAvailable}
                onClick={() => setDialogMode('provision')}
              >
                Re-provision only
              </Button>
            </div>
            {!webSerialAvailable && (
              <p className="text-xs text-muted-foreground">
                Flashing needs Web Serial: open this page in Chrome or Edge over HTTPS (or localhost),
                then plug the ESP32-C3 in over USB.
              </p>
            )}
          </div>
        )}
      </div>

      {dialogMode !== null && (
        <StatusLightFlashDialog
          mode={dialogMode}
          printerId={printerId}
          printerName={printerName}
          onClose={() => {
            setDialogMode(null);
            refreshDevices();
          }}
        />
      )}
    </Card>
  );
}
