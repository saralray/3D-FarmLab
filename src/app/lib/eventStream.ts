// Single shared SSE connection for the whole app. PrinterStatusNotifier,
// MaintenanceNotifier, and SidebarContext each used to open their own
// `new EventSource('/api/events')` — three concurrent connections per tab,
// which is enough to hit the browser's ~6-connections-per-origin cap on
// HTTP/1.1 (this app is proxied over 1.1, not h2) once a couple of tabs are
// open or a reload leaves the old tab's connections still draining. That
// starved a new connection of a slot, so it never opened and events stopped
// arriving until the caller unknowingly fell back to a poll. Acquiring here
// keeps it to exactly one connection per tab regardless of how many
// components subscribe.
let source: EventSource | null = null;
let refCount = 0;

export function acquireEventStream(): EventSource {
  if (!source) {
    source = new EventSource('/api/events');
  }
  refCount += 1;
  return source;
}

export function releaseEventStream() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && source) {
    source.close();
    source = null;
  }
}
