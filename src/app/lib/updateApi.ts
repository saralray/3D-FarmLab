// Admin software-update check (Settings → Maintenance). The server compares the
// running image's baked commit SHA against the latest commit on the configured
// GitHub branch, and — when a Watchtower sidecar is wired up — can apply the
// update in place. Both endpoints are admin-only server-side.

export interface UpdateStatus {
  // Feature turned on (UPDATE_CHECK_REPO set on the server).
  enabled: boolean;
  // Running commit SHA baked into this image ("dev" for local builds).
  current: string | null;
  // Latest commit SHA on the tracked branch, or null when unknown.
  latest?: string | null;
  updateAvailable?: boolean;
  latestCommittedAt?: string | null;
  checkedAt?: string | null;
  // A Watchtower sidecar is configured, so "Update now" can apply in place.
  canApply?: boolean;
  // Present when the upstream check failed (e.g. GitHub unreachable).
  error?: string;
}

interface ApplyResult {
  ok: boolean;
  error?: string;
}

async function readError(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error;
  } catch {
    return undefined;
  }
}

// Fetch the current-vs-latest version status. Returns a disabled status on any
// failure so the caller can simply hide the card.
export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  try {
    const response = await fetch('/api/admin/update-status', { cache: 'no-store' });
    if (!response.ok) {
      return { enabled: false, current: null };
    }
    return (await response.json()) as UpdateStatus;
  } catch {
    return { enabled: false, current: null };
  }
}

// Trigger the one-click apply. The web container is typically recreated while
// this request is in flight, so a dropped connection is treated as success
// ("update started").
export async function applyUpdate(): Promise<ApplyResult> {
  try {
    const response = await fetch('/api/admin/update/apply', { method: 'POST' });
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, error: await readError(response) };
  } catch {
    // Connection dropped mid-restart — the update very likely started.
    return { ok: true };
  }
}
