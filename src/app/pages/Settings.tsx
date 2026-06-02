import { useEffect, useState } from 'react';
import { Bell, Link2, Plus, Settings as SettingsIcon, Shield, Trash2, Users } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Alert } from '../components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useAuth } from '../contexts/AuthContext';
import { Printer, PrinterProfile } from '../types';
import { DiscordWebhook, fetchDiscordWebhooks, removeDiscordWebhook, saveDiscordWebhook } from '../lib/notificationsApi';
import { fetchPrinters, savePrinter } from '../lib/printersApi';
import { generateId, slugifyPrinterId } from '../lib/id';
import { normalizePrinter, PRINTER_PROFILES } from '../lib/printerProfiles';
import { fetchIntegrationSettings, saveIntegrationSettings } from '../lib/settingsApi';

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function Settings() {
  const { user, users, createUser, removeUser, changeUserPassword } = useAuth();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [printerProfile, setPrinterProfile] = useState<PrinterProfile>('generic');
  const [printerIpAddress, setPrinterIpAddress] = useState('');
  const [printerApiKeyHeader, setPrinterApiKeyHeader] = useState('');
  const [printerSerial, setPrinterSerial] = useState('');
  const [printerFormError, setPrinterFormError] = useState('');
  const [printerFormSuccess, setPrinterFormSuccess] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [userFormError, setUserFormError] = useState('');
  const [userFormSuccess, setUserFormSuccess] = useState('');
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [userListError, setUserListError] = useState('');
  const [userListSuccess, setUserListSuccess] = useState('');
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [changingPasswordUserId, setChangingPasswordUserId] = useState<string | null>(null);
  const [discordWebhooks, setDiscordWebhooks] = useState<DiscordWebhook[]>([]);
  const [webhookName, setWebhookName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [notificationError, setNotificationError] = useState('');
  const [notificationSuccess, setNotificationSuccess] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [removingWebhookId, setRemovingWebhookId] = useState<string | null>(null);
  const [googleSheetQueueUrl, setGoogleSheetQueueUrl] = useState('');
  const [googleFormUrl, setGoogleFormUrl] = useState('');
  const [integrationError, setIntegrationError] = useState('');
  const [integrationSuccess, setIntegrationSuccess] = useState('');
  const [savingIntegrations, setSavingIntegrations] = useState(false);

  useEffect(() => {
    fetchPrinters()
      .then((storedPrinters) => setPrinters(storedPrinters.map(normalizePrinter)))
      .catch(() => {
        setPrinterFormError('Unable to load printers from Postgres. Check DATABASE_URL and server access.');
      });

    fetchDiscordWebhooks()
      .then(setDiscordWebhooks)
      .catch(() => {
        setNotificationError('Unable to load Discord webhooks.');
      });

    fetchIntegrationSettings()
      .then((settings) => {
        setGoogleSheetQueueUrl(settings.googleSheetQueueUrl);
        setGoogleFormUrl(settings.googleFormUrl);
      })
      .catch(() => {
        setIntegrationError('Unable to load integration URLs.');
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
    setPrinterFormError('');
    setPrinterFormSuccess('');

    if (user?.role !== 'admin') {
      setPrinterFormError('Only admins can add printers.');
      return;
    }

    const normalizedName = printerName.trim();
    const normalizedIpAddress = printerIpAddress.trim();
    const normalizedApiKeyHeader = printerApiKeyHeader.trim();
    const normalizedSerial = printerSerial.trim();
    const profileConfig = PRINTER_PROFILES[printerProfile];

    if (!normalizedName || !normalizedIpAddress || !normalizedApiKeyHeader) {
      setPrinterFormError(
        `Name, IP address, and ${profileConfig.credentialLabel} are required.`,
      );
      return;
    }

    if (printerProfile === 'bambulab_a1_mini' && !normalizedSerial) {
      setPrinterFormError('Bambu Lab printers require the device serial number.');
      return;
    }

    if (!IPV4_PATTERN.test(normalizedIpAddress)) {
      setPrinterFormError('Enter a valid IPv4 address.');
      return;
    }

    if (printers.some((printer) => printer.ipAddress === normalizedIpAddress)) {
      setPrinterFormError('That IP address is already assigned to another printer.');
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
      setPrinterFormSuccess('Printer added successfully. Status will switch from offline once a live status check succeeds.');
    } catch (error) {
      setPrinterFormError(error instanceof Error ? error.message : 'Unable to save printer.');
    }
  };

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setUserFormError('');
    setUserFormSuccess('');
    setIsCreatingUser(true);

    try {
      const result = await createUser({ name, username, password, role });
      if (!result.success) {
        setUserFormError(result.error ?? 'Unable to create user.');
        return;
      }

      setName('');
      setUsername('');
      setPassword('');
      setRole('operator');
      setUserFormSuccess('User added successfully.');
    } finally {
      setIsCreatingUser(false);
    }
  };

  const handleRemoveUser = async (userId: string) => {
    setUserListError('');
    setUserListSuccess('');
    setRemovingUserId(userId);

    try {
      const result = await removeUser(userId);
      if (!result.success) {
        setUserListError(result.error ?? 'Unable to remove user.');
        return;
      }

      setUserListSuccess('User removed successfully.');
    } finally {
      setRemovingUserId(null);
    }
  };

  const handleChangeUserPassword = async (userId: string) => {
    setUserListError('');
    setUserListSuccess('');
    setChangingPasswordUserId(userId);

    try {
      const result = await changeUserPassword(userId, passwordDrafts[userId] ?? '');
      if (!result.success) {
        setUserListError(result.error ?? 'Unable to change password.');
        return;
      }

      setPasswordDrafts((prev) => ({
        ...prev,
        [userId]: '',
      }));
      setUserListSuccess('Password updated successfully.');
    } finally {
      setChangingPasswordUserId(null);
    }
  };

  const handleCreateWebhook = async (event: React.FormEvent) => {
    event.preventDefault();
    setNotificationError('');
    setNotificationSuccess('');

    if (user?.role !== 'admin') {
      setNotificationError('Only admins can manage Discord notifications.');
      return;
    }

    const normalizedName = webhookName.trim();
    const normalizedWebhookUrl = webhookUrl.trim();

    if (!normalizedName || !normalizedWebhookUrl) {
      setNotificationError('Webhook name and Discord webhook URL are required.');
      return;
    }

    if (!normalizedWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      setNotificationError('Enter a valid Discord webhook URL.');
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
      setNotificationSuccess('Discord webhook added successfully.');
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : 'Unable to save Discord webhook.');
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleRemoveWebhook = async (webhookId: string) => {
    setNotificationError('');
    setNotificationSuccess('');
    setRemovingWebhookId(webhookId);

    try {
      await removeDiscordWebhook(webhookId);
      await refreshDiscordWebhooks();
      setNotificationSuccess('Discord webhook removed successfully.');
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : 'Unable to remove Discord webhook.');
    } finally {
      setRemovingWebhookId(null);
    }
  };

  const handleSaveIntegrations = async (event: React.FormEvent) => {
    event.preventDefault();
    setIntegrationError('');
    setIntegrationSuccess('');

    if (user?.role !== 'admin') {
      setIntegrationError('Only admins can change integration URLs.');
      return;
    }

    const normalizedSheetUrl = googleSheetQueueUrl.trim();
    const normalizedFormUrl = googleFormUrl.trim();

    if (normalizedSheetUrl && !/\/spreadsheets\/d\//.test(normalizedSheetUrl)) {
      setIntegrationError('Enter a valid Google Sheets URL (must contain /spreadsheets/d/).');
      return;
    }

    if (normalizedFormUrl && !/\/forms\//.test(normalizedFormUrl)) {
      setIntegrationError('Enter a valid Google Forms URL (must contain /forms/).');
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
      setIntegrationSuccess('Integration URLs saved successfully.');
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : 'Unable to save integration URLs.');
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

              {printerProfile === 'bambulab_a1_mini' && (
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

              {printerFormError && (
                <Alert variant="destructive" className="py-2">
                  {printerFormError}
                </Alert>
              )}

              {printerFormSuccess && <Alert className="py-2">{printerFormSuccess}</Alert>}

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

              {userFormError && (
                <Alert variant="destructive" className="py-2">
                  {userFormError}
                </Alert>
              )}

              {userFormSuccess && <Alert className="py-2">{userFormSuccess}</Alert>}

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

            {userListError && (
              <Alert variant="destructive" className="mb-4 py-2">
                {userListError}
              </Alert>
            )}

            {userListSuccess && <Alert className="mb-4 py-2">{userListSuccess}</Alert>}

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
                  <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
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
                        placeholder="At least 8 characters"
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
                Admins can add multiple Discord webhooks. The background poller sends printer status and job transition notifications to all saved webhooks.
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

              {notificationError && (
                <Alert variant="destructive" className="py-2">
                  {notificationError}
                </Alert>
              )}

              {notificationSuccess && <Alert className="py-2">{notificationSuccess}</Alert>}

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
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] font-semibold text-white">
                        PF
                      </div>
                      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <div className="font-semibold text-gray-900 dark:text-white">PrintFarm Bot</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">Webhook Target</div>
                          </div>
                          <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
                            <div className="flex items-start gap-3">
                              <div className="h-full w-1 shrink-0 rounded-full bg-[#5865f2]" />
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-gray-900 dark:text-white">{webhook.name}</div>
                                <div className="mt-2 truncate font-mono text-sm text-gray-600 dark:text-gray-300">
                                  {webhook.webhookUrl}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
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

              {integrationError && (
                <Alert variant="destructive" className="py-2">
                  {integrationError}
                </Alert>
              )}

              {integrationSuccess && <Alert className="py-2">{integrationSuccess}</Alert>}

              <Button type="submit" disabled={savingIntegrations}>
                {savingIntegrations ? 'Saving...' : 'Save Integration URLs'}
              </Button>
            </form>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
