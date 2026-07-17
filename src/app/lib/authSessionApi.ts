// Server-side login sessions. The browser no longer trusts its own client-held
// role state to authorize anything — it logs in against the server, which sets
// an HttpOnly session cookie and enforces role-based access on every /api/*
// mutation. These helpers wrap that cookie session. The cookie is sent
// automatically on same-origin requests, so callers don't manage it directly.

export type SessionRole = 'admin' | 'operator' | 'viewer' | 'student';

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: SessionRole;
}

export interface LoginSessionResult {
  ok: boolean;
  user?: SessionUser;
  error?: string;
  /** Set when the server throttled the attempt (HTTP 429). */
  retryAfterMs?: number;
}

async function readError(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error;
  } catch {
    return undefined;
  }
}

// Exchange a username + plaintext password (protected by TLS) for a server
// session cookie; the server does the hashing. The admin account and staff
// accounts both authenticate through this one endpoint.
export async function loginSession(
  username: string,
  password: string,
  remember: boolean,
): Promise<LoginSessionResult> {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    });
    if (response.status === 429) {
      const payload = (await response.json().catch(() => ({}))) as { retryAfterMs?: number };
      return {
        ok: false,
        error: 'Too many failed attempts. Please wait and try again.',
        retryAfterMs: payload.retryAfterMs,
      };
    }
    if (!response.ok) {
      return { ok: false, error: (await readError(response)) ?? 'Invalid credentials.' };
    }
    const data = (await response.json()) as { user?: SessionUser };
    return data.user ? { ok: true, user: data.user } : { ok: false, error: 'Invalid credentials.' };
  } catch {
    return { ok: false, error: 'Unable to reach the server.' };
  }
}

// Destroy the current server session and clear the cookie. Best-effort.
export async function logoutSession(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Logging out is best-effort; the client clears its own state regardless.
  }
}

// Restore auth state from the session cookie on load. Returns the signed-in user
// or null when there is no valid session.
// The server session's real expiry (ISO 8601), returned alongside the user so
// the client mirror can match the actual cookie lifetime instead of assuming a
// fixed one. Attached onto the user for convenience; null when the server did
// not report one.
export async function fetchSession(): Promise<(SessionUser & { expiresAt: string | null }) | null> {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { user?: SessionUser | null; expiresAt?: string | null };
    return data.user ? { ...data.user, expiresAt: data.expiresAt ?? null } : null;
  } catch {
    return null;
  }
}
