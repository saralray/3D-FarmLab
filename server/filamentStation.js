// Filament Station: local spool inventory, identified via a phone-written NFC
// tag (Android Web NFC / iOS Core NFC — no headless station daemon; a phone
// with a live session does read → encode → write → confirm in one
// synchronous interaction) or a genuine Bambu RFID tag the AMS itself already
// read. Routed from handleDataApi in app.js under /api/v1/filament-station/*
// (see DATA_API_RESOURCES + the 'filament-station' switch case there) and
// from the cookie-session /api/filament-station/* case in handleApi — this
// module owns everything past either prefix.

import {
  createFilamentSpool,
  deleteFilamentSpool,
  deleteFilamentStationAssignment,
  findFilamentSpoolByTag,
  getFilamentSpool,
  getPrinterById,
  listFilamentSpools,
  listFilamentStationAssignments,
  setFilamentSpoolTagUid,
  updateFilamentSpool,
  upsertFilamentStationAssignment,
} from './postgres.js';
import { broadcastFilamentStationEvent } from './eventStream.js';
import { buildOpenSpoolPayload } from './openspoolTag.js';
import { logger } from './logger.js';
import { BAMBU_PROFILES, sendBambuCommand } from './bambuCommands.js';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
}

function dataApiMethodNotAllowed(res) {
  sendJson(res, 405, { error: 'Method not allowed for this resource.' });
  return true;
}

// ── NFC: scan-to-identify, write-payload, link-tag ──────────────────────────
//
// No device/queue concept — a phone (Android Web NFC or iOS Core NFC) does
// the whole cycle itself: scan a tag to identify a spool (tag-scanned),
// fetch the JSON payload for a chosen spool and write it directly with the
// phone's own NFC radio (openspool-payload), then tell the server which
// physical tag now holds that spool (link-tag).

async function handleNfc(req, res, { method, segments }) {
  const [action] = segments;

  if (action === 'tag-scanned' && method === 'POST') {
    const body = await readJsonBody(req);
    const spool = await findFilamentSpoolByTag({ tagUid: body.tag_uid, trayUuid: body.tray_uuid });
    if (spool) {
      broadcastFilamentStationEvent('filament-station-tag-matched', {
        tagUid: body.tag_uid,
        trayUuid: body.tray_uuid,
        spool,
      });
      return sendJson(res, 200, { status: 'ok', matched: true, spool_id: spool.id });
    }
    broadcastFilamentStationEvent('filament-station-unknown-tag', {
      tagUid: body.tag_uid,
      trayUuid: body.tray_uuid,
    });
    return sendJson(res, 200, { status: 'ok', matched: false, spool_id: null });
  }

  if (action === 'link-tag' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.spool_id || !body.tag_uid) {
      return sendJson(res, 400, { error: 'spool_id and tag_uid are required' });
    }
    const spool = await setFilamentSpoolTagUid(body.spool_id, String(body.tag_uid).toUpperCase());
    if (!spool) return sendJson(res, 404, { error: 'Spool not found' });
    logger.info(`Tag ${body.tag_uid} linked to spool ${spool.id}`);
    broadcastFilamentStationEvent('filament-station-tag-written', {
      spoolId: spool.id,
      tagUid: body.tag_uid,
    });
    return sendJson(res, 200, { status: 'ok', spool });
  }

  return sendJson(res, 404, { error: `Unknown nfc action '${action}'` });
}

// ── Spools CRUD ──────────────────────────────────────────────────────────────

async function handleSpools(req, res, { method, segments }) {
  const [id, sub] = segments;

  if (!id) {
    if (method === 'GET') {
      const spools = await listFilamentSpools();
      return sendJson(res, 200, spools);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.material) {
        return sendJson(res, 400, { error: 'material is required' });
      }
      const spool = await createFilamentSpool({
        material: body.material,
        subtype: body.subtype,
        colorName: body.color_name,
        rgba: body.rgba,
        brand: body.brand,
        labelWeight: body.label_weight,
        coreWeight: body.core_weight,
        nozzleTempMin: body.nozzle_temp_min,
        nozzleTempMax: body.nozzle_temp_max,
        dataOrigin: 'manual',
      });
      return sendJson(res, 200, spool);
    }
    return dataApiMethodNotAllowed(res);
  }

  if (sub === 'openspool-payload') {
    if (method !== 'GET') return dataApiMethodNotAllowed(res);
    const spool = await getFilamentSpool(id);
    if (!spool) return sendJson(res, 404, { error: 'Spool not found' });
    return sendJson(res, 200, buildOpenSpoolPayload(spool));
  }

  if (method === 'GET') {
    const spool = await getFilamentSpool(id);
    if (!spool) return sendJson(res, 404, { error: 'Spool not found' });
    return sendJson(res, 200, spool);
  }
  if (method === 'PUT') {
    const body = await readJsonBody(req);
    const spool = await updateFilamentSpool(id, {
      material: body.material,
      subtype: body.subtype,
      colorName: body.color_name,
      rgba: body.rgba,
      brand: body.brand,
      labelWeight: body.label_weight,
      coreWeight: body.core_weight,
      weightUsed: body.weight_used,
      nozzleTempMin: body.nozzle_temp_min,
      nozzleTempMax: body.nozzle_temp_max,
      archived: body.archived,
    });
    if (!spool) return sendJson(res, 404, { error: 'Spool not found' });
    return sendJson(res, 200, spool);
  }
  if (method === 'DELETE') {
    await deleteFilamentSpool(id);
    return sendJson(res, 200, { status: 'deleted', id });
  }
  return dataApiMethodNotAllowed(res);
}

