import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bell, Check, Copy, House, Image as ImageIcon, KeyRound, MonitorCheck, Settings as SettingsIcon, Shield, Trash2, Users, Wrench, X } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Slider } from '../components/ui/slider';
import defaultLogo from '../assets/printer-logo.svg';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { SoftwareUpdateSettings } from '../components/SoftwareUpdateSettings';
import { BackupSettings } from '../components/BackupSettings';
import { useAuth } from '../contexts/AuthContext';
import { ADMIN_USERNAME } from '../lib/runtimeConfig';
import { Printer, PrinterProfile } from '../types';
import {
  DiscordWebhook,
  fetchDiscordWebhooks,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_KEYS,
  removeDiscordWebhook,
  saveDiscordWebhook,
} from '../lib/notificationsApi';
import {
  CreatedSlicerKey,
  SlicerApiKey,
  SlicerKeyPermission,
  SLICER_KEY_PERMISSION_OPTIONS,
  createSlicerKey,
  fetchSlicerKeys,
  removeSlicerKey,
} from '../lib/slicerKeysApi';
import {
  ManagerRequest,
  approveManagerRequest,
  denyManagerRequest,
  fetchManagerRequests,
  revokeManagerAccess,
} from '../lib/managerRequestsApi';
import { fetchPrinters, savePrinter } from '../lib/printersApi';
import { generateId, slugifyPrinterId } from '../lib/id';
import {
  isBambuProfile,
  normalizePrinter,
  PRINTER_PROFILES,
  PRINTER_PROVIDER_GROUPS,
} from '../lib/printerProfiles';
import {
  fetchBrandingSettings,
  saveBrandingSettings,
  DEFAULT_SITE_NAME,
} from '../lib/settingsApi';
import { OAuthProviderSettings } from '../components/OAuthProviderSettings';
import { HomeAssistantSettings } from '../components/HomeAssistantSettings';
import { SamlSsoSettings } from '../components/SamlSsoSettings';
import { fetchEnabledOAuthProviders } from '../lib/oauthApi';
import {
  fetchPublicViewerSetting,
  savePublicViewerSetting,
} from '../lib/publicViewerApi';
import { fetchSsoPublicUrl, saveSsoPublicUrl } from '../lib/ssoApi';
import { fetchPrinterCallbackUrl, savePrinterCallbackUrl } from '../lib/printerCallbackApi';

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Drives both the desktop tab bar and the mobile section picker so the two never
// drift apart. Ordered by how often each section is touched.
const SETTINGS_TABS = [
  { value: 'manage-printers', label: 'Printers', icon: SettingsIcon },
  { value: 'add-user', label: 'Users', icon: Users },
  { value: 'branding', label: 'Branding', icon: ImageIcon },
  { value: 'notifications', label: 'Notifications', icon: Bell },
  { value: 'slicer-upload', label: 'API Keys', icon: KeyRound },
  { value: 'managers', label: 'Managers', icon: MonitorCheck },
  { value: 'system', label: 'System', icon: Wrench },
  { value: 'home-assistant', label: 'Home Assistant', icon: House },
  { value: 'sign-in', label: 'Sign-in', icon: Shield },
] as const;

