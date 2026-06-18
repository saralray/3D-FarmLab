// SAML 2.0 SSO admin config (Settings → SSO Configuration). The dashboard is the
// Service Provider; an admin points it at an external IdP here. Config is read
// from / written to the server, which stores it in app_settings and applies it on
// the next sign-in with no restart. See server/samlSp.js + the /api/auth/saml/*
// and /api/settings/saml routes in server/app.js.

// The SAML config shape returned by GET /api/settings/saml.
export interface SamlSettings {
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  spEntityId: string;
  acsUrl: string;
  autoProvisionUsers: boolean;
  updatedAt: string | null;
  // Effective SP identifiers (the request-origin defaults the metadata endpoint
  // advertises when the SP fields are left blank).
  defaultSpEntityId: string;
  defaultAcsUrl: string;
  effectiveSpEntityId: string;
  effectiveAcsUrl: string;
}

export interface SamlSettingsInput {
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  spEntityId: string;
  acsUrl: string;
  autoProvisionUsers: boolean;
}

export interface SamlTestCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SamlTestResult {
  ok: boolean;
  checks: SamlTestCheck[];
}

// The SP metadata endpoint (used by the View / Download Metadata buttons and as
// the value an IdP admin imports).
export const SAML_METADATA_URL = '/api/auth/saml/metadata';

async function readError(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error;
  } catch {
    return undefined;
  }
}

export async function fetchSamlSettings(): Promise<SamlSettings> {
  const response = await fetch('/api/settings/saml', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error((await readError(response)) ?? 'Unable to load SSO settings.');
  }
  return response.json() as Promise<SamlSettings>;
}

export async function saveSamlSettings(input: SamlSettingsInput): Promise<SamlSettings> {
  const response = await fetch('/api/settings/saml', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) ?? 'Unable to save SSO settings.');
  }
  return response.json() as Promise<SamlSettings>;
}

// Validate the (unsaved) form values and probe the IdP for reachability.
export async function testSamlSettings(
  input: Pick<SamlSettingsInput, 'idpSsoUrl' | 'idpCertificate'>,
): Promise<SamlTestResult> {
  const response = await fetch('/api/settings/saml/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) ?? 'Unable to test SSO settings.');
  }
  return response.json() as Promise<SamlTestResult>;
}

// Fetch the SP metadata XML (for the View Metadata dialog).
export async function fetchSamlMetadata(): Promise<string> {
  const response = await fetch(SAML_METADATA_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Unable to load metadata XML.');
  }
  return response.text();
}
