import { useCallback, useRef, useState } from 'react';
import { Usb, Trash2, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { SerialTerminal } from './SerialTerminal';
import {
  requestSerialPort,
  startSerialMonitor,
  type SerialMonitorHandle,
  type SerialPortLike,
} from '../lib/statusLightSerial';

// Keep the on-screen buffer bounded so a chatty device doesn't grow the DOM
// without limit; we trim from the front once it gets large.
const MAX_CHARS = 64_000;

interface StatusLightSerialMonitorProps {
  onClose: () => void;
}

// Read-only serial monitor for an ESP32-C3 status light: pick the USB device,
// then stream its serial output (boot banner, WiFi/broker connection, JSON
// replies) live. It never writes to the device.
export function StatusLightSerialMonitor({ onClose }: StatusLightSerialMonitorProps) {
  const [content, setContent] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const monitorRef = useRef<SerialMonitorHandle | null>(null);

  const handleConnect = useCallback(async () => {
    setError(null);
    setBusy(true);
    let port: SerialPortLike;
    try {
      port = await requestSerialPort();
    } catch {
      setBusy(false);
      return; // user cancelled the port picker
    }
    try {
      monitorRef.current = await startSerialMonitor(port, (line) => {
        setContent((prev) => {
          const next = `${prev}${line}\n`;
          return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next;
        });
      });
      setConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleClose = useCallback(() => {
    const monitor = monitorRef.current;
    monitorRef.current = null;
    if (monitor) {
      monitor.stop().catch(() => {});
    }
    onClose();
  }, [onClose]);

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Status light serial monitor</DialogTitle>
          <DialogDescription>
            Watch a status light's serial output live over USB — the boot banner,
            WiFi/broker connection, and JSON replies. This is read-only; it never
            sends anything to the device.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!connected ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Plug the ESP32-C3 in over USB, then choose it below. If it was just
              flashed, unplug and replug it first so the port re-appears.
            </p>
            <Button onClick={handleConnect} disabled={busy}>
              <Usb className="mr-2 size-4" />
              {busy ? 'Waiting for device…' : 'Choose device & start'}
            </Button>
          </div>
        ) : (
          <SerialTerminal content={content} emptyHint="Connected — waiting for the device to print…" />
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setContent('')}
            disabled={!connected}
          >
            <Trash2 className="mr-2 size-4" />
            Clear
          </Button>
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
