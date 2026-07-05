import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Download, FileCode2 } from 'lucide-react';
import { Card } from './ui/card';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  fetchSamlMetadata,
  fetchSamlSettings,
  saveSamlSettings,
  testSamlSettings,
  SAML_METADATA_URL,
  type SamlSettings,
  type SamlTestResult,
} from '../lib/samlApi';

interface SamlSsoSettingsProps {
  // Only admins may change SSO settings; others get a read-only form.
  disabled?: boolean;
}

// Client-side mirrors of the server validation, so obvious mistakes are caught
// before the round-trip.
function isHttpUrl(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeCertificate(value: string): boolean {
  const body = value
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return body.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(body);
}

// SAML 2.0 SSO configuration (Settings → SSO Configuration). Self-contained:
// loads its own config on mount, validates and saves on submit, and offers
// Test / View Metadata / Download Metadata actions. The dashboard is the SP.
export function SamlSsoSettings({ disabled = false }: SamlSsoSettingsProps) {
  const [enabled, setEnabled] = useState(false);
  const [idpEntityId, setIdpEntityId] = useState('');
  const [idpSsoUrl, setIdpSsoUrl] = useState('');
  const [idpCertificate, setIdpCertificate] = useState('');
  const [spEntityId, setSpEntityId] = useState('');
  const [acsUrl, setAcsUrl] = useState('');
  const [autoProvisionUsers, setAutoProvisionUsers] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [defaults, setDefaults] = useState({ spEntityId: '', acsUrl: '' });

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SamlTestResult | null>(null);
  const [metadataXml, setMetadataXml] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);

  const applySettings = (settings: SamlSettings) => {
    setEnabled(settings.enabled);
    setIdpEntityId(settings.idpEntityId);
    setIdpSsoUrl(settings.idpSsoUrl);
    setIdpCertificate(settings.idpCertificate);
    setSpEntityId(settings.spEntityId);
    setAcsUrl(settings.acsUrl);
    setAutoProvisionUsers(settings.autoProvisionUsers);
    setDisplayName(settings.displayName);
    setUpdatedAt(settings.updatedAt);
    setDefaults({ spEntityId: settings.defaultSpEntityId, acsUrl: settings.defaultAcsUrl });
  };

  useEffect(() => {
    let cancelled = false;
    fetchSamlSettings()
      .then((settings) => {
        if (!cancelled) {
          applySettings(settings);
        }
      })
      .catch(() => {
        toast.error('Unable to load SSO settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Validate the current form. Returns an error message or null when valid.
  const validate = (): string | null => {
    for (const [label, value] of [
      ['IdP SSO URL', idpSsoUrl],
      ['SP Entity ID', spEntityId],
      ['ACS URL', acsUrl],
    ] as const) {
      if (value.trim() && !isHttpUrl(value)) {
        return `${label} must be a valid http(s) URL.`;
      }
    }
    if (idpCertificate.trim() && !looksLikeCertificate(idpCertificate)) {
      return 'IdP Certificate is not a valid X.509 certificate.';
    }
    if (enabled && (!idpSsoUrl.trim() || !idpCertificate.trim())) {
      return 'An IdP SSO URL and certificate are required to enable SSO.';
    }
    return null;
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) {
      toast.error('Only admins can change SSO settings.');
      return;
    }
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }

    setSaving(true);
    try {
      const saved = await saveSamlSettings({
        enabled,
        idpEntityId: idpEntityId.trim(),
        idpSsoUrl: idpSsoUrl.trim(),
        idpCertificate: idpCertificate.trim(),
        spEntityId: spEntityId.trim(),
        acsUrl: acsUrl.trim(),
        autoProvisionUsers,
        displayName: displayName.trim(),
      });
      applySettings(saved);
      toast.success('SSO configuration saved.');
    } catch (saveError) {
      toast.error('Unable to save SSO configuration.', {
        description: saveError instanceof Error ? saveError.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testSamlSettings({
        idpSsoUrl: idpSsoUrl.trim(),
        idpCertificate: idpCertificate.trim(),
      });
      setTestResult(result);
      if (result.ok) {
        toast.success('SSO configuration looks good.');
      } else {
        toast.error('SSO configuration has issues — see the checks below.');
      }
    } catch (testError) {
      toast.error('Unable to test SSO configuration.', {
        description: testError instanceof Error ? testError.message : undefined,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleViewMetadata = async () => {
    try {
      const xml = await fetchSamlMetadata();
      setMetadataXml(xml);
      setMetadataOpen(true);
    } catch {
      toast.error('Unable to load metadata XML.');
    }
  };

  const handleDownloadMetadata = async () => {
    try {
      const xml = await fetchSamlMetadata();
      const blob = new Blob([xml], { type: 'application/samlmetadata+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sp-metadata.xml';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Unable to download metadata XML.');
    }
  };

  const callbackUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${SAML_METADATA_URL}` : SAML_METADATA_URL;

  return (
    <Card className="p-6">
      <form onSubmit={handleSave} className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-foreground">SSO Configuration</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in against an external SAML 2.0 identity provider. This dashboard
            acts as the Service Provider (SP). Share its metadata with your IdP from{' '}
            <code className="rounded bg-muted px-1">{callbackUrl}</code>.
            {updatedAt && (
              <>
                {' '}
                Last updated{' '}
                <span className="font-medium">{new Date(updatedAt).toLocaleString()}</span>.
              </>
            )}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div>
            <Label htmlFor="saml-enabled" className="text-base">
              Enable SSO
            </Label>
            <p className="text-sm text-muted-foreground">
              Shows a “Sign in with SSO” button on the login page.
            </p>
          </div>
          <Switch
            id="saml-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-idp-entity-id">IdP Entity ID</Label>
          <Input
            id="saml-idp-entity-id"
            value={idpEntityId}
            onChange={(e) => setIdpEntityId(e.target.value)}
            placeholder="https://idp.example.com"
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-idp-sso-url">IdP SSO URL</Label>
          <Input
            id="saml-idp-sso-url"
            value={idpSsoUrl}
            onChange={(e) => setIdpSsoUrl(e.target.value)}
            placeholder="https://idp.example.com/adfs/ls/"
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            The IdP single sign-on endpoint the login redirect points at (HTTP-Redirect binding).
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-idp-cert">IdP Certificate</Label>
          <Textarea
            id="saml-idp-cert"
            value={idpCertificate}
            onChange={(e) => setIdpCertificate(e.target.value)}
            placeholder={'-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----'}
            rows={6}
            disabled={disabled}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            The IdP’s public signing certificate (PEM). Assertions are verified against this.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-sp-entity-id">SP Entity ID</Label>
          <Input
            id="saml-sp-entity-id"
            value={spEntityId}
            onChange={(e) => setSpEntityId(e.target.value)}
            placeholder={defaults.spEntityId || 'https://your-dashboard/api/auth/saml/metadata'}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            This dashboard’s entity ID. Leave blank to use{' '}
            <code className="rounded bg-muted px-1">{defaults.spEntityId}</code>.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-acs-url">ACS URL</Label>
          <Input
            id="saml-acs-url"
            value={acsUrl}
            onChange={(e) => setAcsUrl(e.target.value)}
            placeholder={defaults.acsUrl || 'https://your-dashboard/api/auth/saml/acs'}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Where the IdP posts the SAML response. Leave blank to use{' '}
            <code className="rounded bg-muted px-1">{defaults.acsUrl}</code>.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div>
            <Label htmlFor="saml-auto-provision" className="text-base">
              Auto Provision Users
            </Label>
            <p className="text-sm text-muted-foreground">
              When on, anyone the IdP authenticates may sign in (role taken from the
              assertion). When off, only existing staff accounts may sign in.
            </p>
          </div>
          <Switch
            id="saml-auto-provision"
            checked={autoProvisionUsers}
            onCheckedChange={setAutoProvisionUsers}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="saml-display-name">Button label</Label>
          <Input
            id="saml-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Sign in with SSO"
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Text shown on the sign-in button. Leave blank to use the default
            "Sign in with SSO".
          </p>
        </div>

        {testResult && (
          <div className="space-y-2 rounded-lg border border-border p-4">
            <p className="text-sm font-medium text-foreground">Test results</p>
            <ul className="space-y-1">
              {testResult.checks.map((check) => (
                <li key={check.label} className="flex items-start gap-2 text-sm">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                  )}
                  <span className="text-foreground">
                    {check.label}
                    {check.detail ? (
                      <span className="text-muted-foreground"> — {check.detail}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={saving || disabled}>
            {saving ? 'Saving...' : 'Save Configuration'}
          </Button>
          <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing...' : 'Test SSO Configuration'}
          </Button>
          <Button type="button" variant="outline" onClick={handleViewMetadata} className="gap-2">
            <FileCode2 className="size-4" />
            View Metadata XML
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleDownloadMetadata}
            className="gap-2"
          >
            <Download className="size-4" />
            Download Metadata XML
          </Button>
        </div>
      </form>

      <Dialog open={metadataOpen} onOpenChange={setMetadataOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>SP Metadata XML</DialogTitle>
            <DialogDescription>
              Import this into your identity provider to register this dashboard as a
              Service Provider.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-4 text-xs text-foreground">
            {metadataXml}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
