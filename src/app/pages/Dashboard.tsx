import { useEffect, useRef, useState } from 'react';
import { Printer } from '../types';
import { PrinterCard } from '../components/PrinterCard';
import { Activity, AlertCircle, Check, CheckCircle, LayoutGrid, Lightbulb, Pause } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { useAuth } from '../contexts/AuthContext';
import { savePrinter } from '../lib/printersApi';
import { printerSupportsLight, setPrinterLight } from '../lib/printerProfiles';
import { logAuditEvent } from '../lib/auditApi';
import { usePrinters } from '../contexts/PrintersContext';
import { useIsMobile } from '../components/ui/use-mobile';
import { DEFAULT_SITE_NAME, useBrandingSettings } from '../lib/settingsApi';
import { isReadOnlyRole } from '../lib/usersApi';
import { toast } from 'sonner';

export function Dashboard() {
  const { printers: livePrinters, error: loadError, refresh } = usePrinters();
  const [printers, setPrinters] = useState<Printer[]>(livePrinters);
  const [draggedPrinterId, setDraggedPrinterId] = useState<string | null>(null);
  const [lightsInFlight, setLightsInFlight] = useState(false);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const { user } = useAuth();
  // Drag-to-reorder ("edit layout") is awkward on touch phones, so it's
  // disabled there — cards stay tap-to-open only.
  const isMobile = useIsMobile();
  const { siteName } = useBrandingSettings();
  // Admins on non-touch screens may reorder, but only after explicitly entering
  // "Edit layout" mode via the top-right button (mirrors the Analytics page).
  const canReorder = user?.role === 'admin' && !isMobile;
  const isReordering = canReorder && isLayoutEditing;
  const loadErrorToastShownRef = useRef(false);

  // Adopt the shared poll's data except while a drag is in progress, so the
  // background refresh doesn't clobber the optimistic reorder mid-drag.
  useEffect(() => {
    if (!draggedPrinterId) {
      setPrinters(livePrinters);
    }
  }, [livePrinters, draggedPrinterId]);

  useEffect(() => {
    if (loadError && !loadErrorToastShownRef.current) {
      toast.error('Unable to load printer status from the server.', {
        id: 'dashboard-load-printers-error',
      });
      loadErrorToastShownRef.current = true;
    } else if (!loadError) {
      loadErrorToastShownRef.current = false;
    }
  }, [loadError]);

  // Dismiss the printer-status error toast when navigating away so it doesn't
  // linger visually on other pages (Queue, Analytics, etc.).
  useEffect(() => {
    return () => {
      toast.dismiss('dashboard-load-printers-error');
    };
  }, []);

  const persistPrinterOrder = async (nextPrinters: Printer[]) => {
    await Promise.all(
      nextPrinters.map((printer, index) =>
        savePrinter(
          {
            ...printer,
            sortOrder: index,
          },
          { silent: true },
        )
      )
    );
    logAuditEvent('printer.reorder', undefined, { count: nextPrinters.length });
  };

  const stats = {
    total: printers.length,
    online: printers.filter((p) => p.status !== 'offline').length,
    printing: printers.filter((p) => p.status === 'printing').length,
    // Count every printer currently surfacing a fault — either a hard error
    // status or an active errorMessage (HMS faults like chamber-temp/door-open/
    // spool-empty appear via errorMessage while status may still be printing/idle),
    // so this card stays in sync with the per-printer error shown on each card.
    error: printers.filter((p) => p.status === 'error' || (p.errorMessage?.trim() ?? '') !== '').length,
    paused: printers.filter((p) => p.status === 'paused').length,
    offline: printers.filter((p) => p.status === 'offline').length,
  };

  const statCards = [
    { label: 'Online', value: `${stats.online}/${stats.total}`, icon: CheckCircle, color: 'text-green-500', bgColor: 'bg-green-50 dark:bg-green-900/80' },
    { label: 'Printing', value: stats.printing, icon: Activity, color: 'text-blue-500', bgColor: 'bg-blue-50 dark:bg-blue-900/80' },
    { label: 'Paused', value: stats.paused, icon: Pause, color: 'text-yellow-500', bgColor: 'bg-yellow-50 dark:bg-yellow-900/80' },
    { label: 'Error', value: stats.error, icon: AlertCircle, color: 'text-red-500', bgColor: 'bg-red-50 dark:bg-red-900/80' },
  ];

  // Printers that expose a chamber/cavity light and are currently reachable.
  const lightCapablePrinters = printers.filter(
    (printer) => printerSupportsLight(printer) && printer.status !== 'offline',
  );
  // If any light is on, the toggle turns them all off; otherwise it turns them on.
  const anyLightOn = lightCapablePrinters.some((printer) => printer.lightOn === true);

  const handleToggleAllLights = async () => {
    if (user?.role !== 'admin' || lightsInFlight || lightCapablePrinters.length === 0) {
      return;
    }

    const next = !anyLightOn;
    setLightsInFlight(true);

    const results = await Promise.allSettled(
      lightCapablePrinters.map((printer) => setPrinterLight(printer, next)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;

    setLightsInFlight(false);

    const succeeded = lightCapablePrinters.length - failed;
    logAuditEvent('printer.lights.toggleAll', undefined, { on: next, succeeded, failed });

    if (failed === 0) {
      toast.success(`Turned all lights ${next ? 'on' : 'off'} (${succeeded} printers).`);
    } else if (succeeded === 0) {
      toast.error('Unable to toggle any printer lights.');
    } else {
      toast.warning(`Lights ${next ? 'on' : 'off'} for ${succeeded} printers; ${failed} failed.`);
    }

    await refresh();
  };

  const handlePrinterDragStart = (printerId: string) => {
    if (user?.role !== 'admin') {
      return;
    }

    setDraggedPrinterId(printerId);
  };

  const handlePrinterDragOver = (targetPrinterId: string) => {
    if (user?.role !== 'admin' || !draggedPrinterId || draggedPrinterId === targetPrinterId) {
      return;
    }

    setPrinters((prev) => {
      const draggedIndex = prev.findIndex((printer) => printer.id === draggedPrinterId);
      const targetIndex = prev.findIndex((printer) => printer.id === targetPrinterId);

      if (draggedIndex === -1 || targetIndex === -1) {
        return prev;
      }

      const nextPrinters = [...prev];
      const [draggedPrinter] = nextPrinters.splice(draggedIndex, 1);
      nextPrinters.splice(targetIndex, 0, draggedPrinter);

      return nextPrinters.map((printer, index) => ({
        ...printer,
        sortOrder: index,
      }));
    });
  };

  const handlePrinterDragEnd = async () => {
    if (user?.role !== 'admin' || !draggedPrinterId) {
      return;
    }

    const nextPrinters = printers.map((printer, index) => ({
      ...printer,
      sortOrder: index,
    }));

    // Keep the drag guard set until the order is persisted AND a refresh has
    // pulled the new order back into livePrinters. Clearing it earlier lets the
    // adoption effect overwrite the optimistic order with a stale poll, which
    // made the layout snap back to the old version after a reorder.
    try {
      await persistPrinterOrder(nextPrinters);
      toast.success('Dashboard order updated.');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save dashboard order.');
      await refresh();
    } finally {
      setDraggedPrinterId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-foreground">{siteName || DEFAULT_SITE_NAME} Dashboard</h1>
          <p className="text-muted-foreground">Monitor and manage all printers in real-time</p>
        </div>
        {canReorder && (
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
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.label} className={`p-4 ${stat.bgColor} border-0`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">{stat.label}</div>
                <div className="text-2xl font-bold mt-1 text-foreground">{stat.value}</div>
              </div>
              <stat.icon className={`size-8 ${stat.color}`} />
            </div>
          </Card>
        ))}
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4 text-foreground">All Printers ({stats.total})</h2>
        {isReordering && (
          <p className="mb-4 text-sm text-muted-foreground">
            Drag a printer card onto another to reorder them. The new order is saved automatically.
          </p>
        )}
        <div className="printer-grid grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {printers.map((printer) => (
            <PrinterCard
              key={printer.id}
              printer={printer}
              canManage={isReordering}
              canViewSensitiveInfo={!isReadOnlyRole(user?.role)}
              onDragStart={isReordering ? handlePrinterDragStart : undefined}
              onDragOver={isReordering ? handlePrinterDragOver : undefined}
              onDragEnd={isReordering ? handlePrinterDragEnd : undefined}
            />
          ))}
        </div>
      </div>

      {user?.role === 'admin' && lightCapablePrinters.length > 0 && (
        <Button
          size="icon"
          onClick={handleToggleAllLights}
          disabled={lightsInFlight}
          aria-pressed={anyLightOn}
          title={anyLightOn ? 'Turn all printer lights off' : 'Turn all printer lights on'}
          className={`fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 size-12 rounded-full shadow-lg lg:right-6 lg:bottom-6 lg:size-14 ${
            anyLightOn ? 'bg-amber-400 text-amber-950 hover:bg-amber-300' : ''
          }`}
        >
          <Lightbulb className={`size-5 lg:size-6 ${anyLightOn ? 'fill-current' : ''}`} />
        </Button>
      )}
    </div>
  );
}
