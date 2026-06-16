import { logAuditEvent } from './auditApi';

// Permission scopes a key can carry. 'slicer_upload' lets the key push prints
// through the slicer-upload proxy; 'printfarm_manage' grants the programmatic
// /api/v1 data API.
export type SlicerKeyPermission = 'slicer_upload' | 'printfarm_manage';

export const SLICER_KEY_PERMISSION_OPTIONS: { value: SlicerKeyPermission; label: string; description: string }[] = [
  {
    value: 'slicer_upload',
    label: 'Slicer Upload',
    description: 'Push sliced files to printers through the slicer-upload proxy.',
  },
  {
    value: 'printfarm_manage',
    label: 'PrintFarm Manage',
    description: 'Read and manage print-farm data through the /api/v1 API.',
  },
];

export interface SlicerApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: SlicerKeyPermission[];
  lastUsedAt?: string | null;
  createdAt?: string;
}

// Returned only by createSlicerKey — the full key is shown once and never again.
export interface CreatedSlicerKey {
  id: string;
  name: string;
  key: string;
  permissions: SlicerKeyPermission[];
}

async function parseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

export async function fetchSlicerKeys(): Promise<SlicerApiKey[]> {
  const response = await fetch('/api/slicer-keys', { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json() as Promise<SlicerApiKey[]>;
}

export async function createSlicerKey(
  name: string,
  permissions: SlicerKeyPermission[],
): Promise<CreatedSlicerKey> {
  const response = await fetch('/api/slicer-keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, permissions }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  const created = (await response.json()) as CreatedSlicerKey;
  logAuditEvent('slicer_key.create', created.name, { id: created.id, permissions: created.permissions });
  return created;
}

export async function removeSlicerKey(keyId: string) {
  const response = await fetch(`/api/slicer-keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  logAuditEvent('slicer_key.delete', keyId);
}
