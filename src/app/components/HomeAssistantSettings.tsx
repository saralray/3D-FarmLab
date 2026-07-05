import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plug,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import {
  createHaRule,
  deleteHaRule,
  fetchHaRules,
  fetchHomeAssistantConfig,
  fetchHomeAssistantDevices,
  saveHomeAssistantConfig,
  setHaRuleEnabled,
  testHomeAssistantConnection,
  type HaDevices,
  type HaRule,
  type HaRuleDirection,
} from '../lib/homeAssistantApi';
import { fetchPrinters } from '../lib/printersApi';
import type { Printer, PrinterStatus } from '../types';

interface HomeAssistantSettingsProps {
  disabled?: boolean;
}

const COMMON_SERVICES = [
  'switch.turn_on',
  'switch.turn_off',
  'switch.toggle',
  'light.turn_on',
  'light.turn_off',
  'light.toggle',
  'fan.turn_on',
  'fan.turn_off',
  'climate.set_temperature',
  'notify.notify',
  'script.turn_on',
];

const HIDDEN_CARD_DOMAINS = new Set([
  'automation',
  'sensor',
  'binary_sensor',
  'sun',
  'zone',
  'update',
  'person',
  'number',
  'device_tracker',
  'camera',
]);

const PRINTER_STATUSES: PrinterStatus[] = ['printing', 'idle', 'paused', 'error', 'offline'];
const PRINTER_COMMANDS = ['pause', 'resume', 'cancel'] as const;
const NONE_VALUE = '__none__';

