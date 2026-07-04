import { useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Nfc, Trash2 } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table';
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

function ColorSwatch({ rgba }: { rgba: string }) {
  const hex = `#${(rgba || 'FFFFFFFF').slice(0, 6)}`;
  return (
    <span
      className="inline-block size-4 rounded-full border border-gray-300 align-middle dark:border-gray-600"
      style={{ backgroundColor: hex }}
      title={hex}
    />
  );
}

function spoolLabel(s: FilamentSpool): string {
  return `${s.material}${s.subtype ? ` ${s.subtype}` : ''}${s.colorName ? ` — ${s.colorName}` : ''}`;
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

function normalizeTagUid(serialNumber: string): string {
  return serialNumber.replace(/:/g, '').toUpperCase();
}

// ── NFC scan/write (Android Web NFC) ────────────────────────────────────────
//
// No station device to talk to — the phone's own NFC radio does the read/
// write directly in-browser; the server only resolves a scanned tag to a
// spool (tag-scanned) or records which tag now holds a spool after a
// successful write (link-tag). Exact read-then-write sequencing (a tag must
// be tapped once to capture its serialNumber via scan() before write())
// needs verification against a real Android phone — behavior isn't
// perfectly consistent across browser/OS versions.
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
      setStatus('Tap the tag to write…');

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const NDEFReaderCtor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
      const reader = new NDEFReaderCtor();

      const serialNumber = await new Promise<string>((resolve, reject) => {
        reader.onreading = (event) => resolve(event.serialNumber);
        reader.onreadingerror = () => reject(new Error('Failed to read tag'));
        reader.scan({ signal: controller.signal }).catch(reject);
      });

      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      await reader.write({
        records: [{ recordType: 'mime', mediaType: 'application/json', data: bytes }],
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
      <Card className="p-8 text-center text-sm text-gray-500 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-400">
        NFC scan/write needs Chrome, Edge, or Samsung Internet on an Android phone with NFC turned on — open this
        page there. Safari/iOS has no Web NFC support; use the separate iOS app for iPhone.
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-4 dark:bg-gray-800 dark:border-gray-700">
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
        <div className="space-y-2">
          <Button onClick={startScan}>Start scan</Button>
          {status && <p className="text-sm text-gray-500 dark:text-gray-400">{status}</p>}
          {scanResult && (
            <div className="text-sm">
              {scanResult.matched ? (
                <div className="flex items-center gap-2">
                  {scanResult.spool && <ColorSwatch rgba={scanResult.spool.rgba} />}
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
          {status && <p className="text-sm text-gray-500 dark:text-gray-400">{status}</p>}
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
      <Card className="overflow-x-auto dark:bg-gray-800 dark:border-gray-700">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Spool</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Weight</TableHead>
              <TableHead>Tag</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spools.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ColorSwatch rgba={s.rgba} />
                    <span>{spoolLabel(s)}</span>
                  </div>
                </TableCell>
                <TableCell>{s.brand ?? '—'}</TableCell>
                <TableCell>
                  {s.labelWeight ? `${Math.round(s.labelWeight - s.weightUsed)}g / ${s.labelWeight}g` : '—'}
                </TableCell>
                <TableCell>
                  {s.tagUid || s.trayUuid ? (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Tagged</Badge>
                  ) : (
                    <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">No tag</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => handleDelete(s.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {spools.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-gray-500 dark:text-gray-400">
                  No spools yet — add one manually, or load a genuine Bambu-tagged spool into an AMS to auto-catalog it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

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
      <Card className="overflow-x-auto dark:bg-gray-800 dark:border-gray-700">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Printer / slot</TableHead>
              <TableHead>Spool</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((a) => {
              const spool = spoolById.get(a.spoolId);
              const printer = printerById.get(a.printerId);
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    {printer?.name ?? a.printerId} — AMS{a.amsId}-T{a.trayId}
                  </TableCell>
                  <TableCell>
                    {spool ? (
                      <div className="flex items-center gap-2">
                        <ColorSwatch rgba={spool.rgba} />
                        {spool.material} {spool.subtype ?? ''}
                      </div>
                    ) : (
                      a.spoolId
                    )}
                  </TableCell>
                  <TableCell>
                    {a.pendingConfig ? (
                      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                        Will apply on load
                      </Badge>
                    ) : a.lastTriggerResult === 'ok' ? (
                      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Applied</Badge>
                    ) : (
                      <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">—</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => handleUnassign(a)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {assignments.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-gray-500 dark:text-gray-400">
                  No assignments yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

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
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Boxes className="size-6 text-gray-500 dark:text-gray-400" />
        <h1 className="text-xl font-semibold">Filament Station</h1>
      </div>

      {loaded && (
        <Tabs defaultValue="nfc">
          <TabsList>
            <TabsTrigger value="nfc">
              <Nfc className="mr-1.5 size-4" /> NFC scan/write
            </TabsTrigger>
            <TabsTrigger value="spools">Spool inventory ({spools.length})</TabsTrigger>
            <TabsTrigger value="assignments">Assignments ({assignments.length})</TabsTrigger>
          </TabsList>
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
