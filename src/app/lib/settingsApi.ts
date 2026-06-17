import { useEffect, useState } from 'react';
import { logAuditEvent } from './auditApi';

export interface IntegrationSettings {
  googleSheetQueueUrl: string;
  googleFormUrl: string;
}

// The effective URLs are configured by admins in Settings → Integrations and
// stored in the DB. Start empty until the API responds; consumers disable the
// relevant action (queue/form link) while the value is blank.
const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  googleSheetQueueUrl: '',
  googleFormUrl: '',
};

async function parseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

export interface BrandingSettings {
  // Empty string means "use the bundled default logo".
  logoDataUrl: string;
  // Theme-adaptive, sanitized SVG markup for inline rendering (SVG uploads only).
  logoSvg: string;
  // True when logoSvg was recolored to follow the theme via currentColor.
  logoAdaptive: boolean;
  // Size multiplier for the rendered logo (1 = built-in default size).
  logoScale: number;
  // Empty string means "use the built-in theme background".
  backgroundDataUrl: string;
}

const DEFAULT_BRANDING_SETTINGS: BrandingSettings = {
  logoDataUrl: '',
  logoSvg: '',
  logoAdaptive: false,
  logoScale: 1,
  backgroundDataUrl: '',
};

// The fields the client sends on save; the server derives logoSvg/logoAdaptive.
export interface BrandingInput {
  logoDataUrl: string;
  logoScale: number;
  backgroundDataUrl: string;
}

export async function fetchBrandingSettings(): Promise<BrandingSettings> {
  const response = await fetch('/api/settings/branding', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<BrandingSettings>;
}

export async function saveBrandingSettings(
  settings: BrandingInput,
): Promise<BrandingSettings> {
  const response = await fetch('/api/settings/branding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  logAuditEvent('settings.branding');
  return response.json() as Promise<BrandingSettings>;
}

// Read-only hook for components that render the logo (Login, Navigation).
// Falls back to the bundled default (empty string) until the API responds.
export function useBrandingSettings(): BrandingSettings {
  const [settings, setSettings] = useState<BrandingSettings>(DEFAULT_BRANDING_SETTINGS);

  useEffect(() => {
    let active = true;
    fetchBrandingSettings()
      .then((value) => {
        if (active) {
          setSettings(value);
        }
      })
      .catch(() => {
        // Keep the bundled default on failure.
      });
    return () => {
      active = false;
    };
  }, []);

  return settings;
}

export async function fetchIntegrationSettings(): Promise<IntegrationSettings> {
  const response = await fetch('/api/settings/integrations', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<IntegrationSettings>;
}

export async function saveIntegrationSettings(
  settings: IntegrationSettings,
): Promise<IntegrationSettings> {
  const response = await fetch('/api/settings/integrations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  logAuditEvent('settings.integrations');
  return response.json() as Promise<IntegrationSettings>;
}

// Read-only hook for the components that just need the effective URLs (Login,
// Navigation, Queue). Starts from the env defaults and refreshes from the API.
export function useIntegrationSettings(): IntegrationSettings {
  const [settings, setSettings] = useState<IntegrationSettings>(DEFAULT_INTEGRATION_SETTINGS);

  useEffect(() => {
    let active = true;
    fetchIntegrationSettings()
      .then((value) => {
        if (active) {
          setSettings(value);
        }
      })
      .catch(() => {
        // Keep the env-derived defaults on failure.
      });
    return () => {
      active = false;
    };
  }, []);

  return settings;
}