export function Settings() {
  const { user, users, createUser, removeUser, changeUserPassword, changeUserRole, changeAdminPassword } =
    useAuth();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [printerProfile, setPrinterProfile] = useState<PrinterProfile>('generic');
  const [printerIpAddress, setPrinterIpAddress] = useState('');
  const [printerApiKeyHeader, setPrinterApiKeyHeader] = useState('');
  const [printerSerial, setPrinterSerial] = useState('');
  const [printerPrintHours, setPrinterPrintHours] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  // The admin account is server-backed and requires the current password to
  // change it; this holds that "current password" entry for the admin's own row.
  const [currentPasswordDraft, setCurrentPasswordDraft] = useState('');
  const [changingPasswordUserId, setChangingPasswordUserId] = useState<string | null>(null);
  const [changingRoleUserId, setChangingRoleUserId] = useState<string | null>(null);
  const [discordWebhooks, setDiscordWebhooks] = useState<DiscordWebhook[]>([]);
  const [webhookName, setWebhookName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [removingWebhookId, setRemovingWebhookId] = useState<string | null>(null);
  const [eventsWebhookId, setEventsWebhookId] = useState<string | null>(null);
  const [eventsDraft, setEventsDraft] = useState<string[]>([]);
  const [savingEvents, setSavingEvents] = useState(false);
  const [togglingWebhookId, setTogglingWebhookId] = useState<string | null>(null);
  const [siteName, setSiteName] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [logoSvg, setLogoSvg] = useState('');
  const [logoAdaptive, setLogoAdaptive] = useState(false);
  const [logoScale, setLogoScale] = useState(1);
  const [backgroundDataUrl, setBackgroundDataUrl] = useState('');
  const [faviconDataUrl, setFaviconDataUrl] = useState('');
  const [savingBranding, setSavingBranding] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [savingBackground, setSavingBackground] = useState(false);
  const [savingFavicon, setSavingFavicon] = useState(false);
  const [slicerKeys, setSlicerKeys] = useState<SlicerApiKey[]>([]);
  const [slicerKeyName, setSlicerKeyName] = useState('');
  const [slicerKeyPermissions, setSlicerKeyPermissions] = useState<SlicerKeyPermission[]>(['slicer_upload']);
  const [savingSlicerKey, setSavingSlicerKey] = useState(false);
  const [removingSlicerKeyId, setRemovingSlicerKeyId] = useState<string | null>(null);
  const [createdSlicerKey, setCreatedSlicerKey] = useState<CreatedSlicerKey | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [managerRequests, setManagerRequests] = useState<ManagerRequest[]>([]);
  const [actioningManagerId, setActioningManagerId] = useState<string | null>(null);
  // Which SSO provider's config form to show. Only one provider is configured at
  // a time — the admin picks before the form appears.
  const [ssoProvider, setSsoProvider] = useState<'google' | 'microsoft' | 'adfs' | 'saml'>('google');
  // Website access mode: whether an unauthenticated visitor can view the
  // dashboard read-only, or is sent to the login screen.
  const [publicViewerEnabled, setPublicViewerEnabled] = useState(true);
  const [savingPublicViewer, setSavingPublicViewer] = useState(false);
  // Admin override for the site's own public URL (used to build SSO callback
  // URLs — see the "SSO public URL" card in the Sign-in tab).
  const [ssoPublicUrl, setSsoPublicUrl] = useState('');
  const [ssoPublicUrlEnvFallback, setSsoPublicUrlEnvFallback] = useState('');
  const [savingSsoPublicUrl, setSavingSsoPublicUrl] = useState(false);
  // LAN address H2-series Bambu printers use to fetch a staged print file back
  // from slicer-proxy (see the "Printer callback URL" card in Slicer Upload).
  const [printerCallbackUrl, setPrinterCallbackUrl] = useState('');
  const [savingPrinterCallbackUrl, setSavingPrinterCallbackUrl] = useState(false);
  // Controlled so the desktop tab bar and the mobile section dropdown stay in sync.
  const [activeTab, setActiveTab] = useState<string>('manage-printers');

  useEffect(() => {
    fetchPrinters()
      .then((storedPrinters) => setPrinters(storedPrinters.map(normalizePrinter)))
      .catch(() => {
        toast.error('Unable to load printers from Postgres. Check DATABASE_URL and server access.');
      });

    fetchDiscordWebhooks()
      .then(setDiscordWebhooks)
      .catch(() => {
        toast.error('Unable to load Discord webhooks.');
      });

    fetchBrandingSettings()
      .then((settings) => {
        setSiteName(settings.siteName);
        setLogoDataUrl(settings.logoDataUrl);
        setLogoSvg(settings.logoSvg);
        setLogoAdaptive(settings.logoAdaptive);
        setLogoScale(settings.logoScale);
        setFaviconDataUrl(settings.faviconDataUrl);
        setBackgroundDataUrl(settings.backgroundDataUrl);
      })
      .catch(() => {
        toast.error('Unable to load branding settings.');
      });

    fetchSlicerKeys()
      .then(setSlicerKeys)
      .catch(() => {
        toast.error('Unable to load slicer API keys.');
      });

    fetchManagerRequests()
      .then(setManagerRequests)
      .catch(() => {
        toast.error('Unable to load manager requests.');
      });

    // Open the Sign-in tab on whichever SSO provider is currently active.
    fetchEnabledOAuthProviders()
      .then((providers) => {
        if (providers.saml && !providers.google && !providers.microsoft && !providers.adfs) {
          setSsoProvider('saml');
        } else if (providers.adfs && !providers.google && !providers.microsoft) {
          setSsoProvider('adfs');
        } else if (providers.microsoft && !providers.google) {
          setSsoProvider('microsoft');
        }
      })
      .catch(() => {
        /* non-fatal — defaults to Google */
      });

    fetchPublicViewerSetting()
      .then((setting) => setPublicViewerEnabled(setting.enabled))
      .catch(() => {
        /* non-fatal — defaults to enabled */
      });

    fetchSsoPublicUrl()
      .then((setting) => {
        setSsoPublicUrl(setting.publicUrl);
        setSsoPublicUrlEnvFallback(setting.envFallback);
      })
      .catch(() => {
        /* non-fatal — blank falls back to APP_BASE_URL / header detection */
      });

    fetchPrinterCallbackUrl()
      .then((setting) => setPrinterCallbackUrl(setting.url))
      .catch(() => {
        /* non-fatal — blank falls back to best-effort header detection */
      });
  }, []);

  const handleTogglePublicViewer = async (enabled: boolean) => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the website access mode.');
      return;
    }
    setSavingPublicViewer(true);
    try {
      const saved = await savePublicViewerSetting(enabled);
      setPublicViewerEnabled(saved.enabled);
      toast.success(
        saved.enabled
          ? 'Public viewing enabled — visitors can see the dashboard without signing in.'
          : 'Public viewing disabled — visitors must sign in to see the dashboard.',
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Unable to update website access mode.',
      );
    } finally {
      setSavingPublicViewer(false);
    }
  };

  const handleSaveSsoPublicUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the SSO public URL.');
      return;
    }
    setSavingSsoPublicUrl(true);
    try {
      const saved = await saveSsoPublicUrl(ssoPublicUrl.trim());
      setSsoPublicUrl(saved.publicUrl);
      setSsoPublicUrlEnvFallback(saved.envFallback);
      toast.success('SSO public URL saved.');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Unable to save the SSO public URL.',
      );
    } finally {
      setSavingSsoPublicUrl(false);
    }
  };

  const handleSavePrinterCallbackUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the printer callback URL.');
      return;
    }
    setSavingPrinterCallbackUrl(true);
    try {
      const saved = await savePrinterCallbackUrl(printerCallbackUrl.trim());
      setPrinterCallbackUrl(saved.url);
      toast.success('Printer callback URL saved.');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Unable to save the printer callback URL.',
      );
    } finally {
      setSavingPrinterCallbackUrl(false);
    }
  };

  const refreshPrinters = async () => {
    const storedPrinters = await fetchPrinters();
    setPrinters(storedPrinters.map(normalizePrinter));
  };

  const refreshDiscordWebhooks = async () => {
    const storedWebhooks = await fetchDiscordWebhooks();
    setDiscordWebhooks(storedWebhooks);
  };

  const handleCreatePrinter = async (event: React.FormEvent) => {
    event.preventDefault();

    if (user?.role !== 'admin') {
      toast.error('Only admins can add printers.');
      return;
    }

    const normalizedName = printerName.trim();
    const normalizedIpAddress = printerIpAddress.trim();
    const normalizedApiKeyHeader = printerApiKeyHeader.trim();
    const normalizedSerial = printerSerial.trim();
    const parsedHours = Number(printerPrintHours);
    const seedHours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 0;
    const profileConfig = PRINTER_PROFILES[printerProfile];

    if (!normalizedName || !normalizedIpAddress || !normalizedApiKeyHeader) {
      toast.error(`Name, IP address, and ${profileConfig.credentialLabel} are required.`);
      return;
    }

    if (isBambuProfile(printerProfile) && !normalizedSerial) {
      toast.error('Bambu Lab printers require the device serial number.');
      return;
    }

    if (!IPV4_PATTERN.test(normalizedIpAddress)) {
      toast.error('Enter a valid IPv4 address.');
      return;
    }

    if (printers.some((printer) => printer.ipAddress === normalizedIpAddress)) {
      toast.error('That IP address is already assigned to another printer.');
      return;
    }

    const nextPrinter: Printer = {
      id: slugifyPrinterId(normalizedName, printers.map((printer) => printer.id)),
      name: normalizedName,
      model: profileConfig.defaultModel,
      sortOrder: printers.length,
      profile: printerProfile,
      url: profileConfig.buildBaseUrl(normalizedIpAddress),
      ipAddress: normalizedIpAddress,
      apiKeyHeader: normalizedApiKeyHeader,
      serial: normalizedSerial || undefined,
      status: 'offline',
      temperature: {
        nozzle: 25,
        bed: 24,
      },
      progress: 0,
      lastMaintenance: new Date().toISOString().slice(0, 10),
      totalPrintTime: 0,
      successRate: 100,
      // Optional starting print-hour reading for an already-used printer. Seeds
      // both the lifetime and nozzle maintenance counters (server honors these
      // on create only).
      totalPrintHours: seedHours,
      currentNozzleHours: seedHours,
    };

    try {
      await savePrinter(nextPrinter);
      await refreshPrinters();
      setPrinterName('');
      setPrinterProfile('generic');
      setPrinterIpAddress('');
      setPrinterApiKeyHeader('');
      setPrinterSerial('');
      setPrinterPrintHours('');
      toast.success('Printer added', {
        description: 'Status will switch from offline once a live status check succeeds.',
      });
    } catch (error) {
      toast.error('Unable to save printer', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsCreatingUser(true);

    try {
      const result = await createUser({ name, username, password, role });
      if (!result.success) {
        toast.error(result.error ?? 'Unable to create user.');
        return;
      }

      setName('');
      setUsername('');
      setPassword('');
      setRole('operator');
      toast.success('User added', { description: username });
    } finally {
      setIsCreatingUser(false);
    }
  };

  const handleRemoveUser = async (userId: string) => {
    setRemovingUserId(userId);

    try {
      const result = await removeUser(userId);
      if (!result.success) {
        toast.error(result.error ?? 'Unable to remove user.');
        return;
      }

      toast.success('User removed');
    } finally {
      setRemovingUserId(null);
    }
  };

  const handleChangeUserPassword = async (userId: string) => {
    const account = users.find((candidate) => candidate.id === userId);
    const isAdminAccount = account?.username === ADMIN_USERNAME;
    setChangingPasswordUserId(userId);

    try {
      // The admin password lives server-side and is changed by re-supplying the
      // current password; other users are updated client-side as before.
      const result = isAdminAccount
        ? await changeAdminPassword(currentPasswordDraft, passwordDrafts[userId] ?? '')
        : await changeUserPassword(userId, passwordDrafts[userId] ?? '', currentPasswordDraft);
      if (!result.success) {
        toast.error(result.error ?? 'Unable to change password.');
        return;
      }

      setPasswordDrafts((prev) => ({
        ...prev,
        [userId]: '',
      }));
      // Both self-change paths (primary admin + staff) consume the current
      // password now, so always clear it.
      setCurrentPasswordDraft('');
      toast.success('Password updated');
    } finally {
      setChangingPasswordUserId(null);
    }
  };

  const handleChangeUserRole = async (userId: string, nextRole: 'admin' | 'operator' | 'viewer') => {
    const account = users.find((candidate) => candidate.id === userId);
    if (account && account.role === nextRole) {
      return;
    }
    setChangingRoleUserId(userId);
    try {
      const result = await changeUserRole(userId, nextRole);
      if (!result.success) {
        toast.error(result.error ?? 'Unable to change the role.');
        return;
      }
      toast.success('Role updated', { description: account ? `@${account.username} → ${nextRole}` : undefined });
    } finally {
      setChangingRoleUserId(null);
    }
  };

  const handleCreateWebhook = async (event: React.FormEvent) => {
    event.preventDefault();

    if (user?.role !== 'admin') {
      toast.error('Only admins can manage Discord notifications.');
      return;
    }

    const normalizedName = webhookName.trim();
    const normalizedWebhookUrl = webhookUrl.trim();

    if (!normalizedName || !normalizedWebhookUrl) {
      toast.error('Webhook name and Discord webhook URL are required.');
      return;
    }

    if (!normalizedWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      toast.error('Enter a valid Discord webhook URL.');
      return;
    }

    setSavingWebhook(true);

    try {
      await saveDiscordWebhook({
        id: generateId(),
        name: normalizedName,
        webhookUrl: normalizedWebhookUrl,
      });
      await refreshDiscordWebhooks();
      setWebhookName('');
      setWebhookUrl('');
      toast.success('Discord webhook added', { description: normalizedName });
    } catch (error) {
      toast.error('Unable to save Discord webhook', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingWebhook(false);
    }
  };

  const refreshSlicerKeys = async () => {
    setSlicerKeys(await fetchSlicerKeys());
  };

  const refreshManagerRequests = async () => {
    setManagerRequests(await fetchManagerRequests());
  };

  const handleApproveManager = async (id: string) => {
    setActioningManagerId(id);
    try {
      await approveManagerRequest(id);
      await refreshManagerRequests();
      await refreshSlicerKeys();
      toast.success('Manager access approved');
    } catch (err) {
      toast.error('Unable to approve', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActioningManagerId(null);
    }
  };

  const handleDenyManager = async (id: string) => {
    setActioningManagerId(id);
    try {
      await denyManagerRequest(id);
      await refreshManagerRequests();
      toast.success('Manager access denied');
    } catch (err) {
      toast.error('Unable to deny', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActioningManagerId(null);
    }
  };

  const handleRevokeManager = async (id: string) => {
    setActioningManagerId(id);
    try {
      await revokeManagerAccess(id);
      await refreshManagerRequests();
      await refreshSlicerKeys();
      toast.success('Manager access revoked');
    } catch (err) {
      toast.error('Unable to revoke', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActioningManagerId(null);
    }
  };

  const toggleSlicerKeyPermission = (permission: SlicerKeyPermission, checked: boolean) => {
    setSlicerKeyPermissions((current) =>
      checked ? Array.from(new Set([...current, permission])) : current.filter((p) => p !== permission),
    );
  };

  const handleCreateSlicerKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreatedSlicerKey(null);
    setCopiedKey(false);

    if (user?.role !== 'admin') {
      toast.error('Only admins can manage slicer API keys.');
      return;
    }

    const normalizedName = slicerKeyName.trim();
    if (!normalizedName) {
      toast.error('Key name is required.');
      return;
    }

    if (slicerKeyPermissions.length === 0) {
      toast.error('Select at least one permission for the key.');
      return;
    }

    setSavingSlicerKey(true);

    try {
      const created = await createSlicerKey(normalizedName, slicerKeyPermissions);
      await refreshSlicerKeys();
      setSlicerKeyName('');
      setSlicerKeyPermissions(['slicer_upload']);
      setCreatedSlicerKey(created);
      toast.success('Key created', { description: 'Copy it now — it will not be shown again.' });
    } catch (error) {
      toast.error('Unable to create slicer API key', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingSlicerKey(false);
    }
  };

  const handleCopyCreatedKey = async () => {
    if (!createdSlicerKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdSlicerKey.key);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      toast.error('Unable to copy to clipboard — select and copy the key manually.');
    }
  };

  const handleRemoveSlicerKey = async (keyId: string) => {
    setRemovingSlicerKeyId(keyId);

    try {
      await removeSlicerKey(keyId);
      await refreshSlicerKeys();
      toast.success('Slicer API key revoked');
    } catch (error) {
      toast.error('Unable to revoke slicer API key', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRemovingSlicerKeyId(null);
    }
  };

  const handleRemoveWebhook = async (webhookId: string) => {
    setRemovingWebhookId(webhookId);

    try {
      await removeDiscordWebhook(webhookId);
      await refreshDiscordWebhooks();
      toast.success('Discord webhook removed');
    } catch (error) {
      toast.error('Unable to remove Discord webhook', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRemovingWebhookId(null);
    }
  };

  // events === null/undefined means the webhook receives every event, so the
  // editor starts with every checkbox ticked.
  const resolveWebhookEvents = (webhook: DiscordWebhook): string[] =>
    Array.isArray(webhook.events) ? webhook.events : NOTIFICATION_EVENT_KEYS;

  const handleEventsOpenChange = (webhook: DiscordWebhook, open: boolean) => {
    if (open) {
      setEventsWebhookId(webhook.id);
      setEventsDraft(resolveWebhookEvents(webhook));
    } else if (eventsWebhookId === webhook.id) {
      setEventsWebhookId(null);
    }
  };

  const toggleEventDraft = (key: string, checked: boolean) => {
    setEventsDraft((current) =>
      checked
        ? Array.from(new Set([...current, key]))
        : current.filter((eventKey) => eventKey !== key),
    );
  };

  const handleSaveEvents = async (webhook: DiscordWebhook) => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can manage Discord notifications.');
      return;
    }

    setSavingEvents(true);

    try {
      // Persist the explicit list (canonical order); an empty list means the
      // webhook is muted for every event.
      const events = NOTIFICATION_EVENT_KEYS.filter((key) => eventsDraft.includes(key));
      await saveDiscordWebhook({ ...webhook, events });
      await refreshDiscordWebhooks();
      setEventsWebhookId(null);
      toast.success('Notification settings updated', { description: webhook.name });
    } catch (error) {
      toast.error('Unable to update notification settings', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingEvents(false);
    }
  };

  // events === null/undefined and enabled === undefined both mean "on" (historical
  // default), so a webhook is only muted when enabled is explicitly false.
  const isWebhookEnabled = (webhook: DiscordWebhook): boolean => webhook.enabled !== false;

  const handleToggleEnabled = async (webhook: DiscordWebhook, enabled: boolean) => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can manage Discord notifications.');
      return;
    }

    setTogglingWebhookId(webhook.id);

    try {
      await saveDiscordWebhook({ ...webhook, enabled });
      await refreshDiscordWebhooks();
      if (enabled) {
        toast.success('Notifications enabled', { description: webhook.name });
      } else {
        toast.warning('Notifications muted', { description: webhook.name });
      }
    } catch (error) {
      toast.error('Unable to update notification settings', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setTogglingWebhookId(null);
    }
  };

  const isWebhookTts = (webhook: DiscordWebhook): boolean => webhook.tts === true;

  const handleToggleTts = async (webhook: DiscordWebhook, tts: boolean) => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can manage Discord notifications.');
      return;
    }

    setTogglingWebhookId(webhook.id);

    try {
      await saveDiscordWebhook({ ...webhook, tts });
      await refreshDiscordWebhooks();
      toast.success(tts ? 'Text-to-speech enabled' : 'Text-to-speech disabled', {
        description: webhook.name,
      });
    } catch (error) {
      toast.error('Unable to update notification settings', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setTogglingWebhookId(null);
    }
  };

  // ~512 KB raw image — matches the server's MAX_LOGO_DATA_URL_BYTES cap once
  // base64-encoded. Keeping the check client-side too gives instant feedback.
  const MAX_LOGO_BYTES = 512 * 1024;

  const handleLogoFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later by clearing the input value.
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file (PNG, JPEG, WebP, GIF, or SVG).');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Logo image is too large (max 512 KB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLogoDataUrl(reader.result);
        // The theme-adaptive SVG is produced server-side on save; clear any stale
        // processed markup so the preview falls back to the raw image until then.
        setLogoSvg('');
        setLogoAdaptive(false);
      }
    };
    reader.onerror = () => toast.error('Could not read the selected image.');
    reader.readAsDataURL(file);
  };

  // Branding (name, color, logo, background) is read once at app start by
  // BrandingApplier and the various useBrandingSettings consumers, so after a
  // save the simplest way to make it take effect everywhere is a full reload.
  // The short delay lets the success toast register before the page reloads.
  const reloadAfterSave = () => {
    setTimeout(() => window.location.reload(), 700);
  };

  const applyBranding = (saved: Awaited<ReturnType<typeof saveBrandingSettings>>) => {
    setSiteName(saved.siteName);
    setLogoDataUrl(saved.logoDataUrl);
    setLogoSvg(saved.logoSvg);
    setLogoAdaptive(saved.logoAdaptive);
    setLogoScale(saved.logoScale);
    setBackgroundDataUrl(saved.backgroundDataUrl);
    setFaviconDataUrl(saved.faviconDataUrl);
  };

  const handleSaveBranding = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site logo.');
      return;
    }
    setSavingBranding(true);
    try {
      // Send the full branding payload so saving the logo never wipes the
      // name/color/background (and vice versa).
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Logo saved', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to save logo', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingBranding(false);
    }
  };

  const handleResetBranding = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site logo.');
      return;
    }
    setSavingBranding(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl: '', logoScale: 1, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Logo reset to the default.', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to reset logo', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingBranding(false);
    }
  };

  // ~4 MB raw image — matches the server's MAX_BACKGROUND_DATA_URL_BYTES cap once
  // base64-encoded. A full-page background can be larger than the logo.
  const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024;

  const handleBackgroundFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later by clearing the input value.
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file (PNG, JPEG, WebP, GIF, or SVG).');
      return;
    }
    if (file.size > MAX_BACKGROUND_BYTES) {
      toast.error('Background image is too large (max 3 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setBackgroundDataUrl(reader.result);
      }
    };
    reader.onerror = () => toast.error('Could not read the selected image.');
    reader.readAsDataURL(file);
  };

  const handleSaveBackground = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site background.');
      return;
    }
    setSavingBackground(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Background saved', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to save background', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingBackground(false);
    }
  };

  const handleResetBackground = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site background.');
      return;
    }
    setSavingBackground(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl: '', faviconDataUrl });
      applyBranding(saved);
      toast.success('Background reset to the default theme.', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to reset background', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingBackground(false);
    }
  };

  const MAX_FAVICON_BYTES = 256 * 1024;

  const handleFaviconFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];
    if (!allowed.includes(file.type)) {
      toast.error('Please choose a PNG, SVG, ICO, JPEG, WebP, or GIF file.');
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      toast.error('Favicon is too large (max 256 KB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setFaviconDataUrl(reader.result);
    };
    reader.onerror = () => toast.error('Could not read the selected file.');
    reader.readAsDataURL(file);
  };

  const handleSaveFavicon = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site icon.');
      return;
    }
    setSavingFavicon(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Icon saved', { description: 'Reloading to apply it everywhere…' });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to save icon', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSavingFavicon(false);
    }
  };

  const handleResetFavicon = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site icon.');
      return;
    }
    setSavingFavicon(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl: '' });
      applyBranding(saved);
      toast.success('Icon reset to the default.', { description: 'Reloading to apply it everywhere…' });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to reset icon', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSavingFavicon(false);
    }
  };

  const handleSaveIdentity = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site name.');
      return;
    }
    setSavingIdentity(true);
    try {
      const saved = await saveBrandingSettings({ siteName, logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Site name saved.', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to save site name', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingIdentity(false);
    }
  };

  const handleResetIdentity = async () => {
    if (user?.role !== 'admin') {
      toast.error('Only admins can change the site name.');
      return;
    }
    setSavingIdentity(true);
    try {
      const saved = await saveBrandingSettings({ siteName: '', logoDataUrl, logoScale, backgroundDataUrl, faviconDataUrl });
      applyBranding(saved);
      toast.success('Site name reset to the default.', {
        description: 'Reloading to apply it everywhere…',
      });
      reloadAfterSave();
    } catch (error) {
      toast.error('Unable to reset site name', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingIdentity(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2 text-foreground">Settings</h1>
        <p className="text-muted-foreground">
          Configure printers, users, branding, integrations, and sign-in. Most actions are admin-only.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        {/* Mobile: a compact section picker keeps seven tabs from overflowing. */}
        <div className="sm:hidden">
          <Select value={activeTab} onValueChange={setActiveTab}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETTINGS_TABS.map((tab) => (
                <SelectItem key={tab.value} value={tab.value}>
                  <span className="flex items-center gap-2">
                    <tab.icon className="size-4" />
                    {tab.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Desktop / tablet: wrapping tab bar so no section is hidden off-screen. */}
        <TabsList className="hidden h-auto w-full flex-wrap justify-start gap-1 sm:flex">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="flex-none">
              <tab.icon className="size-4" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="manage-printers">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <SettingsIcon className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">Manage Printers</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Add new printers to the farm. Remove and reorder printers from the dashboard cards.
              </p>
            </div>

            <form onSubmit={handleCreatePrinter} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Printer Profile</Label>
                  <Select
                    value={printerProfile}
                    onValueChange={(value) => setPrinterProfile(value as PrinterProfile)}
                  >
                    <SelectTrigger>
                      {/* Show the full vendor + series name in the trigger; the
                          dropdown groups by vendor so each item only needs its series. */}
                      <SelectValue placeholder="Select a profile">
                        {PRINTER_PROFILES[printerProfile].label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PRINTER_PROVIDER_GROUPS.map((group) => (
                        <SelectGroup key={group.provider}>
                          <SelectLabel>{group.providerLabel}</SelectLabel>
                          {group.options.map((option) => (
                            <SelectItem key={option.profile} value={option.profile}>
                              {option.series}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="printer-name">Printer Name</Label>
                  <Input
                    id="printer-name"
                    value={printerName}
                    onChange={(event) => setPrinterName(event.target.value)}
                    placeholder="your printer's name"
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="printer-ip-address">Printer IP</Label>
                  <Input
                    id="printer-ip-address"
                    value={printerIpAddress}
                    onChange={(event) => setPrinterIpAddress(event.target.value.trim())}
                    placeholder="192.168.1.120"
                    inputMode="numeric"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="printer-api-key-header">
                    {PRINTER_PROFILES[printerProfile].credentialLabel}
                  </Label>
                  <Input
                    id="printer-api-key-header"
                    type="password"
                    value={printerApiKeyHeader}
                    onChange={(event) => setPrinterApiKeyHeader(event.target.value)}
                    placeholder={PRINTER_PROFILES[printerProfile].credentialPlaceholder}
                    autoComplete="off"
                    required
                  />
                </div>
              </div>

              {isBambuProfile(printerProfile) && (
                <div className="space-y-2">
                  <Label htmlFor="printer-serial">Serial Number</Label>
                  <Input
                    id="printer-serial"
                    value={printerSerial}
                    onChange={(event) => setPrinterSerial(event.target.value.trim())}
                    placeholder="e.g. 0309CA000000000"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Found on the printer (Settings → Device) or the Bambu Handy app. Required for live status over MQTT.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="printer-print-hours">Print Hours (optional)</Label>
                <Input
                  id="printer-print-hours"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={printerPrintHours}
                  onChange={(event) => setPrinterPrintHours(event.target.value)}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Starting lifetime print hours for an already-used printer; leave blank for a new machine. Seeds the maintenance schedule.
                </p>
              </div>

              <Button type="submit">Add Printer</Button>
            </form>
          </Card>
        </TabsContent>

        <TabsContent value="add-user">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Shield className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">Add User</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Admins can add admin and operator accounts without exposing credentials on the login screen.
              </p>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-user-name">Full Name</Label>
                  <Input
                    id="new-user-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Jane Operator"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new-user-username">Username</Label>
                  <Input
                    id="new-user-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.trimStart())}
                    placeholder="jane"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-user-password">Temporary Password</Label>
                  <Input
                    id="new-user-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label>User Role</Label>
                  <Select
                    value={role}
                    onValueChange={(value) => setRole(value as 'admin' | 'operator' | 'viewer')}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="operator">Operator</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button type="submit" disabled={isCreatingUser}>
                {isCreatingUser ? 'Adding user...' : 'Add User'}
              </Button>
            </form>

            <div className="mt-8 mb-5 border-t border-border pt-6">
              <div className="flex items-center gap-2">
                <Users className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">User List</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Current app users and their roles.
              </p>
            </div>

            <div className="space-y-3">
              {users.map((account) => (
                <div
                  key={account.id}
                  className="rounded-lg border border-border bg-muted px-4 py-3"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{account.name}</div>
                      <div className="text-sm text-muted-foreground">
                        @{account.username}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      {user?.role === 'admin' &&
                      account.username !== ADMIN_USERNAME &&
                      account.id !== user?.id ? (
                        <Select
                          value={account.role}
                          disabled={changingRoleUserId !== null}
                          onValueChange={(value) =>
                            handleChangeUserRole(
                              account.id,
                              value as 'admin' | 'operator' | 'viewer',
                            )
                          }
                        >
                          <SelectTrigger className="h-9 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="operator">Operator</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                          {account.role}
                        </div>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={removingUserId !== null || account.id === user?.id}
                        onClick={() => handleRemoveUser(account.id)}
                      >
                        <Trash2 className="size-4 mr-2" />
                        {removingUserId === account.id ? 'Removing...' : 'Remove'}
                      </Button>
                    </div>
                  </div>
                  {account.id === user?.id && (
                    <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
                      {/* Every self-change (primary admin and staff alike) now
                          requires the current password, so always show this. */}
                      <div className="flex-1 space-y-2">
                        <Label htmlFor={`current-password-${account.id}`}>Current Password</Label>
                        <Input
                          id={`current-password-${account.id}`}
                          type="password"
                          value={currentPasswordDraft}
                          onChange={(event) => setCurrentPasswordDraft(event.target.value)}
                          placeholder="Enter your current password"
                          autoComplete="current-password"
                        />
                      </div>
                      <div className="flex-1 space-y-2">
                        <Label htmlFor={`reset-password-${account.id}`}>New Password</Label>
                        <Input
                          id={`reset-password-${account.id}`}
                          type="password"
                          value={passwordDrafts[account.id] ?? ''}
                          onChange={(event) =>
                            setPasswordDrafts((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                          placeholder="Enter a new password"
                          autoComplete="new-password"
                        />
                      </div>
                      <Button
                        type="button"
                        disabled={changingPasswordUserId !== null}
                        onClick={() => handleChangeUserPassword(account.id)}
                      >
                        {changingPasswordUserId === account.id ? 'Saving...' : 'Change Password'}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Bell className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">Notifications</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Admins can add multiple Discord webhooks. Use each webhook's <span className="font-medium">Notifications</span> button to choose which events it receives (print start/stop/pause/resume/cancel, out of filament, temperature reached target, printer online/offline, and new queue submissions). New webhooks receive every event by default. Use each webhook's toggle to turn its notifications on or off without removing it.
              </p>
            </div>

            <form onSubmit={handleCreateWebhook} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="discord-webhook-name">Webhook Name</Label>
                  <Input
                    id="discord-webhook-name"
                    value={webhookName}
                    onChange={(event) => setWebhookName(event.target.value)}
                    placeholder="Main Discord Channel"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="discord-webhook-url">Discord Webhook URL</Label>
                  <textarea
                    id="discord-webhook-url"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value.trim())}
                    placeholder="https://discord.com/api/webhooks/..."
                    className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>
              </div>

              <Button type="submit" disabled={savingWebhook}>
                {savingWebhook ? 'Saving webhook...' : 'Add Discord Webhook'}
              </Button>
            </form>

            <div className="mt-6 space-y-3">
              {discordWebhooks.length > 0 ? (
                discordWebhooks.map((webhook) => (
                  <div
                    key={webhook.id}
                    className="rounded-2xl border border-border bg-card p-4 shadow-sm"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] font-semibold text-white uppercase">
                        {webhook.name.trim().slice(0, 2) || 'PF'}
                      </div>
                      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <div className="font-semibold text-foreground">{webhook.name}</div>
                            <div className="text-xs text-muted-foreground">Webhook Target</div>
                          </div>
                          <div className="mt-2 rounded-md border border-border bg-muted p-3">
                            <div className="flex items-start gap-3">
                              <div className="h-full w-1 shrink-0 rounded-full bg-[#5865f2]" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-sm text-muted-foreground">
                                  {webhook.webhookUrl}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-2">
                          <Popover
                            open={eventsWebhookId === webhook.id}
                            onOpenChange={(open) => handleEventsOpenChange(webhook, open)}
                          >
                            <PopoverTrigger
                              type="button"
                              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                            >
                              <Bell className="size-4 mr-2" />
                              Notifications
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-80">
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                                  <div className="min-w-0">
                                    <div className="font-medium text-foreground">
                                      Notifications
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      {isWebhookEnabled(webhook)
                                        ? 'This webhook is sending notifications.'
                                        : 'This webhook is muted.'}
                                    </p>
                                  </div>
                                  <Switch
                                    checked={isWebhookEnabled(webhook)}
                                    disabled={togglingWebhookId !== null}
                                    onCheckedChange={(checked) => handleToggleEnabled(webhook, checked === true)}
                                    aria-label={`Toggle notifications for ${webhook.name}`}
                                  />
                                </div>
                                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
                                  <div className="min-w-0">
                                    <div className="font-medium text-foreground">
                                      Text-to-speech
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      {isWebhookTts(webhook)
                                        ? 'Discord reads these notifications aloud.'
                                        : 'Notifications are delivered silently.'}
                                    </p>
                                  </div>
                                  <Switch
                                    checked={isWebhookTts(webhook)}
                                    disabled={togglingWebhookId !== null}
                                    onCheckedChange={(checked) => handleToggleTts(webhook, checked === true)}
                                    aria-label={`Toggle text-to-speech for ${webhook.name}`}
                                  />
                                </div>
                                <div>
                                  <div className="font-medium text-foreground">
                                    Notifications sent
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    Choose which events this webhook receives.
                                  </p>
                                </div>
                                <div className="space-y-2">
                                  {NOTIFICATION_EVENTS.map((notificationEvent) => (
                                    <label
                                      key={notificationEvent.key}
                                      htmlFor={`${webhook.id}-${notificationEvent.key}`}
                                      className="flex items-center gap-2 text-sm text-muted-foreground"
                                    >
                                      <Checkbox
                                        id={`${webhook.id}-${notificationEvent.key}`}
                                        checked={eventsDraft.includes(notificationEvent.key)}
                                        onCheckedChange={(checked) =>
                                          toggleEventDraft(notificationEvent.key, checked === true)
                                        }
                                      />
                                      {notificationEvent.label}
                                    </label>
                                  ))}
                                </div>
                                <div className="flex justify-end gap-2 pt-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEventsWebhookId(null)}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={savingEvents}
                                    onClick={() => handleSaveEvents(webhook)}
                                  >
                                    {savingEvents ? 'Saving...' : 'Save'}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={removingWebhookId !== null}
                            onClick={() => handleRemoveWebhook(webhook.id)}
                          >
                            <Trash2 className="size-4 mr-2" />
                            {removingWebhookId === webhook.id ? 'Removing...' : 'Remove'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-muted px-4 py-6 text-sm text-muted-foreground">
                  No Discord webhooks configured yet.
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="branding">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <ImageIcon className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">Branding</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Upload a custom logo to replace the default mark on the login screen and the sidebar. PNG, JPEG, WebP, GIF, or SVG up to 512&nbsp;KB. A single-color SVG is recolored to follow the light/dark theme automatically.
              </p>
            </div>

            <div className="border-b border-border pb-6 mb-6">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-foreground">Site Name</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Set the name shown in the browser tab and dashboard heading. Saving reloads
                  the app so the change applies everywhere. Leave blank / reset to use the
                  built-in default.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="site-name">Website name</Label>
                  <Input
                    id="site-name"
                    type="text"
                    maxLength={120}
                    placeholder={DEFAULT_SITE_NAME}
                    value={siteName}
                    onChange={(event) => setSiteName(event.target.value)}
                    disabled={user?.role !== 'admin'}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={handleSaveIdentity} disabled={savingIdentity}>
                    {savingIdentity ? 'Saving...' : 'Save Name'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleResetIdentity}
                    disabled={savingIdentity || !siteName}
                  >
                    Reset to Default
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Preview (light / dark)</Label>
                <div className="grid grid-cols-2 gap-3">
                  {(['light', 'dark'] as const).map((tone) => {
                    // The tiles preview both themes at once, so they can't rely on
                    // the `dark:` variant (it follows the real app theme). Force the
                    // tone explicitly: dark in the light tile, white in the dark tile.
                    const toneFilter = tone === 'dark' ? 'brightness-0 invert' : 'brightness-0';
                    return (
                      <div
                        key={tone}
                        className={`flex h-28 items-center justify-center overflow-hidden rounded-lg border ${
                          tone === 'dark'
                            ? 'border-gray-700 bg-gray-900'
                            : 'border-gray-200 bg-white'
                        }`}
                      >
                        {logoSvg ? (
                          <span
                            role="img"
                            aria-label="Logo preview"
                            style={{ height: Math.round(64 * logoScale) }}
                            className={`inline-flex items-center [&>svg]:h-full [&>svg]:w-auto [&>svg]:max-w-full ${toneFilter}`}
                            dangerouslySetInnerHTML={{ __html: logoSvg }}
                          />
                        ) : (
                          <img
                            src={logoDataUrl || defaultLogo}
                            alt="Logo preview"
                            style={{ height: Math.round(64 * logoScale) }}
                            className={`w-auto max-w-full ${toneFilter}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  The logo is shown dark on light backgrounds and white on dark backgrounds.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="logo-file">Choose image</Label>
                <Input
                  id="logo-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={handleLogoFileChange}
                  disabled={user?.role !== 'admin'}
                />
                <p className="text-xs text-muted-foreground">
                  The image is stored in the database, so it survives container rebuilds.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="logo-scale">Logo size</Label>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {Math.round(logoScale * 100)}%
                  </span>
                </div>
                <Slider
                  id="logo-scale"
                  min={50}
                  max={200}
                  step={10}
                  value={[Math.round(logoScale * 100)]}
                  onValueChange={(values) => setLogoScale((values[0] ?? 100) / 100)}
                  disabled={user?.role !== 'admin'}
                />
                <p className="text-xs text-muted-foreground">
                  Scales the logo in the sidebar and on the login screen (50–200% of the default size).
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={handleSaveBranding} disabled={savingBranding}>
                  {savingBranding ? 'Saving...' : 'Save Logo'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResetBranding}
                  disabled={savingBranding || (!logoDataUrl && logoScale === 1)}
                >
                  Reset to Default
                </Button>
              </div>

              <div className="border-t border-border pt-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-foreground">Website Background</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Upload a custom image to use as the dashboard background. Choose{' '}
                    <span className="font-medium">Use Default</span> to fall back to the built-in
                    light/dark theme. PNG, JPEG, WebP, GIF, or SVG up to 3&nbsp;MB.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Preview</Label>
                    <div
                      className="flex h-40 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted bg-cover bg-center"
                      style={
                        backgroundDataUrl
                          ? { backgroundImage: `url(${backgroundDataUrl})` }
                          : undefined
                      }
                    >
                      {!backgroundDataUrl && (
                        <span className="text-sm text-muted-foreground">
                          Default theme background
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="background-file">Choose image</Label>
                    <Input
                      id="background-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={handleBackgroundFileChange}
                      disabled={user?.role !== 'admin'}
                    />
                    <p className="text-xs text-muted-foreground">
                      The image is stored in the database, so it survives container rebuilds.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleSaveBackground} disabled={savingBackground}>
                      {savingBackground ? 'Saving...' : 'Save Background'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleResetBackground}
                      disabled={savingBackground || !backgroundDataUrl}
                    >
                      Use Default
                    </Button>
                  </div>
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-foreground">Browser / App Icon</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Upload a custom icon shown in the browser tab, bookmarks, and when the app is installed as a PWA.
                    PNG, SVG, or ICO up to 256&nbsp;KB. A square image (e.g. 64×64 or 32×32) works best.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Preview</Label>
                    <div className="flex items-center gap-4">
                      <div className="flex size-16 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                        {faviconDataUrl ? (
                          <img src={faviconDataUrl} alt="Favicon preview" className="size-10 object-contain" />
                        ) : (
                          <img src="/icon.svg" alt="Default favicon" className="size-10 object-contain opacity-50" />
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {faviconDataUrl ? 'Custom icon' : 'Default icon'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="favicon-file">Choose icon</Label>
                    <Input
                      id="favicon-file"
                      type="file"
                      accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/webp,image/gif"
                      onChange={handleFaviconFileChange}
                      disabled={user?.role !== 'admin'}
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored in the database — survives container rebuilds.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleSaveFavicon} disabled={savingFavicon}>
                      {savingFavicon ? 'Saving...' : 'Save Icon'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleResetFavicon}
                      disabled={savingFavicon || !faviconDataUrl}
                    >
                      Use Default
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="slicer-upload">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <KeyRound className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">API Keys</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Generate named API keys and scope each to what it may do. For slicer upload, in your slicer
                (Orca / PrusaSlicer / Cura) add a <span className="font-medium">Physical Printer</span> with host type{' '}
                <span className="font-medium">OctoPrint</span>, host{' '}
                <code className="rounded bg-muted px-1">
                  https://{typeof window !== 'undefined' ? window.location.hostname : 'host'}/printers/&lt;printerId&gt;
                </code>
                , and paste a key below as the API key. One key works for every printer.
              </p>
            </div>

            <form onSubmit={handleCreateSlicerKey} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="slicer-key-name">Key Name</Label>
                  <Input
                    id="slicer-key-name"
                    value={slicerKeyName}
                    onChange={(event) => setSlicerKeyName(event.target.value)}
                    placeholder="Orca on lab laptop"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Permissions</Label>
                <div className="space-y-2">
                  {SLICER_KEY_PERMISSION_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      htmlFor={`slicer-key-perm-${option.value}`}
                      className="flex items-start gap-2 text-sm text-muted-foreground"
                    >
                      <Checkbox
                        id={`slicer-key-perm-${option.value}`}
                        className="mt-0.5"
                        checked={slicerKeyPermissions.includes(option.value)}
                        onCheckedChange={(checked) => toggleSlicerKeyPermission(option.value, checked === true)}
                      />
                      <span>
                        <span className="font-medium">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">{option.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {createdSlicerKey && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/40">
                  <div className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    Copy this key now — it will not be shown again.
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-3 py-2 font-mono text-sm">
                      {createdSlicerKey.key}
                    </code>
                    <Button type="button" variant="outline" size="sm" onClick={handleCopyCreatedKey}>
                      {copiedKey ? <Check className="size-4 mr-2" /> : <Copy className="size-4 mr-2" />}
                      {copiedKey ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              )}

              <Button type="submit" disabled={savingSlicerKey || slicerKeyPermissions.length === 0}>
                {savingSlicerKey ? 'Generating...' : 'Generate API Key'}
              </Button>
            </form>

            <div className="mt-6 space-y-3">
              {slicerKeys.length > 0 ? (
                slicerKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">{key.name}</div>
                      <div className="mt-1 font-mono text-sm text-muted-foreground">
                        {key.keyPrefix}…
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(key.permissions ?? []).map((permission) => (
                          <span
                            key={permission}
                            className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                          >
                            {SLICER_KEY_PERMISSION_OPTIONS.find((o) => o.value === permission)?.label ?? permission}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {key.createdAt ? `Created ${new Date(key.createdAt).toLocaleDateString()}` : 'Created —'}
                        {' · '}
                        {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : 'Never used'}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={removingSlicerKeyId !== null}
                      onClick={() => handleRemoveSlicerKey(key.id)}
                    >
                      <Trash2 className="size-4 mr-2" />
                      {removingSlicerKeyId === key.id ? 'Revoking...' : 'Revoke'}
                    </Button>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-muted px-4 py-6 text-sm text-muted-foreground">
                  No slicer API keys yet.
                </div>
              )}
            </div>

            {printers.filter((printer) => printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile)).length > 0 && (
              <div className="mt-6 rounded-md border border-border bg-muted p-4">
                <div className="text-sm font-medium text-foreground">Printer IDs for slicer host URLs</div>
                <div className="mt-2 space-y-1">
                  {printers
                    .filter((printer) => printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile))
                    .map((printer) => (
                      <div key={printer.id} className="flex items-baseline gap-2 text-sm">
                        <span className="text-muted-foreground">{printer.name}</span>
                        <code className="rounded bg-muted px-1 font-mono text-xs">
                          /printers/{printer.id}
                        </code>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </Card>

          <Card className="mt-6 p-6">
            <form onSubmit={handleSavePrinterCallbackUrl} className="space-y-2">
              <Label htmlFor="printer-callback-url">Printer callback URL (site-wide default)</Label>
              <p className="text-sm text-muted-foreground">
                Bambu Lab H2-series printers (H2S / H2D / H2C) refuse FTP writes
                to their own storage, so a print sent through the slicer is
                staged here instead and the printer fetches it back over HTTP.
                For that to work, this must be a LAN address the{' '}
                <span className="font-medium">printer itself</span> can reach —
                e.g. <code>http://192.168.1.50:8080</code> — not{' '}
                <code>localhost</code>, which only resolves on the machine
                running the farm server. Leave blank to fall back to a
                best-effort guess from the incoming request, which is wrong
                whenever the slicer connects via <code>localhost</code>. If
                your H2 printers sit on different subnets, this single value
                can't reach all of them — set a per-printer override instead
                on each printer's detail page (Edit → "Printer callback URL
                (override)"), which takes precedence over this default.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="printer-callback-url"
                  value={printerCallbackUrl}
                  onChange={(e) => setPrinterCallbackUrl(e.target.value)}
                  placeholder="http://192.168.1.50:8080"
                  disabled={user?.role !== 'admin'}
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1"
                />
                <Button
                  type="submit"
                  disabled={user?.role !== 'admin' || savingPrinterCallbackUrl}
                >
                  {savingPrinterCallbackUrl ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </form>
          </Card>
        </TabsContent>

        <TabsContent value="managers">
          <Card className="p-6">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <MonitorCheck className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold text-foreground">Managers</h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                External apps can request a <code className="rounded bg-muted px-1">printfarm_manage</code> API key.
                Approve pending requests to grant access. Revoking removes the key immediately.
              </p>
            </div>

            <div className="space-y-3">
                {managerRequests.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border bg-muted px-4 py-6 text-sm text-muted-foreground">
                    No manager connection requests yet.
                  </div>
                ) : (
                  managerRequests.map((req) => {
                    const STATUS_BADGE: Record<string, string> = {
                      pending: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
                      approved: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300',
                      denied: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
                      revoked: 'bg-muted text-muted-foreground',
                    };
                    return (
                      <div
                        key={req.id}
                        className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-foreground">
                              {req.name}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[req.status] ?? STATUS_BADGE.denied}`}
                            >
                              {req.status}
                            </span>
                          </div>
                          {req.description && (
                            <p className="mt-0.5 text-sm text-muted-foreground">
                              {req.description}
                            </p>
                          )}
                          <div className="mt-1 text-xs text-muted-foreground">
                            Requested {new Date(req.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {req.status === 'pending' && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                disabled={actioningManagerId !== null}
                                onClick={() => handleApproveManager(req.id)}
                              >
                                <Check className="size-3.5 mr-1" />
                                {actioningManagerId === req.id ? '…' : 'Approve'}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={actioningManagerId !== null}
                                onClick={() => handleDenyManager(req.id)}
                              >
                                <X className="size-3.5 mr-1" />
                                {actioningManagerId === req.id ? '…' : 'Deny'}
                              </Button>
                            </>
                          )}
                          {req.status === 'approved' && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={actioningManagerId !== null}
                              onClick={() => handleRevokeManager(req.id)}
                            >
                              <Trash2 className="size-3.5 mr-1" />
                              {actioningManagerId === req.id ? 'Revoking…' : 'Revoke'}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="system">
          <div className="space-y-6">
            {user?.role === 'admin' && <SoftwareUpdateSettings />}
            {user?.role === 'admin' && <BackupSettings />}
          </div>
        </TabsContent>

        <TabsContent value="home-assistant">
          <HomeAssistantSettings disabled={user?.role !== 'admin'} />
        </TabsContent>

        <TabsContent value="sign-in">
          <div className="space-y-6">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="public-viewer-toggle" className="text-base">
                    Public dashboard viewing
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    When on, anyone can open the dashboard read-only without
                    signing in (connection secrets stay hidden). When off,
                    visitors are sent to the login screen and must sign in to see
                    anything.
                  </p>
                </div>
                <Switch
                  id="public-viewer-toggle"
                  checked={publicViewerEnabled}
                  onCheckedChange={handleTogglePublicViewer}
                  disabled={user?.role !== 'admin' || savingPublicViewer}
                />
              </div>
            </Card>

            <Card className="p-6">
              <form onSubmit={handleSaveSsoPublicUrl} className="space-y-2">
                <Label htmlFor="sso-public-url">SSO public URL</Label>
                <p className="text-sm text-muted-foreground">
                  The public HTTPS address SSO providers should redirect back to
                  after sign-in (e.g. <code>https://printfarm.example.com</code>).
                  Overrides the server's <code>APP_BASE_URL</code> env var and
                  header auto-detection — set this when SSO logins land on the
                  wrong host. Leave blank to fall back to{' '}
                  {ssoPublicUrlEnvFallback ? (
                    <>
                      the configured <code>APP_BASE_URL</code> (
                      <code>{ssoPublicUrlEnvFallback}</code>)
                    </>
                  ) : (
                    'auto-detection from request headers'
                  )}
                  .
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="sso-public-url"
                    value={ssoPublicUrl}
                    onChange={(e) => setSsoPublicUrl(e.target.value)}
                    placeholder="https://printfarm.example.com"
                    disabled={user?.role !== 'admin'}
                    spellCheck={false}
                    autoComplete="off"
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    disabled={user?.role !== 'admin' || savingSsoPublicUrl}
                  >
                    {savingSsoPublicUrl ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </form>
            </Card>

            <Card className="p-6">
              <div className="space-y-2">
                <Label htmlFor="sso-provider">Single sign-on provider</Label>
                <p className="text-sm text-muted-foreground">
                  Choose which provider to configure. Each provider has its own
                  enable toggle and they can be turned on independently — the login
                  screen shows a button for every enabled provider.
                </p>
                <Select
                  value={ssoProvider}
                  onValueChange={(value) => setSsoProvider(value as 'google' | 'microsoft' | 'adfs' | 'saml')}
                  disabled={user?.role !== 'admin'}
                >
                  <SelectTrigger id="sso-provider" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="google">Google</SelectItem>
                    <SelectItem value="microsoft">Microsoft</SelectItem>
                    <SelectItem value="adfs">ADFS</SelectItem>
                    <SelectItem value="saml">SAML 2.0</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Card>

            {ssoProvider === 'google' && (
              <OAuthProviderSettings
                provider="google"
                label="Google"
                showDisplayName
                disabled={user?.role !== 'admin'}
                clientIdPlaceholder="xxxxxxxx.apps.googleusercontent.com"
                setupHint={<>Create an OAuth client in the Google Cloud console.</>}
              />
            )}
            {ssoProvider === 'microsoft' && (
              <OAuthProviderSettings
                provider="microsoft"
                label="Microsoft"
                showTenant
                showDisplayName
                disabled={user?.role !== 'admin'}
                clientIdPlaceholder="Application (client) ID"
                setupHint={
                  <>Register an app in the Azure portal (Entra ID → App registrations)
                  and add a client secret — or point it at an on-prem AD FS server
                  with the authority URL below.</>
                }
              />
            )}
            {ssoProvider === 'adfs' && (
              <OAuthProviderSettings
                provider="adfs"
                label="ADFS"
                showAuthority
                showDisplayName
                disabled={user?.role !== 'admin'}
                setupHint={
                  <>
                    Satit-M Chula AD FS — enter the Client ID, Secret, authority
                    URL, and the redirect URI exactly as registered with the IdP.
                  </>
                }
              />
            )}
            {ssoProvider === 'saml' && (
              <SamlSsoSettings disabled={user?.role !== 'admin'} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
