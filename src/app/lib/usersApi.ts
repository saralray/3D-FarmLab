// Staff user accounts (operators and any extra admins), persisted server-side in
// the database so they survive container rebuilds and are the same in every
// browser — they used to live only in the browser's localStorage. The client
// only ever sends a sha256 hash of the password; the plaintext stays in the
// browser. The primary `admin` account is a separate server credential (see
// adminCredentialApi.ts) and is not part of this list.

// `student` is the role granted to anyone who signs in with Google (OAuth). It
// has the same read-only capabilities as the anonymous `viewer`, but is a real
// authenticated session (so it gets a logout). Students are OAuth-only and are
// not offered in the manual create-user role dropdown.
export type UserRole = 'admin' | 'operator' | 'viewer' | 'student';

// Roles with no management/control privileges — they see the dashboard read-only
// and must not see sensitive printer connection details. Use this instead of an
// `=== 'viewer'` check anywhere a capability should also be denied to students.
export function isReadOnlyRole(role: UserRole | undefined | null): boolean {
  return role === 'viewer' || role === 'student';
}

export interface StaffUser {
  id: string;
  name: string;
  username: string;
  role: UserRole;
}

interface MutationResult {
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

// The full staff list for the management UI. Never includes password hashes.
export async function fetchUsers(): Promise<StaffUser[]> {
  try {
    const response = await fetch('/api/users', { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as StaffUser[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Login check for a non-admin account. Returns the matched user on success.
export async function verifyUser(
  username: string,
  password: string,
): Promise<StaffUser | null> {
  try {
    const response = await fetch('/api/users/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { valid?: boolean; user?: StaffUser };
    return data.valid && data.user ? data.user : null;
  } catch {
    return null;
  }
}

export interface CreateUserApiResult extends MutationResult {
  user?: StaffUser;
}

export async function createUserApi(input: {
  name: string;
  username: string;
  role: UserRole;
  password: string;
}): Promise<CreateUserApiResult> {
  try {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response) };
    }
    const user = (await response.json()) as StaffUser;
    return { ok: true, user };
  } catch {
    return { ok: false, error: 'Unable to reach the server.' };
  }
}

export async function deleteUserApi(userId: string): Promise<MutationResult> {
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    return response.ok ? { ok: true } : { ok: false, error: await readError(response) };
  } catch {
    return { ok: false, error: 'Unable to reach the server.' };
  }
}

export async function changeUserPasswordApi(
  userId: string,
  password: string,
  currentPassword?: string,
): Promise<MutationResult> {
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // The server requires the current password when changing your OWN account
      // (it can't be used to silently re-key another admin); include it when the
      // caller supplied it. Plaintext over TLS — the server hashes.
      body: JSON.stringify(
        currentPassword ? { password, currentPassword } : { password },
      ),
    });
    return response.ok ? { ok: true } : { ok: false, error: await readError(response) };
  } catch {
    return { ok: false, error: 'Unable to reach the server.' };
  }
}

// Change an existing account's role. `student` is OAuth-only and not a valid
// target here — the server accepts only admin/operator/viewer.
export async function changeUserRoleApi(
  userId: string,
  role: UserRole,
): Promise<MutationResult> {
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    return response.ok ? { ok: true } : { ok: false, error: await readError(response) };
  } catch {
    return { ok: false, error: 'Unable to reach the server.' };
  }
}
