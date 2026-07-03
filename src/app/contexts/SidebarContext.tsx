import { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';
import { useAuth, type User } from './AuthContext';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { isReadOnlyRole } from '../lib/usersApi';
import { fetchQueueJobs } from '../lib/queueApi';
import { fetchMaintenanceSummary } from '../lib/maintenanceApi';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { acquireEventStream, releaseEventStream } from '../lib/eventStream';

interface SidebarContextType {
  isCollapsed: boolean;
  toggleSidebar: () => void;
  hasUnfinishedQueue: boolean;
  hasPendingMaintenance: boolean;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

// The server pushes the authoritative `queue-status`/`maintenance-status`
// events (see server/eventStream.js) after every mutation that can flip them —
// submit/printed/delete/reset for the queue, complete/worker-pass for
// maintenance — over the same SSE stream MaintenanceNotifier/
// PrinterStatusNotifier use, so the dot tracks state live in both directions,
// not just "turns on". `queue-added`/`maintenance-notification` are kept as a
// second, even-earlier "turn on" signal (they fire at the point of creation,
// slightly ahead of the DB re-read the -status events need). The interval
// below is now just a reconnect/missed-event backstop, not the primary path.
const BACKSTOP_INTERVAL_MS = 180_000;

// Both dots are an operator/admin thing — a public viewer or a read-only
// viewer/student session shouldn't see "someone needs to act on this" alerts
// for work they can't act on. Split out from SidebarProvider so it only
// mounts once `user` is resolved *and* privileged: SidebarProvider sits above
// the router in App.tsx (unlike every other useAutoRefresh consumer, which
// lives behind ProtectedRoute/StaffRoute and so only ever mounts post-auth),
// so on first load `user` is briefly null. useAutoRefresh fires its very
// first `run()` synchronously on mount and never re-fires it on a
// stale-closure change (only its own interval/visibility/online triggers) —
// so mounting this before the session (and role) is known bakes in a wrong
// poll result until the 3-minute backstop or a visibilitychange/online event
// happens to fire. Mounting fresh once the session is resolved as privileged
// gives the first `run()` a correct closure from the start.
function QueueMaintenanceAlerts({
  setHasUnfinishedQueue,
  setHasPendingMaintenance,
}: {
  setHasUnfinishedQueue: (value: boolean) => void;
  setHasPendingMaintenance: (value: boolean) => void;
}) {
  const refreshAlerts = useCallback(() => {
    fetchQueueJobs()
      .then((data) => setHasUnfinishedQueue(data.queue.length > 0))
      .catch(() => setHasUnfinishedQueue(false));

    fetchMaintenanceSummary()
      .then((summary) => setHasPendingMaintenance(summary.printersRequiringMaintenance > 0))
      .catch(() => setHasPendingMaintenance(false));
  }, [setHasUnfinishedQueue, setHasPendingMaintenance]);

  useAutoRefresh(refreshAlerts, BACKSTOP_INTERVAL_MS);

  useEffect(() => {
    const source = acquireEventStream();
    const onQueueAdded = () => setHasUnfinishedQueue(true);
    const onQueueStatus = (event: Event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data) as { hasUnfinished: boolean };
        setHasUnfinishedQueue(status.hasUnfinished);
      } catch {
        // Ignore a malformed event — the backstop poll will correct the state.
      }
    };
    source.addEventListener('queue-added', onQueueAdded);
    source.addEventListener('queue-status', onQueueStatus);

    const onMaintenanceNotification = () => setHasPendingMaintenance(true);
    const onMaintenanceStatus = (event: Event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data) as { hasPending: boolean };
        setHasPendingMaintenance(status.hasPending);
      } catch {
        // Ignore a malformed event — the backstop poll will correct the state.
      }
    };
    source.addEventListener('maintenance-notification', onMaintenanceNotification);
    source.addEventListener('maintenance-status', onMaintenanceStatus);

    return () => {
      source.removeEventListener('queue-added', onQueueAdded);
      source.removeEventListener('queue-status', onQueueStatus);
      source.removeEventListener('maintenance-notification', onMaintenanceNotification);
      source.removeEventListener('maintenance-status', onMaintenanceStatus);
      releaseEventStream();
    };
  }, [setHasUnfinishedQueue, setHasPendingMaintenance]);

  return null;
}

// Operator/admin only — matches Navigation's own canSeeMaintenance gate for
// the Maintenance nav item, now also governing the Queue dot.
function isPrivilegedStaff(user: User | null) {
  return !PUBLIC_VIEWER_MODE && !!user && !isReadOnlyRole(user.role);
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasUnfinishedQueue, setHasUnfinishedQueue] = useState(false);
  const [hasPendingMaintenance, setHasPendingMaintenance] = useState(false);
  const { user } = useAuth();

  const toggleSidebar = () => {
    setIsCollapsed((prev) => !prev);
  };

  const canSeeAlerts = isPrivilegedStaff(user);

  // QueueMaintenanceAlerts unmounts for a non-privileged/logged-out session
  // (no more polling/SSE to keep the dots current) — clear them immediately
  // rather than leaving the last-known values on screen.
  useEffect(() => {
    if (!canSeeAlerts) {
      setHasUnfinishedQueue(false);
      setHasPendingMaintenance(false);
    }
  }, [canSeeAlerts]);

  return (
    <SidebarContext.Provider
      value={{ isCollapsed, toggleSidebar, hasUnfinishedQueue, hasPendingMaintenance }}
    >
      {canSeeAlerts ? (
        <QueueMaintenanceAlerts
          setHasUnfinishedQueue={setHasUnfinishedQueue}
          setHasPendingMaintenance={setHasPendingMaintenance}
        />
      ) : null}
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (context === undefined) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
}
