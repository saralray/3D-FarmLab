import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { usePrinterEvents, PrinterEventLevel } from '../contexts/PrinterEventsContext';
import { useAuth } from '../contexts/AuthContext';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { isReadOnlyRole } from '../lib/usersApi';
import {
  fetchMaintenanceNotifications,
  markMaintenanceNotificationsRead,
  type MaintenanceNotification,
} from '../lib/maintenanceApi';

const POLL_INTERVAL_MS = 30000;

// Maintenance notifications are produced server-side by the 5-minute worker and
// stored in the DB (deduped to one open row per printer+kind). This bridges them
// into the existing NotificationBell: each unread row is surfaced once via the
// shared PrinterEvents store, then marked read so it isn't re-shown after reload.
const LEVEL_BY_KIND: Record<MaintenanceNotification['kind'], PrinterEventLevel> = {
  due: 'warning',
  overdue: 'error',
  health: 'warning',
};

export function MaintenanceNotifier() {
  const { addEvent } = usePrinterEvents();
  const { user } = useAuth();
  // Maintenance is staff-only, so read-only/public-viewer sessions never poll for
  // or surface maintenance notifications (matches the StaffRoute guard).
  const isStaff = !PUBLIC_VIEWER_MODE && !!user && !isReadOnlyRole(user.role);
  const addEventRef = useRef(addEvent);
  addEventRef.current = addEvent;

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const notifications = await fetchMaintenanceNotifications(true);
        if (cancelled || notifications.length === 0) return;

        for (const note of notifications) {
          const level = LEVEL_BY_KIND[note.kind] ?? 'info';
          toast[level](note.title, { description: note.body ?? undefined });
          addEventRef.current({
            level,
            title: note.title,
            description: note.body ?? undefined,
            printerId: note.printerId ?? undefined,
          });
        }
        // Acknowledge so the same condition doesn't re-toast every poll; the worker
        // re-creates a fresh row if the condition still holds next pass.
        await markMaintenanceNotificationsRead(notifications.map((note) => note.id));
      } catch {
        // Stay quiet on transient failures.
      }
    };

    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isStaff]);

  return null;
}
