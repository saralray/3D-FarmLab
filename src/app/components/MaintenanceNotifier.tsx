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
import { acquireEventStream, releaseEventStream } from '../lib/eventStream';

// The server pushes a maintenance-notification SSE event the instant the
// worker creates one (see server/eventStream.js), so this poll is now just a
// backstop catch-up for a tab that was disconnected/backgrounded when the
// event fired — SSE offers no replay, and a missed maintenance-due alert is
// worth not losing. Kept comfortably under the worker's own 5-minute cadence
// (MAINTENANCE_WORKER_INTERVAL_MS in server/app.js) so a reconnect catches up
// promptly, while still cutting traffic ~6x versus the previous 30s poll.
const POLL_INTERVAL_MS = 180000;

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
  // or surface maintenance notifications (matches the StaffRoute guard). The
  // server independently gates the SSE event to a privileged session too.
  const isStaff = !PUBLIC_VIEWER_MODE && !!user && !isReadOnlyRole(user.role);
  const addEventRef = useRef(addEvent);
  addEventRef.current = addEvent;
  // Ids already surfaced this session (via SSE or the backstop poll), so a
  // reconnect/backstop pass doesn't double-toast one SSE already delivered.
  const shownIdsRef = useRef<Set<string>>(new Set());

  const surface = (note: Pick<MaintenanceNotification, 'id' | 'kind' | 'title' | 'body' | 'printerId'>) => {
    if (shownIdsRef.current.has(note.id)) {
      return;
    }
    shownIdsRef.current.add(note.id);
    const level = LEVEL_BY_KIND[note.kind] ?? 'info';
    toast[level](note.title, { description: note.body ?? undefined });
    addEventRef.current({
      level,
      title: note.title,
      description: note.body ?? undefined,
      printerId: note.printerId ?? undefined,
    });
  };

  useEffect(() => {
    if (!isStaff) return;

    const source = acquireEventStream();
    const onMaintenanceNotification = (event: Event) => {
      try {
        const note = JSON.parse((event as MessageEvent).data) as MaintenanceNotification;
        surface(note);
        markMaintenanceNotificationsRead([note.id]).catch(() => {
          // A failed ack just means the backstop poll below will redeliver it
          // once — shownIdsRef still suppresses a duplicate toast this session.
        });
      } catch {
        // Ignore a malformed event rather than crash the listener.
      }
    };
    source.addEventListener('maintenance-notification', onMaintenanceNotification);

    return () => {
      source.removeEventListener('maintenance-notification', onMaintenanceNotification);
      releaseEventStream();
    };
  }, [isStaff]);

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const notifications = await fetchMaintenanceNotifications(true);
        if (cancelled || notifications.length === 0) return;

        for (const note of notifications) {
          surface(note);
        }
        // Acknowledge so the same condition doesn't re-toast every poll; the worker
        // re-creates a fresh row if the condition still holds next pass.
        await markMaintenanceNotificationsRead(notifications.map((note) => note.id));
      } catch {
        // Stay quiet on transient failures.
      }
    };

    // Pause while the tab is hidden — this notifier is mounted globally on
    // every page, so a backgrounded tab was otherwise polling forever.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(poll, POLL_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        poll();
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
  }, [isStaff]);

  return null;
}
