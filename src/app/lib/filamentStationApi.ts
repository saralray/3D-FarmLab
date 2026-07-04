// Client helpers for the Filament Station API. Fetch logic lives here, not in
// pages, mirroring maintenanceApi/printersApi. Talks to the cookie-session-gated
// /api/filament-station/* surface. There's no physical station device anymore —
// NFC read/write happens directly on an Android phone via the Web NFC API
// (Chrome/Edge/Samsung Internet only; no iOS/Safari support), so a spool's tag
// is scanned/written locally in-browser and only the result (tag UID ↔ spool)
// is reported back here. iOS uses a separate native app hitting the parallel
// API-key-gated /api/v1/filament-station/* surface (same handler, see server/app.js).

import { logAuditEvent } from './auditApi';

export interface FilamentSpool {
  id: string;
  material: string;
  subtype: string | null;
  colorName: string | null;
  rgba: string;
  brand: string | null;
  labelWeight: number;
  coreWeight: number;
  weightUsed: number;
  nozzleTempMin: number | null;
  nozzleTempMax: number | null;
  tagUid: string | null;
  trayUuid: string | null;
  dataOrigin: string | null;
  archived: boolean;
  createdAt: string;
}

export interface FilamentStationAssignment {
  id: string;
  spoolId: string;
  printerId: string;
  amsId: number;
  trayId: number;
  fingerprintColor: string | null;
  fingerprintType: string | null;
  pendingConfig: boolean;
  needsTriggerAt: string | null;
  lastTriggerResult: string | null;
  lastTriggeredAt: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const noStore: RequestInit = {
  cache: 'no-store',
  headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
};
const jsonHeaders = { 'Content-Type': 'application/json' };
const BASE = '/api/filament-station';

// ── Spools ───────────────────────────────────────────────────────────────────

export async function fetchFilamentSpools(): Promise<FilamentSpool[]> {
  return readJson<FilamentSpool[]>(await fetch(`${BASE}/spools`, noStore));
}

export interface FilamentSpoolInput {
  material: string;
  subtype?: string;
  color_name?: string;
  rgba?: string;
  brand?: string;
  label_weight?: number;
  core_weight?: number;
  nozzle_temp_min?: number;
  nozzle_temp_max?: number;
}

export async function createFilamentSpool(input: FilamentSpoolInput): Promise<FilamentSpool> {
  const spool = await readJson<FilamentSpool>(
    await fetch(`${BASE}/spools`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  );
  logAuditEvent('filament-station.spool.create', `${spool.material} ${spool.colorName ?? ''}`.trim());
  return spool;
}

export async function updateFilamentSpool(id: string, input: Partial<FilamentSpoolInput> & { archived?: boolean }): Promise<FilamentSpool> {
  const spool = await readJson<FilamentSpool>(
    await fetch(`${BASE}/spools/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  );
  logAuditEvent('filament-station.spool.update', id);
  return spool;
}

export async function deleteFilamentSpool(id: string): Promise<void> {
  await readJson(await fetch(`${BASE}/spools/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  logAuditEvent('filament-station.spool.delete', id);
}

// ── NFC (Android Web NFC — read/write happens in-browser, this just talks to
// the server before/after the phone's own NDEFReader does the actual tag I/O) ──

// The OpenSpool JSON payload to hand to NDEFReader.write() as a "mime" record
// (recordType: 'mime', mediaType: 'application/json', data: JSON.stringify(...)).
// The phone's own NFC stack handles NDEF framing — no byte encoding needed here.
export type OpenSpoolPayload = Record<string, unknown>;

export async function fetchOpenSpoolPayload(spoolId: string): Promise<OpenSpoolPayload> {
  return readJson<OpenSpoolPayload>(await fetch(`${BASE}/spools/${encodeURIComponent(spoolId)}/openspool-payload`, noStore));
}

// Call once the phone has successfully written the tag and captured its
// serialNumber from NDEFReader's `reading` event — links the physical tag to
// this spool so a future scan resolves back to it.
export async function linkFilamentTag(spoolId: string, tagUid: string): Promise<FilamentSpool> {
  const result = await readJson<{ spool: FilamentSpool }>(
    await fetch(`${BASE}/nfc/link-tag`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ spool_id: spoolId, tag_uid: tagUid }),
    }),
  );
  logAuditEvent('filament-station.spool.link-tag', spoolId, { tagUid });
  return result.spool;
}

export interface TagScanResult {
  matched: boolean;
  spool_id: string | null;
}

// Reports a scanned tag's UID (and, for a Bambu MIFARE Classic tag, its
// tray_uuid) so the server can resolve it to a spool. Decoding the tag's own
// NDEF payload (if any) happens on the phone; this is just the lookup call.
export async function reportTagScanned(tagUid: string, trayUuid?: string): Promise<TagScanResult> {
  return readJson<TagScanResult>(
    await fetch(`${BASE}/nfc/tag-scanned`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ tag_uid: tagUid, tray_uuid: trayUuid }),
    }),
  );
}

// ── Assignments ──────────────────────────────────────────────────────────────

export async function fetchFilamentStationAssignments(): Promise<FilamentStationAssignment[]> {
  return readJson<FilamentStationAssignment[]>(await fetch(`${BASE}/assignments`, noStore));
}

export interface AssignSpoolInput {
  spool_id: string;
  printer_id: string;
  ams_id?: number;
  tray_id: number;
  pending_config?: boolean;
}

export async function assignFilamentSpool(
  input: AssignSpoolInput,
): Promise<FilamentStationAssignment & { mqtt_warning?: string }> {
  const assignment = await readJson<FilamentStationAssignment & { mqtt_warning?: string }>(
    await fetch(`${BASE}/assignments`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }),
  );
  logAuditEvent('filament-station.assignment.create', `${input.printer_id} AMS${input.ams_id ?? 0}-T${input.tray_id}`);
  return assignment;
}

export async function unassignFilamentSpool(printerId: string, amsId: number, trayId: number): Promise<void> {
  await readJson(
    await fetch(`${BASE}/assignments/${encodeURIComponent(printerId)}/${amsId}/${trayId}`, { method: 'DELETE' }),
  );
  logAuditEvent('filament-station.assignment.delete', `${printerId} AMS${amsId}-T${trayId}`);
}
