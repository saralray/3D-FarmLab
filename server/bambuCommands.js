// Bambu MQTT command builder + short-lived publish-only sender. Extracted from
// app.js so filamentStation.js can call sendBambuCommand('set_filament', ...)
// (the ams_filament_setting override, plan §2a) without a circular import —
// filamentStation.js is imported *by* app.js, so it can't import back from it.
// Pure code motion: no behavior change to the existing /command endpoint,
// which now imports sendBambuCommand from here instead of defining it inline.

import mqtt from 'mqtt';
import { logger } from './logger.js';

// Duplicated from app.js's own BAMBU_PROFILES (app.js:143) rather than
// exported from there — app.js imports filamentStation.js, which imports
// this module, so app.js can't be imported back from here without a cycle.
// Small, stable set; not worth a larger refactor to de-duplicate.
export const BAMBU_PROFILES = new Set(['bambulab_a1_mini', 'bambulab_h2s', 'bambulab_h2d', 'bambulab_h2c']);

// Bambu printers have no HTTP control API; pause/resume/cancel and the chamber
// light are MQTT commands published to device/<serial>/request. We open a
// short-lived publish-only connection (no subscribe), which coexists with the
// poller's connection.
const BAMBU_PRINT_ACTIONS = { pause: 'pause', resume: 'resume', cancel: 'stop' };

// Generic Bambu filament presets keyed by material type. `idx` is Bambu's
// tray_info_idx code (the generic profile for each material); `min`/`max` are
// the nozzle temperature window. Used by the ams_filament_setting command when
// staff edit a tray's material. Codes/temps may need per-model tuning.
const BAMBU_FILAMENT_PRESETS = {
  PLA: { idx: 'GFL99', type: 'PLA', min: 190, max: 230 },
  PETG: { idx: 'GFG99', type: 'PETG', min: 230, max: 260 },
  ABS: { idx: 'GFB99', type: 'ABS', min: 240, max: 270 },
  ASA: { idx: 'GFB98', type: 'ASA', min: 240, max: 270 },
  TPU: { idx: 'GFU99', type: 'TPU', min: 200, max: 240 },
  PC: { idx: 'GFC99', type: 'PC', min: 260, max: 280 },
  PA: { idx: 'GFN99', type: 'PA', min: 260, max: 290 },
  PVA: { idx: 'GFS99', type: 'PVA', min: 190, max: 220 },
};

// Map a heater target to the M-code Bambu accepts over `gcode_line`.
function buildBambuTemperatureGcode(heater, target, nozzleIndex = 0) {
  const value = Math.round(Number(target));
  if (!Number.isFinite(value) || value < 0 || value > 350) {
    throw new Error('Temperature target is out of range');
  }
  if (heater === 'nozzle') {
    const tool = Number(nozzleIndex) > 0 ? ` T${Number(nozzleIndex)}` : '';
    return `M104${tool} S${value}\n`;
  }
  if (heater === 'bed') {
    return `M140 S${value}\n`;
  }
  if (heater === 'chamber') {
    // The H2 chamber heater is driven by M141; a valid target is 0–60 °C
    // (0 turns active chamber heating off).
    if (value > 60) {
      throw new Error('Chamber temperature target is out of range');
    }
    return `M141 S${value}\n`;
  }
  throw new Error(`Unsupported heater: ${heater}`);
}

// Motion control posts raw G-code, but only a safe motion subset is honored
// over this endpoint — never heater or firmware-config commands, so a stray or
// hostile request can't drive the hotend or flash the board.
const ALLOWED_MOTION_GCODE = /^(?:G0|G1|G28|G90|G91|M84|M18)\b/i;

