// OctoPrint device-state emulation.
//
// A slicer's "Device" page (Orca / PrusaSlicer, host type "OctoPrint") doesn't
// stop at GET /api/version — to show the printer as connected it polls the
// standard OctoPrint monitoring endpoints and issues a connect command:
//   GET  /api/connection  → connection state (must report "Operational")
//   POST /api/connection  → connect/disconnect command (firmware managed)
//   GET  /api/printer     → printer state flags + tool/bed temperatures
//   GET  /api/job         → current job + progress
// Without these the device page reports "cannot connect — check device page".
//
// We don't hold a serial link to the printer, so we synthesize OctoPrint's
// shapes from the poller's last-known state in our DB (status, temperatures,
// progress, currentJob). This is profile-independent: it works for the Snapmaker
// U1 (Moonraker) and the Bambu profiles alike.

// Map our PrinterStatus to OctoPrint's state text + flags. OctoPrint clients key
// the connection indicator off these flags (operational/printing/paused/error).
function octoState(status) {
  switch (status) {
    case 'printing':
      return {
        text: 'Printing',
        flags: { operational: true, printing: true, paused: false, error: false, ready: false, closedOrError: false },
      };
    case 'paused':
      return {
        text: 'Paused',
        flags: { operational: true, printing: false, paused: true, error: false, ready: true, closedOrError: false },
      };
    case 'error':
      return {
        text: 'Error',
        flags: { operational: false, printing: false, paused: false, error: true, ready: false, closedOrError: true },
      };
    case 'offline':
      return {
        text: 'Offline',
        flags: { operational: false, printing: false, paused: false, error: false, ready: false, closedOrError: true },
      };
    default: // 'idle'
      return {
        text: 'Operational',
        flags: { operational: true, printing: false, paused: false, error: false, ready: true, closedOrError: false },
      };
  }
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

// GET /api/connection — the connect indicator goes green when state is anything
// other than "Closed". We report the firmware's own state so an offline printer
// still surfaces as offline rather than a hard connection error.
export function buildConnection(printer) {
  const state = octoState(printer?.status);
  const current = state.flags.closedOrError && printer?.status === 'offline' ? 'Closed' : state.text;
  return {
    current: {
      state: current,
      port: 'VIRTUAL',
      baudrate: 250000,
      printerProfile: '_default',
    },
    options: {
      ports: ['VIRTUAL'],
      baudrates: [250000],
      printerProfiles: [{ id: '_default', name: printer?.name || 'Default' }],
      portPreference: 'VIRTUAL',
      baudratePreference: 250000,
      printerProfilePreference: '_default',
      autoconnect: true,
    },
  };
}

// GET /api/printer — state flags + tool0/bed temperatures. The slicer's device
// page reads `temperature.tool0.actual` and the state flags from here.
export function buildPrinterState(printer) {
  const state = octoState(printer?.status);
  const temp = printer?.temperature || {};
  const nozzleTargets = Array.isArray(printer?.nozzleTargets) ? printer.nozzleTargets : [];
  const temperature = {
    tool0: { actual: num(temp.nozzle), target: num(nozzleTargets[0]), offset: 0 },
    bed: { actual: num(temp.bed), target: num(printer?.bedTarget), offset: 0 },
  };
  if (Number.isFinite(temp.chamber) && temp.chamber > 0) {
    temperature.chamber = { actual: num(temp.chamber), target: num(printer?.chamberTarget), offset: 0 };
  }
  return { state, temperature };
}

// GET /api/job — current job name + progress, derived from currentJob. OctoPrint
// reports times in seconds; our job carries minutes, so convert.
export function buildJob(printer) {
  const job = printer?.currentJob || null;
  const isActive = printer?.status === 'printing' || printer?.status === 'paused';
  const completion = job && Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0;
  const printTime = job && Number.isFinite(job.printingTime) ? Math.round(job.printingTime * 60) : 0;
  const printTimeLeft = job && Number.isFinite(job.timeRemaining) ? Math.round(job.timeRemaining * 60) : 0;
  const estimatedSeconds = job && Number.isFinite(job.estimatedTime) ? Math.round(job.estimatedTime * 60) : 0;
  return {
    job: {
      file: { name: job?.filename || null, origin: 'local' },
      estimatedPrintTime: estimatedSeconds,
      filament: { tool0: { length: 0, volume: 0 } },
    },
    progress: {
      completion: isActive ? completion : null,
      printTime: isActive ? printTime : null,
      printTimeLeft: isActive ? printTimeLeft : null,
    },
    state: octoState(printer?.status).text,
  };
}
