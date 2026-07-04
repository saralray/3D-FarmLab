// In-memory Server-Sent Events fan-out for browser notifications that used to be
// polled every 10-30s from every open tab (queue-added, maintenance due/overdue/
// health). Mirrors the viewer-Set pattern in bambuCamera.js, applied to tiny JSON
// events instead of camera frames.
//
// Single-process only: subscribers live in a plain in-memory Set, so an operator
// scaling the `web` service beyond one replica would need a shared bus (e.g.
// Redis pub/sub) for events to reach a client connected to a different instance.
// The rest of this app doesn't run `web` with more than one replica today (see
// docker-compose.yml), so this matches the existing single-instance assumption.

const PING_INTERVAL_MS = 25000;

const subscribers = new Set(); // { res, wantsMaintenance }

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The close/error listener registered in addEventSubscriber cleans this up.
  }
}

export function addEventSubscriber(req, res, { wantsMaintenance }) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.write(':ok\n\n');

  const subscriber = { res, wantsMaintenance };
  subscribers.add(subscriber);

  const remove = () => subscribers.delete(subscriber);
  req.on('close', remove);
  res.on('close', remove);
  res.on('error', remove);
}

// Sent to every connected client (matches the previous public, unauthenticated
// GET /api/queue poll that any open tab performed).
export function broadcastQueueAdded(job) {
  for (const subscriber of subscribers) {
    writeEvent(subscriber.res, 'queue-added', job);
  }
}

// Sent only to connections whose session was privileged (admin/operator) at
// subscribe time, matching the frontend's existing staff-only gate.
export function broadcastMaintenanceNotification(notification) {
  for (const subscriber of subscribers) {
    if (subscriber.wantsMaintenance) {
      writeEvent(subscriber.res, 'maintenance-notification', notification);
    }
  }
}

// Current "is there an unfinished job" state, pushed after every mutation that
// can change it (submit/printed/delete/reset) so the sidebar's Queue dot
// tracks the queue live in both directions — `queue-added` alone only ever
// turns the dot on, never off. Public, like the queue read itself.
export function broadcastQueueStatus(status) {
  for (const subscriber of subscribers) {
    writeEvent(subscriber.res, 'queue-status', status);
  }
}

// Same idea for the Maintenance dot: pushed after a task is completed (turns
// it off) and from the worker pass that creates new pending tasks (turns it
// on), so the badge doesn't rely solely on the point-in-time maintenance
// worker.
export function broadcastMaintenanceStatus(status) {
  for (const subscriber of subscribers) {
    if (subscriber.wantsMaintenance) {
      writeEvent(subscriber.res, 'maintenance-status', status);
    }
  }
}

// Filament Station (SpoolBuddy port) events — tag scans, scale readings,
// device online/offline, assignment triggers. Public like queue events; no
// per-subscriber filter (unlike maintenance) since there's no staff-only gate
// on this feature today.
export function broadcastFilamentStationEvent(eventName, data) {
  for (const subscriber of subscribers) {
    writeEvent(subscriber.res, eventName, data);
  }
}

// Keep intermediary proxies/load balancers from timing out an otherwise-silent
// connection, and prune any subscriber whose write already started failing.
setInterval(() => {
  for (const subscriber of subscribers) {
    try {
      subscriber.res.write(':ping\n\n');
    } catch {
      subscribers.delete(subscriber);
    }
  }
}, PING_INTERVAL_MS).unref();