function sanitizeMotionGcode(gcode) {
  if (typeof gcode !== 'string') {
    throw new Error('gcode must be a string');
  }
  const lines = gcode
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 8) {
    throw new Error('gcode must contain between 1 and 8 commands');
  }
  for (const line of lines) {
    if (!ALLOWED_MOTION_GCODE.test(line)) {
      throw new Error(`Disallowed motion command: ${line}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// One `system` ledctrl message for a single LED node.
function buildBambuLedPayload(node, on, sequenceId) {
  return {
    system: {
      sequence_id: sequenceId,
      command: 'ledctrl',
      led_node: node,
      led_mode: on ? 'on' : 'off',
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 0,
      interval_time: 0,
    },
  };
}

// The H2 series lights its chamber with two LED bars, each its own ledctrl node,
// so one toggle has to drive both. Other Bambu models only expose chamber_light.
const BAMBU_LIGHT_NODES = {
  bambulab_h2s: ['chamber_light', 'chamber_light2'],
  bambulab_h2d: ['chamber_light', 'chamber_light2'],
  bambulab_h2c: ['chamber_light', 'chamber_light2'],
};

function bambuLightNodes(profile) {
  return BAMBU_LIGHT_NODES[profile] ?? ['chamber_light'];
}

// Print actions go under `print`; the chamber light is a `system` ledctrl
// message. Light commands may return several payloads (one per LED node).
export function buildBambuCommandPayload(command, params = {}, profile) {
  const sequenceId = String(Date.now() % 1000000);

  if (command === 'light_on' || command === 'light_off') {
    const on = command === 'light_on';
    return bambuLightNodes(profile).map((node, index) =>
      // Distinct sequence ids so the printer doesn't dedupe the second message.
      buildBambuLedPayload(node, on, String((Date.now() + index) % 1000000)),
    );
  }

  if (command === 'set_temperature') {
    return {
      print: {
        command: 'gcode_line',
        param: buildBambuTemperatureGcode(params.heater, params.target, params.nozzleIndex),
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'gcode') {
    return {
      print: {
        command: 'gcode_line',
        param: sanitizeMotionGcode(params.gcode),
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'set_fan') {
    // Bambu addresses its fans by M106 P-index: P1 part cooling, P2 auxiliary,
    // P3 chamber. Speed is an 8-bit PWM value (0 = off).
    const port = Number(params.fanPort);
    const speed = Math.round(Number(params.speed));
    if (!Number.isInteger(port) || port < 1 || port > 3) {
      throw new Error('Fan port is out of range');
    }
    if (!Number.isFinite(speed) || speed < 0 || speed > 255) {
      throw new Error('Fan speed is out of range');
    }
    return {
      print: {
        command: 'gcode_line',
        param: `M106 P${port} S${speed}\n`,
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'set_airduct') {
    // The H2 series routes chamber air through a mode-based "air duct" system
    // rather than an individually-addressable filter fan, so the activated-carbon
    // filter is engaged by selecting a mode, not by spinning a fan. Bambu Studio
    // sets it with a `set_airduct` MQTT command. Modes (from BambuStudio's
    // AIR_DUCT enum): 0 cooling+filter, 1 heating+filter, 2 exhaust, 3 full
    // cooling. `submode` defaults to -1, matching Studio.
    const modeId = Number(params.modeId);
    if (!Number.isInteger(modeId) || modeId < 0 || modeId > 3) {
      throw new Error('Air duct mode is out of range');
    }
    const submode = params.submode === undefined ? -1 : Number(params.submode);
    if (!Number.isInteger(submode)) {
      throw new Error('Air duct submode must be an integer');
    }
    return {
      print: {
        command: 'set_airduct',
        modeId,
        submode,
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'load_filament' || command === 'unload_filament') {
    // ams_change_filament: `target` is the global tray id (AMS unit * 4 + tray,
    // or 254 for the external spool). 255 tells the printer to unload whatever
    // is currently loaded. `tar_temp` preheats the hotend for the swap; the
    // printer applies its own filament profile when handed 0.
    const isUnload = command === 'unload_filament';
    const target = isUnload ? 255 : Number(params.trayId);
    if (!Number.isFinite(target) || target < 0 || target > 255) {
      throw new Error('Filament tray target is out of range');
    }
    const tarTemp = isUnload ? 0 : Math.round(Number(params.target) || 220);
    return {
      print: {
        command: 'ams_change_filament',
        target,
        curr_temp: 0,
        tar_temp: tarTemp,
        sequence_id: sequenceId,
      },
    };
  }

  if (command === 'set_filament') {
    // ams_filament_setting: change the material/color the printer thinks is in a
    // tray. `trayId` is the global tray id (AMS unit * 4 + tray, or 254 for the
    // external spool). Bambu splits it into ams_id (the unit) and tray_id (0-3
    // within the unit); the external spool uses ams_id 255 / tray_id 254.
    // `tray_info_idx` is Bambu's filament code (e.g. generic PLA = GFL99) and
    // `tray_color` is RRGGBBAA. These codes/temps are device-specific and may
    // need live tuning per printer model.
    const target = Number(params.trayId);
    if (!Number.isFinite(target) || target < 0 || target > 255) {
      throw new Error('Filament tray target is out of range');
    }
    const isExternal = target === 254;
    const amsId = isExternal ? 255 : Math.floor(target / 4);
    const trayId = isExternal ? 254 : target % 4;
    const type = String(params.type || '').toUpperCase().trim();
    const preset = BAMBU_FILAMENT_PRESETS[type] || BAMBU_FILAMENT_PRESETS.PLA;
    const color = String(params.color || '#808080').replace('#', '').slice(0, 6).toUpperCase();
    const trayColor = `${color.padEnd(6, '0')}FF`;
    // Optional brand/vendor label. Bambu stores it as the tray's filament setting
    // name (`tray_id_name`) and reports it back, so the card's vendor round-trips.
    // Kept short and free of control chars; empty string leaves it unset.
    const vendor = String(params.vendor || '')
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
      .slice(0, 32);
    return {
      print: {
        command: 'ams_filament_setting',
        ams_id: amsId,
        tray_id: trayId,
        tray_info_idx: preset.idx,
        tray_color: trayColor,
        nozzle_temp_min: preset.min,
        nozzle_temp_max: preset.max,
        tray_type: preset.type,
        tray_id_name: vendor,
        setting_id: '',
        sequence_id: sequenceId,
      },
    };
  }

  const action = BAMBU_PRINT_ACTIONS[command];
  if (!action) {
    throw new Error(`Unsupported command: ${command}`);
  }
  const printCommand = { command: action, sequence_id: sequenceId };
  if (action === 'stop') {
    printCommand.param = '';
  }
  return { print: printCommand };
}

export function sendBambuCommand(printer, command, params) {
  // A command may expand to several MQTT messages (e.g. one per LED node).
  const payloads = [].concat(buildBambuCommandPayload(command, params, printer.profile));
  const serial = (printer.serial || '').trim();
  if (!serial) {
    throw new Error('Bambu printer is missing its serial number');
  }

  if (command === 'load_filament' || command === 'unload_filament' || command === 'set_filament') {
    // Publishing is QoS 0 with no ack from the printer, so a successful publish
    // here does not prove the firmware applied it. Logging the exact payload
    // lets it be diffed against a packet capture of Bambu Studio's own command
    // for the same tray, which is the only way to spot a profile-specific field
    // mismatch (e.g. H2-series AMS/nozzle addressing).
    logger.debug('bambu filament command', {
      printerId: printer.id,
      profile: printer.profile,
      command,
      params,
      payloads,
    });
  }

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${printer.ipAddress}:8883`, {
      username: 'bblp',
      password: (printer.apiKeyHeader || '').trim(),
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 4000,
    });

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('MQTT command timed out')), 6000);

    client.once('error', fail);
    client.once('connect', () => {
      // QoS 0 (the printer's broker isn't guaranteed to PUBACK on this topic, and
      // the poller already proves request-topic commands are honored). The fix for
      // the original dropped command is the graceful close below, not the QoS.
      const topic = `device/${serial}/request`;
      let remaining = payloads.length;
      let firstError = null;
      payloads.forEach((payload) => {
        client.publish(topic, JSON.stringify(payload), { qos: 0 }, (error) => {
          if (error && !firstError) firstError = error;
          remaining -= 1;
          if (remaining > 0 || settled) return;
          if (firstError) return fail(firstError);
          settled = true;
          clearTimeout(timer);
          // Close gracefully so the queued packets are flushed to the socket
          // before it closes — a force close here can drop commands in transit.
          client.end(false, {}, () => resolve());
        });
      });
    });
  });
}