// ── Assignments CRUD + Bambu MQTT override ──────────────────────────────────

async function handleAssignments(req, res, { method, segments }) {
  const [printerId, amsId, trayId] = segments;

  if (!printerId) {
    if (method === 'GET') {
      const assignments = await listFilamentStationAssignments();
      return sendJson(res, 200, assignments);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.spool_id || !body.printer_id || body.tray_id === undefined) {
        return sendJson(res, 400, { error: 'spool_id, printer_id, tray_id are required' });
      }
      const printer = await getPrinterById(body.printer_id);
      if (!printer) return sendJson(res, 404, { error: 'Printer not found' });
      const spool = await getFilamentSpool(body.spool_id);
      if (!spool) return sendJson(res, 404, { error: 'Spool not found' });

      const amsId = body.ams_id ?? 0;
      const pendingConfig = body.pending_config ?? true;
      const assignment = await upsertFilamentStationAssignment({
        spoolId: body.spool_id,
        printerId: body.printer_id,
        amsId,
        trayId: body.tray_id,
        // pending_config: true when the slot is empty at assign time — the
        // firmware drops ams_filament_setting on an empty slot, so nothing is
        // pushed now; the deferred-replay worker (assignments.go + the Node
        // replay worker in app.js) applies it once telemetry shows the slot loaded.
        pendingConfig,
      });

      // Immediate-apply override for an already-loaded Bambu slot — reuses
      // the exact ams_filament_setting command Bambu already has
      // (server/bambuCommands.js, extracted from the /command endpoint).
      // Snapmaker gets no push here: its primary recognition path is the
      // OpenSpool tag written directly onto the spool, read by the
      // printer's own OpenRFID reader (see the plan's Android/iOS NFC path).
      let mqttWarning = null;
      if (!pendingConfig && BAMBU_PROFILES.has(printer.profile)) {
        const globalTrayId = amsId === 255 ? 254 : amsId * 4 + Number(body.tray_id);
        try {
          await sendBambuCommand(printer, 'set_filament', {
            trayId: globalTrayId,
            type: spool.material,
            color: spool.rgba,
            vendor: spool.brand,
          });
        } catch (error) {
          logger.warn(`Bambu filament override failed for printer ${printer.id}: ${error.message}`);
          mqttWarning = error.message;
        }
      }

      broadcastFilamentStationEvent('filament-station-assignment-created', assignment);
      const result = { ...assignment };
      if (mqttWarning) result.mqtt_warning = mqttWarning;
      return sendJson(res, 200, result);
    }
    return dataApiMethodNotAllowed(res);
  }

  if (method === 'DELETE') {
    await deleteFilamentStationAssignment(printerId, Number(amsId), Number(trayId));
    return sendJson(res, 200, { status: 'deleted' });
  }
  return dataApiMethodNotAllowed(res);
}

// ── Entry point, dispatched from handleDataApi's 'filament-station' case ────
// (and the equivalent cookie-session case in handleApi, server/app.js)

export async function handleFilamentStation(req, res, { method, segments }) {
  const [entity, ...rest] = segments;

  if (!entity) {
    sendJson(res, 200, { resources: ['nfc', 'spools', 'assignments'] });
    return true;
  }

  switch (entity) {
    case 'nfc':
      await handleNfc(req, res, { method, segments: rest });
      return true;
    case 'spools':
      await handleSpools(req, res, { method, segments: rest });
      return true;
    case 'assignments':
      await handleAssignments(req, res, { method, segments: rest });
      return true;
    default:
      sendJson(res, 404, { error: `Unknown filament-station resource '${entity}'` });
      return true;
  }
}
