import { useEffect, useMemo, useRef, useState } from 'react';
import { Nfc, Trash2 } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { FilamentSpoolIcon } from '../components/FilamentSpoolIcon';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { FILAMENT_MATERIALS, FILAMENT_VENDORS } from '../lib/printerProfiles';
import { usePrinters } from '../contexts/PrintersContext';
import { toast } from 'sonner';
import {
  type FilamentSpool,
  type FilamentStationAssignment,
  fetchFilamentSpools,
  fetchFilamentStationAssignments,
  fetchOpenSpoolPayload,
  linkFilamentTag,
  reportTagScanned,
  createFilamentSpool,
  deleteFilamentSpool,
  assignFilamentSpool,
  unassignFilamentSpool,
} from '../lib/filamentStationApi';

const REFRESH_INTERVAL_MS = 8000;

// Live readouts (weights) share PrinterDetail's instrument-panel numeral
// treatment — monospaced, tabular figures — so a spool's remaining grams
// reads like the same gauge family as the printer pages, not a stray label.
const READOUT = 'font-mono tabular-nums';

function spoolHex(rgba: string): string {
  return `#${(rgba || 'FFFFFFFF').slice(0, 6)}`;
}

function spoolLabel(s: FilamentSpool): string {
  return `${s.material}${s.subtype ? ` ${s.subtype}` : ''}${s.colorName ? ` — ${s.colorName}` : ''}`;
}

// Weight-remaining gauge: unlike PrinterDetail's heater bar (a fixed
// cold→hot scale), this page's "accent color" comes from the physical
// inventory itself — the fill is the spool's own filament color, proportional
// to grams left, so the card's dominant color always matches what's on the
// shelf.
function SpoolWeightGauge({ rgba, remaining, total }: { rgba: string; remaining: number; total: number }) {
  const percent = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full border border-border bg-muted">
        <div
          className="h-full rounded-full ring-1 ring-inset ring-black/10 transition-[width] dark:ring-white/10"
          style={{ width: `${percent}%`, backgroundColor: spoolHex(rgba) }}
        />
      </div>
      <p className={`${READOUT} text-xs text-muted-foreground`}>
        {Math.max(0, Math.round(remaining))}g / {Math.round(total)}g
      </p>
    </div>
  );
}

