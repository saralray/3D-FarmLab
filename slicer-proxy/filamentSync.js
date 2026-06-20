// Filament-sync mapping.
//
// The poller records each printer's currently-loaded filament in the `spools`
// JSONB column (one entry per AMS slot / external spool), shaped as
//   { id, color: "#rrggbb", material: "PLA", remaining: <percent>, weight: <grams left> }
// (see build_bambu_spools in poller/printer_status_poller.py).
//
// A slicer (Orca / Bambu Studio / PrusaSlicer) connected as an OctoPrint host
// can't read Bambu's native AMS over this connection, but it *can* read the
// OctoPrint filament plugins' HTTP APIs. So we expose the same loaded-filament
// data in the response shapes of the two common plugins — FilamentManager and
// SpoolManager — and advertise them via /api/settings so the slicer detects the
// capability. This is read-only and carries no connection secrets.

const FILAMENT_DIAMETER_MM = 1.75; // Bambu / Snapmaker U1 are all 1.75 mm.

function normalizeSpools(printer) {
  const spools = Array.isArray(printer?.spools) ? printer.spools : [];
  return spools
    .filter((spool) => spool && typeof spool === 'object')
    .map((spool, index) => {
      const remaining = Number.isFinite(spool.remaining) ? Math.max(0, Math.min(100, spool.remaining)) : 0;
      const remainingWeight = Number.isFinite(spool.weight) && spool.weight > 0 ? Math.round(spool.weight) : 0;
      // `weight` is grams remaining; back out the spool's full weight from the
      // remaining percentage when both are known (else fall back to remaining).
      const totalWeight = remaining > 0 && remainingWeight > 0
        ? Math.round((remainingWeight * 100) / remaining)
        : remainingWeight;
      const used = Math.max(0, totalWeight - remainingWeight);
      return {
        slotId: String(spool.id ?? `slot-${index}`),
        tool: index,
        material: typeof spool.material === 'string' && spool.material ? spool.material : 'Unknown',
        color: typeof spool.color === 'string' && spool.color ? spool.color : '#808080',
        remainingPercent: Math.round(remaining),
        remainingWeight,
        totalWeight,
        used,
      };
    });
}

function spoolDisplayName(spool) {
  return `${spool.material} (${spool.slotId})`;
}

// OctoPrint-FilamentManager response shapes (malnvenshorn/OctoPrint-FilamentManager).
export function buildFilamentManagerSpools(printer) {
  const spools = normalizeSpools(printer);
  return {
    spools: spools.map((spool, index) => ({
      id: index + 1,
      name: spoolDisplayName(spool),
      cost: 0,
      weight: spool.totalWeight,
      used: spool.used,
      temp_offset: 0,
      profile: {
        id: index + 1,
        material: spool.material,
        vendor: 'AMS',
        density: 1.24,
        diameter: FILAMENT_DIAMETER_MM,
      },
    })),
  };
}

export function buildFilamentManagerSelections(printer) {
  const { spools } = buildFilamentManagerSpools(printer);
  return {
    selections: spools.map((spool, index) => ({
      tool: index,
      spool,
    })),
  };
}

// OctoPrint-SpoolManager response shape (OllisGit/OctoPrint-SpoolManager).
export function buildSpoolManagerSpools(printer) {
  const spools = normalizeSpools(printer);
  const allSpools = spools.map((spool, index) => ({
    databaseId: index + 1,
    isActive: index === 0, // single nozzle: treat the first loaded slot as active
    isTemplate: false,
    displayName: spoolDisplayName(spool),
    vendor: 'AMS',
    material: spool.material,
    color: spool.color,
    colorName: spool.material,
    diameter: FILAMENT_DIAMETER_MM,
    density: 1.24,
    totalWeight: spool.totalWeight,
    remainingWeight: spool.remainingWeight,
    remainingPercentage: spool.remainingPercent,
    usedWeight: spool.used,
  }));
  return {
    totalItemCount: allSpools.length,
    allSpools,
    selectedSpools: allSpools.filter((spool) => spool.isActive),
  };
}

// Plugins block advertised in /api/settings so the slicer detects the filament
// APIs above. Mirrors the keys OctoPrint exposes when these plugins are present.
export const FILAMENT_PLUGIN_SETTINGS = {
  filamentmanager: { enabled: true },
  SpoolManager: { pluginIsEnabled: true },
};
