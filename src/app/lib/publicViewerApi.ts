import { logAuditEvent } from './auditApi';

// Website access mode: whether an unauthenticated visitor may view the dashboard
// read-only (a "public viewer" session) or is redirected to the login screen.
// Backed by the app_settings key `public_viewer`; defaults to enabled.
export interface PublicViewerSetting {
  enabled: boolean;
}

async function parseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

export async function fetchPublicViewerSetting(): Promise<PublicViewerSetting> {
  const response = await fetch('/api/settings/public-viewer', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<PublicViewerSetting>;
}

export async function savePublicViewerSetting(
  enabled: boolean,
): Promise<PublicViewerSetting> {
  const response = await fetch('/api/settings/public-viewer', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  logAuditEvent('settings.public-viewer', undefined, { enabled });
  return response.json() as Promise<PublicViewerSetting>;
}