// Web NFC (NDEFReader) isn't in TypeScript's standard DOM lib — it's an
// experimental, Android-Chromium-only API (no Firefox, no desktop, no iOS/
// Safari, confirmed no signal Apple will add it). Minimal ambient shape for
// just what's used here rather than pulling in a third-party types package.
interface NDEFReadingEvent {
  serialNumber: string;
}
interface NDEFReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  // Chrome's implementation requires `data` for a 'mime' record to be a
  // BufferSource (ArrayBuffer/TypedArray), not a plain string — passing a
  // string throws "The provided value is not of type 'ArrayBuffer' or
  // ArrayBufferView'". Encode with TextEncoder before calling write().
  write(message: { records: { recordType: string; mediaType?: string; data: BufferSource }[] }): Promise<void>;
  onreading: ((event: NDEFReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
}

function isWebNfcSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

// The one orchestrated motion moment on this page: two soft rings expanding
// out from the NFC glyph while the phone's radio is actively listening,
// echoing an actual NFC field rather than a generic spinner. Static (no
// rings) once nothing is in flight, so the page stays quiet the rest of the
// time.
function ScanPulse({ active }: { active: boolean }) {
  return (
    <div className="relative flex size-16 shrink-0 items-center justify-center">
      {active && (
        <>
          <span className="absolute inline-flex size-16 animate-ping rounded-full bg-primary/15" />
          <span className="absolute inline-flex size-11 animate-ping rounded-full bg-primary/20 [animation-delay:300ms]" />
        </>
      )}
      <span className="relative flex size-11 items-center justify-center rounded-full border border-border bg-card">
        <Nfc className={`size-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      </span>
    </div>
  );
}

function normalizeTagUid(serialNumber: string): string {
  return serialNumber.replace(/:/g, '').toUpperCase();
}

// ── NFC scan/write (Android Web NFC) ────────────────────────────────────────
//
// No station device to talk to — the phone's own NFC radio does the read/
// write directly in-browser; the server only resolves a scanned tag to a
// spool (tag-scanned) or records which tag now holds a spool after a
// successful write (link-tag). Writing is two separate taps: write() does
// its own tap-detection and write in one call (never run a scan() on the
// same NDEFReader concurrently — Chrome surfaces that conflict as "failed
// to write due to an io error"), then a second, fresh scan() confirms the
// tag's serialNumber to link it to the spool.
function NfcTab({ spools, onChange }: { spools: FilamentSpool[]; onChange: () => void }) {
  const supported = useMemo(() => isWebNfcSupported(), []);
  const [mode, setMode] = useState<'scan' | 'write'>('scan');
  const [spoolId, setSpoolId] = useState('');
  const [status, setStatus] = useState('');
  const [scanResult, setScanResult] = useState<{ matched: boolean; spool: FilamentSpool | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('');
  }

  async function startScan() {
    setScanResult(null);
    setStatus('Tap a tag to scan…');
    try {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const NDEFReaderCtor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
      const reader = new NDEFReaderCtor();
      reader.onreading = (event) => {
        const tagUid = normalizeTagUid(event.serialNumber);
        setStatus(`Tag detected: ${tagUid}`);
        reportTagScanned(tagUid)
          .then((result) => {
            const spool = result.matched ? (spools.find((s) => s.id === result.spool_id) ?? null) : null;
            setScanResult({ matched: result.matched, spool });
            if (result.matched) {
              toast.success(spool ? `Matched: ${spoolLabel(spool)}` : 'Matched an existing spool');
            } else {
              toast.message('Unknown tag — no matching spool');
            }
          })
          .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
      };
      reader.onreadingerror = () => toast.error('Failed to read tag — try again');
      await reader.scan({ signal: controller.signal });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setStatus('');
    }
  }

  async function startWrite() {
    if (!spoolId) return;
    setStatus('Fetching tag payload…');
    try {
      const payload = await fetchOpenSpoolPayload(spoolId);
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const NDEFReaderCtor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;

      // Two separate, sequential operations — NOT a scan() left running
      // underneath a write() on the same reader. write() does its own tap
      // detection internally; running a scan() concurrently on the same
      // NDEFReader made the radio see two competing operations at once,
      // which Chrome surfaced as "failed to write due to an io error".
      abortRef.current?.abort();
      setStatus('Tap the tag to write…');
      const writer = new NDEFReaderCtor();
      await writer.write({
        records: [{ recordType: 'mime', mediaType: 'application/json', data: bytes }],
      });

      setStatus('Written — tap the tag again to confirm its ID…');
      const controller = new AbortController();
      abortRef.current = controller;
      const reader = new NDEFReaderCtor();
      const serialNumber = await new Promise<string>((resolve, reject) => {
        reader.onreading = (event) => resolve(event.serialNumber);
        reader.onreadingerror = () => reject(new Error('Failed to confirm tag'));
        reader.scan({ signal: controller.signal }).catch(reject);
      });

      const tagUid = normalizeTagUid(serialNumber);
      await linkFilamentTag(spoolId, tagUid);
      toast.success('Tag written and linked to spool');
      stop();
      onChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setStatus('');
    }
  }

  if (!supported) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        NFC scan/write needs Chrome, Edge, or Samsung Internet on an Android phone with NFC turned on — open this
        page there. Safari/iOS has no Web NFC support; use the separate iOS app for iPhone.
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={mode === 'scan' ? 'default' : 'outline'}
          onClick={() => {
            stop();
            setMode('scan');
          }}
        >
          Scan to identify
        </Button>
        <Button
          size="sm"
          variant={mode === 'write' ? 'default' : 'outline'}
          onClick={() => {
            stop();
            setMode('write');
          }}
        >
          Write a tag
        </Button>
      </div>

      {mode === 'scan' ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <ScanPulse active={Boolean(status)} />
          <Button onClick={startScan}>{status ? 'Scanning…' : 'Start scan'}</Button>
          {status && <p className="text-sm text-muted-foreground">{status}</p>}
          {scanResult && (
            <div className="text-sm">
              {scanResult.matched ? (
                <div className="flex items-center gap-2">
                  {scanResult.spool && <FilamentSpoolIcon color={spoolHex(scanResult.spool.rgba)} />}
                  Matched{scanResult.spool ? `: ${spoolLabel(scanResult.spool)}` : ''}
                </div>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">No spool matched this tag.</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="max-w-sm space-y-2">
          <Label>Spool</Label>
          <Select value={spoolId} onValueChange={setSpoolId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a spool" />
            </SelectTrigger>
            <SelectContent>
              {spools.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {spoolLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={startWrite} disabled={!spoolId}>
            Write tag
          </Button>
          {status && <p className="text-sm text-muted-foreground">{status}</p>}
        </div>
      )}
    </Card>
  );
}

const NO_VENDOR = '__unspecified__';

function AddSpoolDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [material, setMaterial] = useState<string>(FILAMENT_MATERIALS[0]);
  const [subtype, setSubtype] = useState('');
  const [colorName, setColorName] = useState('');
  const [rgba, setRgba] = useState('FFFFFFFF');
  const [brand, setBrand] = useState('');
  const [labelWeight, setLabelWeight] = useState('1000');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await createFilamentSpool({
        material,
        subtype: subtype || undefined,
        color_name: colorName || undefined,
        rgba: rgba || undefined,
        brand: brand || undefined,
        label_weight: labelWeight ? Number(labelWeight) : undefined,
      });
      toast.success('Spool added');
      onOpenChange(false);
      onCreated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add spool</DialogTitle>
          <DialogDescription>Add a physical spool to the local filament inventory.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Material</Label>
            <Select value={material} onValueChange={setMaterial}>
              <SelectTrigger>
                <SelectValue placeholder="Select material" />
              </SelectTrigger>
              <SelectContent>
                {FILAMENT_MATERIALS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Subtype</Label>
            <Input value={subtype} onChange={(e) => setSubtype(e.target.value)} placeholder="Basic" />
          </div>
          <div className="space-y-2">
            <Label>Vendor</Label>
            <Select value={brand || NO_VENDOR} onValueChange={(v) => setBrand(v === NO_VENDOR ? '' : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VENDOR}>Unspecified</SelectItem>
                {FILAMENT_VENDORS.map((vendor) => (
                  <SelectItem key={vendor} value={vendor}>
                    {vendor}
                  </SelectItem>
                ))}
                {/* Keep a vendor typed in previously (not in the preset list) selectable. */}
                {brand && !FILAMENT_VENDORS.includes(brand as (typeof FILAMENT_VENDORS)[number]) && (
                  <SelectItem value={brand}>{brand}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Color name</Label>
            <Input value={colorName} onChange={(e) => setColorName(e.target.value)} placeholder="Jade White" />
          </div>
          <div className="col-span-2 space-y-2">
            <Label>Color</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={`#${rgba.slice(0, 6)}`}
                onChange={(e) => setRgba(`${e.target.value.replace('#', '').toUpperCase()}FF`)}
                className="h-10 w-16 cursor-pointer rounded border border-input bg-transparent"
              />
              <Input
                value={rgba}
                onChange={(e) => setRgba(e.target.value.toUpperCase())}
                placeholder="FFFFFFFF"
                className="w-32"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Label weight (g)</Label>
            <Input type="number" value={labelWeight} onChange={(e) => setLabelWeight(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !material}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpoolCard({ spool, onDelete }: { spool: FilamentSpool; onDelete: (id: string) => void }) {
  const tagged = Boolean(spool.tagUid || spool.trayUuid);
  return (
    <Card className="flex-row items-start gap-3 p-4">
      <FilamentSpoolIcon color={spoolHex(spool.rgba)} scale={1.5} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{spoolLabel(spool)}</p>
            <p className="truncate text-xs text-muted-foreground">{spool.brand ?? 'Unbranded'}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="-mr-1.5 -mt-1.5 size-7 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(spool.id)}
            aria-label={`Delete ${spoolLabel(spool)}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        {spool.labelWeight ? (
          <SpoolWeightGauge rgba={spool.rgba} remaining={spool.labelWeight - spool.weightUsed} total={spool.labelWeight} />
        ) : (
          <p className="text-xs text-muted-foreground">No label weight recorded</p>
        )}
        <Badge
          className={
            tagged
              ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
              : 'bg-muted text-muted-foreground'
          }
        >
          {tagged ? 'Tagged' : 'No tag'}
        </Badge>
      </div>
    </Card>
  );
}

function SpoolsTab({ spools, onChange }: { spools: FilamentSpool[]; onChange: () => void }) {
  const [addOpen, setAddOpen] = useState(false);

  async function handleDelete(id: string) {
    try {
      await deleteFilamentSpool(id);
      onChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          Add spool
        </Button>
      </div>
      {spools.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No spools yet — add one manually, or load a genuine Bambu-tagged spool into an AMS to auto-catalog it.
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {spools.map((s) => (
            <SpoolCard key={s.id} spool={s} onDelete={handleDelete} />
          ))}
        </div>
      )}

      <AddSpoolDialog open={addOpen} onOpenChange={setAddOpen} onCreated={onChange} />
    </div>
  );
}

function AssignmentsTab({
  assignments,
  spools,
  onChange,
}: {
  assignments: FilamentStationAssignment[];
  spools: FilamentSpool[];
  onChange: () => void;
}) {
  const { printers } = usePrinters();
  const [assignOpen, setAssignOpen] = useState(false);
  const [spoolId, setSpoolId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [amsId, setAmsId] = useState('0');
  const [trayId, setTrayId] = useState('0');
  const [pendingConfig, setPendingConfig] = useState(true);

  const spoolById = useMemo(() => new Map(spools.map((s) => [s.id, s])), [spools]);
  const printerById = useMemo(() => new Map(printers.map((p) => [p.id, p])), [printers]);

  // Grouped by printer rather than a flat list — which printer a slot lives
  // on is the thing an operator actually scans for ("what's loaded on the
  // A1 mini"), not an arbitrary assignment id.
  const groupedByPrinter = useMemo(() => {
    const groups = new Map<string, FilamentStationAssignment[]>();
    for (const a of assignments) {
      const list = groups.get(a.printerId) ?? [];
      list.push(a);
      groups.set(a.printerId, list);
    }
    return Array.from(groups.entries()).sort(([aId], [bId]) =>
      (printerById.get(aId)?.name ?? aId).localeCompare(printerById.get(bId)?.name ?? bId),
    );
  }, [assignments, printerById]);

  async function submitAssign() {
    if (!spoolId || !printerId) return;
    try {
      const result = await assignFilamentSpool({
        spool_id: spoolId,
        printer_id: printerId,
        ams_id: Number(amsId),
        tray_id: Number(trayId),
        pending_config: pendingConfig,
      });
      if (result.mqtt_warning) {
        toast.warning(`Assigned, but the printer push failed: ${result.mqtt_warning}`);
      } else {
        toast.success(pendingConfig ? 'Assigned — will apply once the slot is loaded' : 'Assigned and pushed to printer');
      }
      setAssignOpen(false);
      onChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleUnassign(a: FilamentStationAssignment) {
    try {
      await unassignFilamentSpool(a.printerId, a.amsId, a.trayId);
      onChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAssignOpen(true)}>
          Assign spool
        </Button>
      </div>
      {groupedByPrinter.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No assignments yet.</Card>
      ) : (
        <div className="space-y-3">
          {groupedByPrinter.map(([printerId, list]) => {
            const printer = printerById.get(printerId);
            return (
              <Card key={printerId} className="gap-0 overflow-hidden p-0">
                <div className="flex items-center justify-between border-b px-4 py-2.5">
                  <span className="font-medium">{printer?.name ?? printerId}</span>
                  <span className="text-xs text-muted-foreground">
                    {list.length} slot{list.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="divide-y">
                  {list.map((a) => {
                    const spool = spoolById.get(a.spoolId);
                    return (
                      <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:flex-nowrap">
                        <FilamentSpoolIcon color={spool ? spoolHex(spool.rgba) : '#9ca3af'} scale={0.85} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            AMS{a.amsId}-T{a.trayId}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {spool ? spoolLabel(spool) : a.spoolId}
                          </p>
                        </div>
                        {/* Kept together so this pair wraps as a unit onto its
                            own line on a narrow phone instead of the badge and
                            delete button splitting across two lines. */}
                        <div className="ml-auto flex items-center gap-2">
                          {a.pendingConfig ? (
                            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                              Will apply on load
                            </Badge>
                          ) : a.lastTriggerResult === 'ok' ? (
                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                              Applied
                            </Badge>
                          ) : (
                            <Badge className="bg-muted text-muted-foreground">—</Badge>
                          )}
                          <Button size="sm" variant="outline" onClick={() => handleUnassign(a)}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign spool to a printer slot</DialogTitle>
            <DialogDescription>
              For Bambu printers this pushes the spool's material/color to the printer over MQTT (immediately if the
              slot is already loaded, or the next time it's loaded if left pending). Snapmaker U1 lanes with an
              OpenSpool tag need no assignment — the printer reads the tag directly.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Spool</Label>
              <Select value={spoolId} onValueChange={setSpoolId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a spool" />
                </SelectTrigger>
                <SelectContent>
                  {spools.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {spoolLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Printer</Label>
              <Select value={printerId} onValueChange={setPrinterId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a printer" />
                </SelectTrigger>
                <SelectContent>
                  {printers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>AMS unit</Label>
              <Input type="number" value={amsId} onChange={(e) => setAmsId(e.target.value)} />
            </div>
            <div>
              <Label>Tray / lane</Label>
              <Input type="number" value={trayId} onChange={(e) => setTrayId(e.target.value)} />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pendingConfig} onChange={(e) => setPendingConfig(e.target.checked)} />
              Slot is currently empty (apply once loaded)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitAssign} disabled={!spoolId || !printerId}>
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function FilamentStation() {
  const [spools, setSpools] = useState<FilamentSpool[]>([]);
  const [assignments, setAssignments] = useState<FilamentStationAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    try {
      const [s, a] = await Promise.all([fetchFilamentSpools(), fetchFilamentStationAssignments()]);
      setSpools(s);
      setAssignments(a);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }

  useAutoRefresh(refresh, REFRESH_INTERVAL_MS);

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold text-foreground">Filament Station</h1>
        <p className="text-muted-foreground">Spool inventory, NFC tags, and AMS assignments across the farm</p>
      </div>

      {loaded && (
        <Tabs defaultValue="nfc">
          {/* Three triggers can run wider than a phone screen; scroll instead of
              clipping off the edge. Fits within its container at every width
              this app already targets, so the wrapper is a no-op on desktop. */}
          <div className="overflow-x-auto">
            <TabsList className="w-max">
              <TabsTrigger value="nfc">
                <Nfc className="mr-1.5 size-4" /> NFC scan/write
              </TabsTrigger>
              <TabsTrigger value="spools">Spool inventory ({spools.length})</TabsTrigger>
              <TabsTrigger value="assignments">Assignments ({assignments.length})</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="nfc" className="mt-4">
            <NfcTab spools={spools} onChange={refresh} />
          </TabsContent>
          <TabsContent value="spools" className="mt-4">
            <SpoolsTab spools={spools} onChange={refresh} />
          </TabsContent>
          <TabsContent value="assignments" className="mt-4">
            <AssignmentsTab assignments={assignments} spools={spools} onChange={refresh} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
