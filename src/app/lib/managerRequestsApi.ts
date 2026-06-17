export type ManagerRequestStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export interface ManagerRequest {
  id: string;
  name: string;
  description?: string | null;
  status: ManagerRequestStatus;
  apiKeyId?: string | null;
  createdAt: string;
  updatedAt: string;
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

// Submit a manager access request to a printfarm. `baseUrl` should be the
// printfarm's origin (e.g. "http://localhost:8080"). Omit or pass '' to use
// the current origin (same-printfarm request).
export async function submitManagerRequest(
  baseUrl: string,
  name: string,
  description?: string,
): Promise<{ id: string }> {
  const url = `${baseUrl || ''}/api/manager/request`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<{ id: string }>;
}

// Poll the status of a pending request. Returns status and, once, the API key
// when approved (the server clears the key after the first retrieval).
export async function pollManagerRequestStatus(
  baseUrl: string,
  id: string,
): Promise<{ id: string; status: ManagerRequestStatus; key?: string }> {
  const url = `${baseUrl || ''}/api/manager/requests/${encodeURIComponent(id)}/status`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<{ id: string; status: ManagerRequestStatus; key?: string }>;
}

export async function fetchManagerRequests(): Promise<ManagerRequest[]> {
  const response = await fetch('/api/manager/requests', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<ManagerRequest[]>;
}

export async function approveManagerRequest(id: string): Promise<void> {
  const response = await fetch(`/api/manager/requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export async function denyManagerRequest(id: string): Promise<void> {
  const response = await fetch(`/api/manager/requests/${encodeURIComponent(id)}/deny`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export async function revokeManagerAccess(id: string): Promise<void> {
  const response = await fetch(`/api/manager/requests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}
