// Resolve a Bambu project_file AMS mapping for a slicer push: match each
// filament the sliced 3MF uses (extractFilamentsFrom3mf) against the printer's
// live AMS spool snapshot (the poller's `spools` column) so a farm push feeds
// from the AMS instead of demanding an external spool. Matching is by material
// (exact, case-insensitive — PETG never substitutes for PETG-CF), preferring an
// exact color match when the tray reports one, then the fullest spool
// (`remaining`), never assigning one tray to two filaments.
//
// Returns { mapping, assignments } — `mapping` is the ams_mapping array for
// the project_file command (0-based global tray ids, amsIndex*4+slot; -1 for
// filament slots the plate doesn't use), `assignments` a human-readable trace
// for the log. Returns null when any used filament has no matching tray (or
// there's no usable AMS data at all): the caller then falls back to the
// external spool exactly as before, rather than starting a print the firmware
// would pause on a half-resolvable mapping.
export function resolveAmsMapping(filaments, spools) {
  if (!Array.isArray(filaments) || filaments.length === 0) return null;
  if (!Array.isArray(spools) || spools.length === 0) return null;

  const trays = [];
  for (const spool of spools) {
    // Poller tray ids are "ams<unit>-<slot>"; anything else (external spool
    // pseudo-entries, unknown shapes) can't be MQTT-addressed as an AMS tray.
    const idMatch = /^ams(\d+)-(\d+)$/.exec(String(spool?.id ?? ''));
    if (!idMatch) continue;
    const material = String(spool.material ?? '').trim();
    if (!material) continue; // empty/unread tray
    trays.push({
      globalId: Number(idMatch[1]) * 4 + Number(idMatch[2]),
      material: material.toUpperCase(),
      color: normalizeColor(spool.color),
      remaining: Number.isFinite(Number(spool.remaining)) ? Number(spool.remaining) : -1,
      label: `${spool.id} ${material}${spool.color ? ` ${spool.color}` : ''}`,
      taken: false,
    });
  }
  if (trays.length === 0) return null;

  const wanted = filaments
    .filter((f) => Number.isInteger(f?.id) && f.id > 0 && String(f.type ?? '').trim())
    .sort((a, b) => a.id - b.id);
  if (wanted.length === 0) return null;

  const assignments = [];
  for (const filament of wanted) {
    const material = String(filament.type).trim().toUpperCase();
    const candidates = trays.filter((t) => !t.taken && t.material === material);
    if (candidates.length === 0) return null;
    const color = normalizeColor(filament.color);
    const exactColor = color ? candidates.filter((t) => t.color === color) : [];
    const pool = exactColor.length > 0 ? exactColor : candidates;
    const tray = pool.reduce((best, t) => (t.remaining > best.remaining ? t : best));
    tray.taken = true;
    assignments.push({ filamentId: filament.id, tray });
  }

  const mapping = new Array(wanted[wanted.length - 1].id).fill(-1);
  for (const { filamentId, tray } of assignments) {
    mapping[filamentId - 1] = tray.globalId;
  }
  return { mapping, assignments };
}

// "#999d9dff"/"999D9D" → "#999D9D"; anything unparseable → '' (never matches).
function normalizeColor(raw) {
  const match = /^#?([0-9A-F]{6})/.exec(String(raw ?? '').trim().toUpperCase());
  return match ? `#${match[1]}` : '';
}
