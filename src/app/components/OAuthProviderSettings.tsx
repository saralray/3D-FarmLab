import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card } from './ui/card';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Button } from './ui/button';
import {
  fetchOAuthSettings,
  saveOAuthSettings,
  type OAuthProvider,
} from '../lib/oauthApi';

interface OAuthProviderSettingsProps {
  provider: OAuthProvider;
  label: string;
  // Shows authority URL + tenant ID fields (Microsoft cloud / on-prem AD FS).
  showTenant?: boolean;
  // Shows just the authority URL field without the tenant ID (ADFS).
  showAuthority?: boolean;
  // Shows a "Button label" field to customise the login-page button text.
  showDisplayName?: boolean;
  // Only admins may change these; others see a read-only form.
  disabled?: boolean;
  clientIdPlaceholder?: string;
  // Placeholder for the authority URL input.
  authorityPlaceholder?: string;
  // Overrides the redirect URI hint with a full absolute URL. Use when the
  // provider has a fixed, pre-registered redirect URI (e.g. ADFS).
  callbackUrl?: string;
  // Short admin-facing description of where to create the OAuth client.
  setupHint: React.ReactNode;
}

// One provider's SSO config (Settings → Sign-in). Self-contained: loads its own
// settings on mount and saves them on submit. The client secret is write-only —
// the server returns only whether one is stored, so a blank field on save keeps
// the existing secret.
export function OAuthProviderSettings({
  provider,
  label,
  showTenant = false,
  showAuthority = false,
  showDisplayName = false,
  disabled = false,
  clientIdPlaceholder,
  authorityPlaceholder = 'https://sso.example.com/adfs',
  callbackUrl: callbackUrlOverride,
  setupHint,
}: OAuthProviderSettingsProps) {
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [tenant, setTenant] = useState('');
  const [authority, setAuthority] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOAuthSettings(provider)
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setEnabled(settings.enabled);
        setClientId(settings.clientId);
        setHasSecret(settings.hasClientSecret);
        setTenant(settings.tenant);
        setAuthority(settings.authority);
        setAllowedDomains(settings.allowedDomains.join('\n'));
        setDisplayName(settings.displayName);
      })
      .catch(() => {
        toast.error(`Unable to load ${label} sign-in settings.`);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, label]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) {
      toast.error('Only admins can change sign-in settings.');
      return;
    }

    const trimmedClientId = clientId.trim();
    const trimmedTenant = tenant.trim();
    const trimmedAuthority = authority.trim();
    const domains = allowedDomains
      .split(/[\s,]+/)
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);

    // Can't enable the flow without a client id, and without a secret already on
    // file the server can't complete the token exchange. Microsoft also needs
    // either a cloud Tenant ID or an AD FS authority URL.
    if (enabled) {
      if (!trimmedClientId || (!hasSecret && !clientSecret.trim())) {
        toast.error(`Client ID and Client Secret are required to enable ${label} sign-in.`);
        return;
      }
      if (showTenant && !trimmedTenant && !trimmedAuthority) {
        toast.error(`A Tenant ID or AD FS authority URL is required to enable ${label} sign-in.`);
        return;
      }
      if (showAuthority && !trimmedAuthority) {
        toast.error(`An authority URL is required to enable ${label} sign-in.`);
        return;
      }
    }

    setSaving(true);
    try {
      const saved = await saveOAuthSettings(provider, {
        enabled,
        clientId: trimmedClientId,
        tenant: trimmedTenant,
        authority: trimmedAuthority,
        clientSecret: clientSecret.trim(),
        allowedDomains: domains,
        displayName: displayName.trim(),
      });
      setEnabled(saved.enabled);
      setClientId(saved.clientId);
      setHasSecret(saved.hasClientSecret);
      setTenant(saved.tenant);
      setAuthority(saved.authority);
      setAllowedDomains(saved.allowedDomains.join('\n'));
      setDisplayName(saved.displayName);
      setClientSecret('');
      toast.success(`${label} sign-in settings saved.`);
    } catch (error) {
      toast.error(`Unable to save ${label} sign-in settings.`, {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const callbackUrl = callbackUrlOverride ?? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/auth/${provider}/callback`;

  return (
    <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
      <form onSubmit={handleSave} className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold dark:text-white">{label} sign-in</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Let people sign in with a {label} account. Everyone who signs in this
            way gets the read-only <span className="font-medium">student</span> role.{' '}
            {setupHint} Register{' '}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-700">{callbackUrl}</code>{' '}
            as a redirect URI.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div>
            <Label htmlFor={`oauth-enabled-${provider}`} className="text-base">
              Enable {label} sign-in
            </Label>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Shows a “Sign in with {label}” button on the login page.
            </p>
          </div>
          <Switch
            id={`oauth-enabled-${provider}`}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={disabled}
          />
        </div>

        {(showTenant || showAuthority) && (
          <div className="space-y-2">
            <Label htmlFor={`oauth-authority-${provider}`}>
              {showAuthority && !showTenant ? 'ADFS Authority URL' : 'AD FS authority URL (optional)'}
            </Label>
            <Input
              id={`oauth-authority-${provider}`}
              value={authority}
              onChange={(e) => setAuthority(e.target.value)}
              placeholder={authorityPlaceholder}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {showAuthority && !showTenant ? (
                <>
                  Base URL of the ADFS server (the <code>/adfs</code> deep link).
                  Endpoints used are{' '}
                  <code>&lt;authority&gt;/oauth2/authorize</code> and{' '}
                  <code>/oauth2/token</code>.
                </>
              ) : (
                <>
                  For on-prem <span className="font-medium">AD FS</span>, enter the
                  base URL (the <code>/adfs</code> deep link). The OIDC endpoints used
                  are <code>&lt;authority&gt;/oauth2/authorize</code> and{' '}
                  <code>/oauth2/token</code>. Leave blank to use the Microsoft cloud
                  (Entra ID) with the Tenant ID below.
                </>
              )}
            </p>
          </div>
        )}

        {showTenant && (
          <div className="space-y-2">
            <Label htmlFor={`oauth-tenant-${provider}`}>Tenant ID</Label>
            <Input
              id={`oauth-tenant-${provider}`}
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="Directory (tenant) ID, or common / organizations"
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Cloud only — the Azure AD directory (tenant) ID. Use a specific
              tenant GUID to limit sign-in to your organization, or{' '}
              <code>common</code> to allow any Microsoft account. Ignored when an
              AD FS authority URL is set above.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={`oauth-client-id-${provider}`}>Client ID</Label>
          <Input
            id={`oauth-client-id-${provider}`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={clientIdPlaceholder}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`oauth-client-secret-${provider}`}>Client Secret</Label>
          <Input
            id={`oauth-client-secret-${provider}`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={hasSecret ? '•••••••• (leave blank to keep)' : 'Enter the client secret'}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {hasSecret
              ? 'A client secret is stored. Leave blank to keep it, or enter a new one to replace it.'
              : 'No client secret stored yet.'}
          </p>
        </div>

        {showDisplayName && (
          <div className="space-y-2">
            <Label htmlFor={`oauth-display-name-${provider}`}>Button label</Label>
            <Input
              id={`oauth-display-name-${provider}`}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={`Sign in with ${label}`}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Text shown on the sign-in button. Leave blank to use the default
              "Sign in with {label}".
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={`oauth-domains-${provider}`}>Allowed email domains</Label>
          <Textarea
            id={`oauth-domains-${provider}`}
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
            placeholder={'school.edu\nexample.org'}
            rows={3}
            disabled={disabled}
            spellCheck={false}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            One domain per line (or comma-separated). Leave empty to allow any{' '}
            {label} account with a verified email.
          </p>
        </div>

        <Button type="submit" disabled={saving || disabled}>
          {saving ? 'Saving...' : `Save ${label} settings`}
        </Button>
      </form>
    </Card>
  );
}