function EntitySelect({
  value,
  onChange,
  entities,
  disabled,
  allowNone = false,
  emptyLabel = 'Load devices first',
}: {
  value: string;
  onChange: (value: string) => void;
  entities: { entityId: string; friendlyName: string }[];
  disabled?: boolean;
  allowNone?: boolean;
  emptyLabel?: string;
}) {
  return (
    <Select
      value={value || (allowNone ? NONE_VALUE : '')}
      onValueChange={(v) => onChange(v === NONE_VALUE ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={entities.length ? 'Select an entity' : emptyLabel} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE_VALUE}>(none)</SelectItem>}
        {entities.map((entity) => (
          <SelectItem key={entity.entityId} value={entity.entityId}>
            {entity.friendlyName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Section({
  title,
  description,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <div className="min-w-0">
          <span className="font-semibold text-foreground">{title}</span>
          {description && !open && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {open ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <>
          {description && (
            <p className="px-5 pb-3 text-sm text-muted-foreground">{description}</p>
          )}
          <div className="border-t border-border px-5 py-5">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

export function HomeAssistantSettings({ disabled = false }: HomeAssistantSettingsProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [devices, setDevices] = useState<HaDevices | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [rules, setRules] = useState<HaRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(false);

  const [direction, setDirection] = useState<HaRuleDirection>('printer_to_ha');
  const [name, setName] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [triggerEntity, setTriggerEntity] = useState('');
  const [triggerState, setTriggerState] = useState('');
  const [printerCommand, setPrinterCommand] = useState<(typeof PRINTER_COMMANDS)[number]>('pause');
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus>('idle');
  const [actionService, setActionService] = useState('');
  const [actionEntity, setActionEntity] = useState('');
  const [actionData, setActionData] = useState('');
  const [creating, setCreating] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    fetchHomeAssistantConfig()
      .then((config) => {
        if (cancelled) return;
        setBaseUrl(config.baseUrl);
        setHasToken(config.hasToken);
        setEnabled(config.enabled);
      })
      .catch(() => toast.error('Unable to load Home Assistant settings.'));
    fetchPrinters()
      .then((list) => { if (!cancelled) setPrinters(list); })
      .catch(() => {});
    loadRules();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const configured = baseUrl.trim().length > 0 && (hasToken || token.trim().length > 0);
  const printerName = (id: string) => printers.find((p) => p.id === id)?.name ?? id;

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) { toast.error('Only admins can change Home Assistant settings.'); return; }
    const trimmedUrl = baseUrl.trim();
    if (enabled && (!trimmedUrl || (!hasToken && !token.trim()))) {
      toast.error('A Home Assistant URL and access token are required to enable the integration.');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveHomeAssistantConfig({ baseUrl: trimmedUrl, token: token.trim(), enabled });
      setBaseUrl(saved.baseUrl);
      setHasToken(saved.hasToken);
      setEnabled(saved.enabled);
      setToken('');
      toast.success('Home Assistant settings saved.');
    } catch (error) {
      toast.error('Unable to save Home Assistant settings.', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testHomeAssistantConnection();
      if (result.ok) toast.success(result.message ?? 'Connected to Home Assistant.');
      else toast.error('Connection failed.', { description: result.error });
    } catch (error) {
      toast.error('Connection failed.', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setTesting(false);
    }
  };

  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const data = await fetchHomeAssistantDevices();
      setDevices(data);
      // Auto-expand the first few domains.
      const domains = Object.keys(data.groups ?? {})
        .filter((d) => !HIDDEN_CARD_DOMAINS.has(d))
        .slice(0, 3);
      setExpandedDomains(new Set(domains));
    } catch (error) {
      toast.error('Unable to load Home Assistant devices.', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoadingDevices(false);
    }
  };

  const toggleDomain = (domain: string) =>
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      next.has(domain) ? next.delete(domain) : next.add(domain);
      return next;
    });

  const loadRules = async () => {
    setLoadingRules(true);
    try { setRules(await fetchHaRules()); }
    catch (error) { toast.error('Unable to load automation rules.', { description: error instanceof Error ? error.message : undefined }); }
    finally { setLoadingRules(false); }
  };

  const handleCreateRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) { toast.error('Only admins can create automations.'); return; }
    if (!name.trim() || !printerId) { toast.error('A name and a printer are required.'); return; }
    if (direction === 'ha_to_printer' && (!triggerEntity.trim() || !triggerState.trim())) {
      toast.error('A trigger entity and state are required.'); return;
    }
    if (direction === 'printer_to_ha' && (!actionService.trim() || !actionEntity.trim())) {
      toast.error('An action service and target entity are required.'); return;
    }
    setCreating(true);
    try {
      await createHaRule({
        name: name.trim(), direction, enabled: true, printerId,
        triggerEntity: triggerEntity.trim(), triggerState: triggerState.trim(),
        printerCommand, printerStatus,
        actionService: actionService.trim(), actionEntity: actionEntity.trim(), actionData: actionData.trim(),
      });
      toast.success('Automation created.', { description: name.trim() });
      setName(''); setTriggerEntity(''); setTriggerState('');
      setActionService(''); setActionEntity(''); setActionData('');
      await loadRules();
    } catch (error) {
      toast.error('Unable to create automation.', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setCreating(false);
    }
  };

  const handleToggleRule = async (rule: HaRule, next: boolean) => {
    setTogglingId(rule.id);
    try {
      await setHaRuleEnabled(rule.id, next);
      setRules((current) => current.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
    } catch (error) {
      toast.error('Unable to update automation.', { description: error instanceof Error ? error.message : undefined });
    } finally { setTogglingId(null); }
  };

  const handleDeleteRule = async (rule: HaRule) => {
    if (disabled) { toast.error('Only admins can delete automations.'); return; }
    setDeletingId(rule.id);
    try {
      await deleteHaRule(rule.id);
      toast.success('Automation deleted.');
      setRules((current) => current.filter((r) => r.id !== rule.id));
    } catch (error) {
      toast.error('Unable to delete automation.', { description: error instanceof Error ? error.message : undefined });
    } finally { setDeletingId(null); }
  };

  const describeRule = (rule: HaRule) =>
    rule.direction === 'ha_to_printer'
      ? `When ${rule.triggerEntity} → "${rule.triggerState}", ${rule.printerCommand} ${printerName(rule.printerId)}`
      : `When ${printerName(rule.printerId)} → "${rule.printerStatus}", call ${rule.actionService}${rule.actionEntity ? ` on ${rule.actionEntity}` : ''}`;

  const entities = devices?.entities ?? [];
  const serviceDomain = actionService.includes('.') ? actionService.split('.')[0] : '';
  const actionEntities = serviceDomain
    ? entities.filter((entity) => entity.domain === serviceDomain)
    : entities;

  const handleActionServiceChange = (service: string) => {
    setActionService(service);
    const domain = service.includes('.') ? service.split('.')[0] : '';
    if (actionEntity && domain && !entities.some((e) => e.entityId === actionEntity && e.domain === domain)) {
      setActionEntity('');
    }
  };

  const cardGroups = Object.entries(devices?.groups ?? {})
    .filter(([domain, items]) => !HIDDEN_CARD_DOMAINS.has(domain) && items.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-4">

      {/* Connection */}
      <Section
        title="Connection"
        description="Home Assistant base URL and long-lived access token"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Enable integration</p>
              <p className="text-xs text-muted-foreground">
                Required for device fetching and automation rules.
              </p>
            </div>
            <Switch id="ha-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ha-base-url">Home Assistant URL</Label>
              <Input
                id="ha-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://homeassistant.local:8123"
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ha-token">Long-lived access token</Label>
              <Input
                id="ha-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={hasToken ? '•••••••• (leave blank to keep)' : 'Paste token'}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
              {hasToken && (
                <p className="text-xs text-muted-foreground">
                  Token stored. Leave blank to keep it.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving || disabled}>
              {saving ? 'Saving…' : 'Save connection'}
            </Button>
            <Button type="button" variant="outline" onClick={handleTest} disabled={testing || !configured}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              Test connection
            </Button>
          </div>
        </form>
      </Section>

      {/* Devices */}
      <Section
        title="Devices & entities"
        description="Controllable devices from Home Assistant, grouped by domain"
        defaultOpen={false}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => { e.stopPropagation(); loadDevices(); }}
            disabled={loadingDevices || !configured}
          >
            {loadingDevices ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {devices ? 'Refresh' : 'Load'}
          </Button>
        }
      >
        {!devices && (
          <p className="text-sm text-muted-foreground">
            Click Load to fetch devices from Home Assistant.
          </p>
        )}
        {devices && cardGroups.length === 0 && (
          <p className="text-sm text-muted-foreground">No controllable devices found.</p>
        )}
        {devices && cardGroups.length > 0 && (
          <div className="space-y-2">
            {cardGroups.map(([domain, items]) => (
              <div key={domain} className="rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => toggleDomain(domain)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize text-foreground">{domain}</span>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  {expandedDomains.has(domain)
                    ? <ChevronDown className="size-3.5 text-muted-foreground" />
                    : <ChevronRight className="size-3.5 text-muted-foreground" />}
                </button>
                {expandedDomains.has(domain) && (
                  <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((entity) => (
                      <div
                        key={entity.entityId}
                        className="rounded-md border border-border bg-muted p-2 text-sm"
                      >
                        <div className="truncate font-medium text-foreground" title={entity.friendlyName}>
                          {entity.friendlyName}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground" title={entity.entityId}>
                          {entity.entityId}
                        </div>
                        <div className="text-xs text-muted-foreground">{entity.state}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Automation builder */}
      <Section
        title="Create automation"
        description="Bridge printer events and Home Assistant actions"
        defaultOpen={false}
      >
        <form onSubmit={handleCreateRule} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as HaRuleDirection)} disabled={disabled}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="printer_to_ha">Printer → Home Assistant</SelectItem>
                  <SelectItem value="ha_to_printer">Home Assistant → Printer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ha-rule-name">Name</Label>
              <Input
                id="ha-rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lights off when print done"
                disabled={disabled}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* WHEN */}
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">When</p>
              {direction === 'printer_to_ha' ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Printer</Label>
                    <Select value={printerId} onValueChange={setPrinterId} disabled={disabled}>
                      <SelectTrigger><SelectValue placeholder="Select a printer" /></SelectTrigger>
                      <SelectContent>
                        {printers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Status becomes</Label>
                    <Select value={printerStatus} onValueChange={(v) => setPrinterStatus(v as PrinterStatus)} disabled={disabled}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRINTER_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">HA entity</Label>
                    <EntitySelect value={triggerEntity} onChange={setTriggerEntity} entities={entities} disabled={disabled} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ha-trigger-state" className="text-xs">State becomes</Label>
                    <Input
                      id="ha-trigger-state"
                      value={triggerState}
                      onChange={(e) => setTriggerState(e.target.value)}
                      placeholder="off"
                      disabled={disabled}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
            </div>

            {/* DO */}
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Do</p>
              {direction === 'printer_to_ha' ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Call service</Label>
                    <Select value={actionService} onValueChange={handleActionServiceChange} disabled={disabled}>
                      <SelectTrigger><SelectValue placeholder="Select a service" /></SelectTrigger>
                      <SelectContent>
                        {COMMON_SERVICES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Target entity</Label>
                    <EntitySelect
                      value={actionEntity}
                      onChange={setActionEntity}
                      entities={actionEntities}
                      disabled={disabled || !serviceDomain}
                      emptyLabel={!serviceDomain ? 'Pick a service first' : entities.length ? `No ${serviceDomain} entities` : 'Load devices first'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ha-action-data" className="text-xs">Extra data (JSON, optional)</Label>
                    <Textarea
                      id="ha-action-data"
                      value={actionData}
                      onChange={(e) => setActionData(e.target.value)}
                      placeholder='{ "brightness": 200 }'
                      rows={2}
                      disabled={disabled}
                      spellCheck={false}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Printer</Label>
                    <Select value={printerId} onValueChange={setPrinterId} disabled={disabled}>
                      <SelectTrigger><SelectValue placeholder="Select a printer" /></SelectTrigger>
                      <SelectContent>
                        {printers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Command</Label>
                    <Select value={printerCommand} onValueChange={(v) => setPrinterCommand(v as (typeof PRINTER_COMMANDS)[number])} disabled={disabled}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRINTER_COMMANDS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </div>

          <Button type="submit" disabled={creating || disabled}>
            <ArrowLeftRight className="mr-2 size-4" />
            {creating ? 'Creating…' : 'Create automation'}
          </Button>
        </form>
      </Section>

      {/* Rules list */}
      <Section
        title="Automation rules"
        description={rules.length ? `${rules.length} rule${rules.length === 1 ? '' : 's'} active` : 'No rules yet'}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => { e.stopPropagation(); loadRules(); }}
            disabled={loadingRules}
          >
            {loadingRules ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        }
      >
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No automation rules yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{rule.name}</span>
                    <Badge variant="secondary" className="shrink-0">
                      {rule.direction === 'ha_to_printer' ? 'HA → printer' : 'printer → HA'}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{describeRule(rule)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(next) => handleToggleRule(rule, next)}
                    disabled={disabled || togglingId === rule.id}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteRule(rule)}
                    disabled={disabled || deletingId === rule.id}
                    title="Delete rule"
                  >
                    {deletingId === rule.id
                      ? <Loader2 className="size-4 animate-spin" />
                      : <Trash2 className="size-4" />}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
