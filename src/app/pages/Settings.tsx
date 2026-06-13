import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bell, Check, Copy, KeyRound, Link2, Plus, Settings as SettingsIcon, Shield, Trash2, Users } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../components/ui/utils';
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
import { CreatedSlicerKey, SlicerApiKey, createSlicerKey, fetchSlicerKeys, removeSlicerKey } from '../lib/slicerKeysApi';
import { fetchPrinters, savePrinter } from '../lib/printersApi';
import { generateId, slugifyPrinterId } from '../lib/id';
import { isBambuProfile, normalizePrinter, PRINTER_PROFILES } from '../lib/printerProfiles';
import { fetchIntegrationSettings, saveIntegrationSettings } from '../lib/settingsApi';

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function Settings() {
  const { user, users, createUser, removeUser, changeUserPassword, changeAdminPassword } = useAuth();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [printerProfile, setPrinterProfile] = useState<PrinterProfile>('generic');
  const [printerIpAddress, setPrinterIpAddress] = useState('');
  const [printerApiKeyHeader, setPrinterApiKeyHeader] = useState('');
  const [printerSerial, setPrinterSerial] = useState('');
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
  const [discordWebhooks, setDiscordWebhooks] = useState<DiscordWebhook[]>([]);
  const [webhookName, setWebhookName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [removingWebhookId, setRemovingWebhookId] = useState<string | null>(null);
  const [eventsWebhookId, setEventsWebhookId] = useState<string | null>(null);
  const [eventsDraft, setEventsDraft] = useState<string[]>([]);
  const [savingEvents, setSavingEvents] = useState(false);
  const [togglingWebhookId, setTogglingWebhookId] = useState<string | null>(null);
  const [googleSheetQueueUrl, setGoogleSheetQueueUrl] = useState('');
  const [googleFormUrl, setGoogleFormUrl] = useState('');
  const [savingIntegrations, setSavingIntegrations] = useState(false);
  const [slicerKeys, setSlicerKeys] = useState<SlicerApiKey[]>([]);
  const [slicerKeyName, setSlicerKeyName] = useState('');
  const [savingSlicerKey, setSavingSlicerKey] = useState(false);
  const [removingSlicerKeyId, setRemovingSlicerKeyId] = useState<string | null>(null);
  const [createdSlicerKey, setCreatedSlicerKey] = useState<CreatedSlicerKey | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

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

    fetchIntegrationSettings()
      .then((settings) => {
        setGoogleSheetQueueUrl(settings.googleSheetQueueUrl);
        setGoogleFormUrl(settings.googleFormUrl);
      })
      .catch(() => {
        toast.error('Unable to load integration URLs.');
      });

    fetchSlicerKeys()
      .then(setSlicerKeys)
      .catch(() => {
        toast.error('Unable to load slicer API keys.');
      });
  }, []);

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
    };

    try {
      await savePrinter(nextPrinter);
      await refreshPrinters();
      setPrinterName('');
      setPrinterProfile('generic');
      setPrinterIpAddress('');
      setPrinterApiKeyHeader('');
      setPrinterSerial('');
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
        : await changeUserPassword(userId, passwordDrafts[userId] ?? '');
      if (!result.success) {
        toast.error(result.error ?? 'Unable to change password.');
        return;
      }

      setPasswordDrafts((prev) => ({
        ...prev,
        [userId]: '',
      }));
      if (isAdminAccount) {
        setCurrentPasswordDraft('');
      }
      toast.success('Password updated');
    } finally {
      setChangingPasswordUserId(null);
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

    setSavingSlicerKey(true);

    try {
      const created = await createSlicerKey(normalizedName);
      await refreshSlicerKeys();
      setSlicerKeyName('');
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

  const handleSaveIntegrations = async (event: React.FormEvent) => {
    event.preventDefault();

    if (user?.role !== 'admin') {
      toast.error('Only admins can change integration URLs.');
      return;
    }

    const normalizedSheetUrl = googleSheetQueueUrl.trim();
    const normalizedFormUrl = googleFormUrl.trim();

    if (normalizedSheetUrl && !/\/spreadsheets\/d\//.test(normalizedSheetUrl)) {
      toast.error('Enter a valid Google Sheets URL (must contain /spreadsheets/d/).');
      return;
    }

    if (normalizedFormUrl && !/\/forms\//.test(normalizedFormUrl)) {
      toast.error('Enter a valid Google Forms URL (must contain /forms/).');
      return;
    }

    setSavingIntegrations(true);

    try {
      const saved = await saveIntegrationSettings({
        googleSheetQueueUrl: normalizedSheetUrl,
        googleFormUrl: normalizedFormUrl,
      });
      setGoogleSheetQueueUrl(saved.googleSheetQueueUrl);
      setGoogleFormUrl(saved.googleFormUrl);
      toast.success('Integration URLs saved');
    } catch (error) {
      toast.error('Unable to save integration URLs', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingIntegrations(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2 dark:text-white">Settings</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Admin-only configuration for printers and user access.
        </p>
      </div>

      <Tabs defaultValue="manage-printers" className="space-y-6">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="manage-printers" className="min-w-max">
            <SettingsIcon className="size-4" />
            Manage Printers
          </TabsTrigger>
          <TabsTrigger value="add-user" className="min-w-max">
            <Plus className="size-4" />
            Add User
          </TabsTrigger>
          <TabsTrigger value="user-list" className="min-w-max">
            <Users className="size-4" />
            User List
          </TabsTrigger>
          <TabsTrigger value="notifications" className="min-w-max">
            <Bell className="size-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="integrations" className="min-w-max">
            <Link2 className="size-4" />
            Integrations
          </TabsTrigger>
          <TabsTrigger value="slicer-upload" className="min-w-max">
            <KeyRound className="size-4" />
            Slicer Upload
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manage-printers">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <SettingsIcon className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Manage Printers</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
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
                      <SelectValue placeholder="Select a profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="generic">Generic</SelectItem>
                      <SelectItem value="snapmaker_u1">Snapmaker U1</SelectItem>
                      <SelectItem value="bambulab_a1_mini">Bambu Lab A1 Mini</SelectItem>
                      <SelectItem value="bambulab_h2s">Bambu Lab H2S</SelectItem>
                      <SelectItem value="bambulab_h2d">Bambu Lab H2D</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="printer-name">Printer Name</Label>
                  <Input
                    id="printer-name"
                    value={printerName}
                    onChange={(event) => setPrinterName(event.target.value)}
                    placeholder="Bambu Lab A1 Mini"
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
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Found on the printer (Settings → Device) or the Bambu Handy app. Required for live status over MQTT.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                <div>Model: {PRINTER_PROFILES[printerProfile].defaultModel}</div>
                <div>Live status: {PRINTER_PROFILES[printerProfile].pollingDescription}</div>
              </div>

              <Button type="submit">Add Printer</Button>
            </form>
          </Card>
        </TabsContent>

        <TabsContent value="add-user">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Shield className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Add User</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
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
                    onValueChange={(value) => setRole(value as 'admin' | 'operator')}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="operator">Operator</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button type="submit" disabled={isCreatingUser}>
                {isCreatingUser ? 'Adding user...' : 'Add User'}
              </Button>
            </form>
          </Card>
        </TabsContent>

        <TabsContent value="user-list">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Users className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">User List</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Current app users and their roles.
              </p>
            </div>


            <div className="space-y-3">
              {users.map((account) => (
                <div
                  key={account.id}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-950"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-medium dark:text-white">{account.name}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        @{account.username}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                        {account.role}
                      </div>
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
                      {account.username === ADMIN_USERNAME && (
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
                      )}
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
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Bell className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Notifications</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
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
                    className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] font-semibold text-white uppercase">
                        {webhook.name.trim().slice(0, 2) || 'PF'}
                      </div>
                      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <div className="font-semibold text-gray-900 dark:text-white">{webhook.name}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">Webhook Target</div>
                          </div>
                          <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
                            <div className="flex items-start gap-3">
                              <div className="h-full w-1 shrink-0 rounded-full bg-[#5865f2]" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-sm text-gray-600 dark:text-gray-300">
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
                                <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
                                  <div className="min-w-0">
                                    <div className="font-medium text-gray-900 dark:text-white">
                                      Notifications
                                    </div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
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
                                <div>
                                  <div className="font-medium text-gray-900 dark:text-white">
                                    Notifications sent
                                  </div>
                                  <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Choose which events this webhook receives.
                                  </p>
                                </div>
                                <div className="space-y-2">
                                  {NOTIFICATION_EVENTS.map((notificationEvent) => (
                                    <label
                                      key={notificationEvent.key}
                                      htmlFor={`${webhook.id}-${notificationEvent.key}`}
                                      className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
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
                <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  No Discord webhooks configured yet.
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="integrations">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Link2 className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Integrations</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Admins can set the Google Sheet that feeds the print queue and the Google Form users submit print requests through. These override the build-time defaults and take effect on the next queue sync.
              </p>
            </div>

            <form onSubmit={handleSaveIntegrations} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="google-sheet-url">Google Sheet (queue feed)</Label>
                <Input
                  id="google-sheet-url"
                  value={googleSheetQueueUrl}
                  onChange={(event) => setGoogleSheetQueueUrl(event.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  The server fetches this sheet as CSV to build the queue. Must be link-shareable.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="google-form-url">Google Form (print request)</Label>
                <Input
                  id="google-form-url"
                  value={googleFormUrl}
                  onChange={(event) => setGoogleFormUrl(event.target.value)}
                  placeholder="https://docs.google.com/forms/d/e/YOUR_FORM_ID/viewform"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Linked from the login screen and the sidebar so users can submit print requests.
                </p>
              </div>

              <Button type="submit" disabled={savingIntegrations}>
                {savingIntegrations ? 'Saving...' : 'Save Integration URLs'}
              </Button>
            </form>
          </Card>
        </TabsContent>

        <TabsContent value="slicer-upload">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <KeyRound className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Slicer Upload</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Generate named API keys for the slicer-upload proxy. In your slicer (Orca / PrusaSlicer / Cura),
                add a <span className="font-medium">Physical Printer</span> with host type{' '}
                <span className="font-medium">OctoPrint</span>, host{' '}
                <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
                  http://{typeof window !== 'undefined' ? window.location.hostname : 'host'}:8091/printers/&lt;printerId&gt;
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

              {createdSlicerKey && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/40">
                  <div className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    Copy this key now — it will not be shown again.
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-white px-3 py-2 font-mono text-sm dark:bg-gray-950">
                      {createdSlicerKey.key}
                    </code>
                    <Button type="button" variant="outline" size="sm" onClick={handleCopyCreatedKey}>
                      {copiedKey ? <Check className="size-4 mr-2" /> : <Copy className="size-4 mr-2" />}
                      {copiedKey ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              )}

              <Button type="submit" disabled={savingSlicerKey}>
                {savingSlicerKey ? 'Generating...' : 'Generate API Key'}
              </Button>
            </form>

            <div className="mt-6 space-y-3">
              {slicerKeys.length > 0 ? (
                slicerKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900 dark:text-white">{key.name}</div>
                      <div className="mt-1 font-mono text-sm text-gray-500 dark:text-gray-400">
                        {key.keyPrefix}…
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
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
                <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  No slicer API keys yet.
                </div>
              )}
            </div>

            {printers.filter((printer) => printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile)).length > 0 && (
              <div className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900">
                <div className="text-sm font-medium text-gray-900 dark:text-white">Printer IDs for slicer host URLs</div>
                <div className="mt-2 space-y-1">
                  {printers
                    .filter((printer) => printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile))
                    .map((printer) => (
                      <div key={printer.id} className="flex items-baseline gap-2 text-sm">
                        <span className="text-gray-600 dark:text-gray-300">{printer.name}</span>
                        <code className="rounded bg-white px-1 font-mono text-xs dark:bg-gray-950">
                          /printers/{printer.id}
                        </code>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
