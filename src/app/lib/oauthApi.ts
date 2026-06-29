// OAuth (SSO) sign-in — Google, Microsoft Entra ID, and Satit-M Chula ADFS.
// The dashboard auth is cookieless, so the server runs the Authorization Code
// flow and hands the authenticated identity back to the client as a short-lived,
// HMAC-signed grant token in a URL param (`?oauth_grant=`). The client verifies
// it here (server-side) before creating a session — the same hand-off shape as
// the slicer grant. See server/oauthGrant.js.

import type { UserRole } from './usersApi';

export type OAuthProvider = 'google' | 'microsoft' | 'adfs';

export interface OAuthUser {
  id: string;
  name: string;
  username: string;
  role: UserRole;
}

// Which providers are configured + enabled. Drives the sign-in buttons on the
// login page.
export interface EnabledOAuthProviders {
  google: boolean;
  microsoft: boolean;
  adfs: boolean;
  saml: boolean;
}

// Admin-facing config shape for the Settings → Sign-in form. The client secret is
// never returned — only whether one is stored. `tenant` and `authority` are
// Microsoft-only: `tenant` for the Microsoft cloud (Entra ID), `authority` for an
// on-prem AD FS base URL (e.g. https://host/adfs) when not using the cloud.
export interface OAuthSettings {
  enabled: boolean;
  clientId: string;
  tenant: string;
  authority: string;
  allowedDomains: string[];
  hasClientSecret: boolean;
}

export interface OAuthSettingsInput {
  enabled: boolean;
  clientId: string;
  tenant: string;
  authority: string;
  // Blank means "keep the stored secret"; a value replaces it.
  clientSecret: string;
  allowedDomains: string[];
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

// Which SSO buttons to show on the login page.
export async function fetchEnabledOAuthProviders(): Promise<EnabledOAuthProviders> {
  try {
    const response = await fetch('/api/auth/providers', { cache: 'no-store' });
    if (!response.ok) {
      return { google: false, microsoft: false, adfs: false, saml: false };
    }
    const data = (await response.json()) as Partial<EnabledOAuthProviders>;
    return {
      google: Boolean(data.google),
      microsoft: Boolean(data.microsoft),
      adfs: Boolean(data.adfs),
      saml: Boolean(data.saml),
    };
  } catch {
    return { google: false, microsoft: false, adfs: false, saml: false };
  }
}

// Verify the grant token carried back from the OAuth callback. The grant carries
// its own provider, so this endpoint is provider-agnostic. Returns the user to
// sign in as, or null when the token is missing/forged/expired.
export async function verifyOAuthGrant(token: string): Promise<OAuthUser | null> {
  try {
    const response = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { user?: OAuthUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

// Admin config read (Settings → Sign-in), per provider.
export async function fetchOAuthSettings(provider: OAuthProvider): Promise<OAuthSettings> {
  const response = await fetch(`/api/settings/oauth/${provider}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error((await readError(response)) ?? 'Unable to load sign-in settings.');
  }
  return response.json() as Promise<OAuthSettings>;
}

export async function saveOAuthSettings(
  provider: OAuthProvider,
  input: OAuthSettingsInput,
): Promise<OAuthSettings> {
  const response = await fetch(`/api/settings/oauth/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) ?? 'Unable to save sign-in settings.');
  }
  return response.json() as Promise<OAuthSettings>;
}

export type { MutationResult };
