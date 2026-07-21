// Embedded MQTT broker + status publisher for the ESP32 per-printer status
// lights. The broker (aedes) is reachable two ways:
//   - raw MQTT/TCP on container port 1883 (published to the host by compose as
//     ${MQTT_PORT:-1883}:1883), for LAN devices;
//   - MQTT-over-WebSockets at /mqtt on the normal web port (proxied by nginx),
//     for deployments where only the HTTP(S) site is reachable (tunnels/CDN).
//
// Topic contract (see API.md "Status Lights"):
//   printfarm/printers/<printerId>/status   web → device, retained, plain string
//                                           printing|idle|paused|error|offline
//   printfarm/lights/<printerId>/availability device → web, retained, online/
//                                           offline; also the device's MQTT LWT
//
// Devices authenticate with one shared credential auto-generated into
// app_settings (status_light_broker_credential) and identify themselves with
// clientId "statuslight-<printerId>". Publish authorization is scoped to the
// client's own availability topic; the shared password makes clientIds
// spoofable, which is an accepted trade-off for the LAN/classroom scope
// (status strings carry no secrets). STATUS_LIGHT_MQTT_ENABLED=false disables
// the whole feature.
//
// Single-process only, like eventStream.js: the aedes instance, its retained-
// message store, and the connected-device map are all in-memory, matching the
// documented single-`web`-replica assumption. Retained statuses are rebuilt by
// the publisher's first pass after every restart.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { getAppSetting, setAppSetting, listPrinters } from './postgres.js';
import { logger } from './logger.js';

const CREDENTIAL_KEY = 'status_light_broker_credential';
const BROKER_USERNAME = 'statuslight';
const CLIENT_ID_PREFIX = 'statuslight-';
const WS_PATH = '/mqtt';
// The container/local listen port is fixed at 1883; MQTT_PORT is the *host*
// port compose publishes it on (what provisioned devices should dial).
const LISTEN_PORT = 1883;

const STATUS_TOPIC_RE = /^printfarm\/printers\/[^/#+]+\/status$/;
const STATUS_TOPIC_WILDCARD = 'printfarm/printers/+/status';
const AVAILABILITY_TOPIC_RE = /^printfarm\/lights\/([^/#+]+)\/availability$/;

const PUBLISH_INTERVAL_MS = Math.max(
  2000,
  Number.parseInt(process.env.STATUS_LIGHT_PUBLISH_INTERVAL_MS || '4000', 10) || 4000,
);

function statusTopic(printerId) {
  return `printfarm/printers/${printerId}/status`;
}

export function statusLightMqttEnabled() {
  return process.env.STATUS_LIGHT_MQTT_ENABLED !== 'false';
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

// One shared device credential, generated once and kept stable so
// re-provisioning a device months later still gets the same password.
let credentialPromise = null;
export function ensureBrokerCredential() {
  if (!credentialPromise) {
    credentialPromise = (async () => {
      const stored = await getAppSetting(CREDENTIAL_KEY);
      if (stored && typeof stored.password === 'string' && stored.password) {
        return { username: stored.username || BROKER_USERNAME, password: stored.password };
      }
      const credential = {
        username: BROKER_USERNAME,
        password: randomBytes(24).toString('hex'),
      };
      await setAppSetting(CREDENTIAL_KEY, credential);
      return credential;
    })().catch((err) => {
      credentialPromise = null; // let a later call retry after a DB blip
      throw err;
    });
  }
  return credentialPromise;
}

// Connected-light tracking for the UI: printerId → { connected, lastSeen }.
// Fed by broker connection events and by the retained availability topic
// (which also covers the LWT fired on an ungraceful drop).
const devices = new Map();

function printerIdFromClientId(clientId) {
  if (typeof clientId !== 'string' || !clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const printerId = clientId.slice(CLIENT_ID_PREFIX.length);
  return printerId || null;
}

function markDevice(printerId, connected) {
  devices.set(printerId, { connected, lastSeen: new Date().toISOString() });
}

export function getStatusLightDevices() {
  return [...devices.entries()].map(([printerId, state]) => ({
    printerId,
    connected: state.connected,
    lastSeen: state.lastSeen,
  }));
}

let broker = null;
let tcpServer = null;
let publisherTimer = null;
let publisherRunning = false;
// Last status published per printer, so a steady state publishes nothing.
const lastPublished = new Map();

export function publishPrinterStatus(printerId, status) {
  if (!broker) return;
  broker.publish(
    {
      topic: statusTopic(printerId),
      payload: Buffer.from(status ?? '', 'utf8'),
      qos: 0,
      retain: true,
    },
    () => {},
  );
}

// Mirrors the evaluateHaRules loop: re-read the DB on an interval and publish
// retained statuses only on change. The first pass after a (re)start publishes
// every printer, which also rebuilds aedes' in-memory retained store.
async function publishStatusPass() {
  if (publisherRunning) return;
  publisherRunning = true;
  try {
    const printers = await listPrinters();
    const seen = new Set();
    for (const printer of Array.isArray(printers) ? printers : []) {
      if (!printer || typeof printer.id !== 'string' || !printer.id) continue;
      seen.add(printer.id);
      const status = typeof printer.status === 'string' && printer.status ? printer.status : 'offline';
      if (lastPublished.get(printer.id) === status) continue;
      lastPublished.set(printer.id, status);
      publishPrinterStatus(printer.id, status);
    }
    // A deleted printer gets its retained status cleared (empty retained
    // payload) so an orphaned light stops showing a stale color.
    for (const printerId of [...lastPublished.keys()]) {
      if (!seen.has(printerId)) {
        lastPublished.delete(printerId);
        publishPrinterStatus(printerId, '');
      }
    }
  } catch (err) {
    logger.warn('status light publish pass failed', {
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    publisherRunning = false;
  }
}

export async function startStatusLightBroker({ httpServer } = {}) {
  if (!statusLightMqttEnabled()) {
    logger.info('status light broker disabled (STATUS_LIGHT_MQTT_ENABLED=false)');
    return;
  }
  if (broker) return;

  broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      ensureBrokerCredential()
        .then((credential) => {
          const presented = password == null ? '' : password.toString('utf8');
          const ok =
            timingSafeEqualString(username || '', credential.username) &&
            timingSafeEqualString(presented, credential.password);
          if (!ok) {
            const error = new Error('bad username or password');
            error.returnCode = 4; // MQTT CONNACK: bad user name or password
            logger.warn('status light broker auth rejected', { clientId: client && client.id });
            done(error, false);
            return;
          }
          done(null, true);
        })
        .catch((err) => done(err, false));
    },
    authorizeSubscribe: (client, sub, done) => {
      const topic = sub && sub.topic;
      if (topic === STATUS_TOPIC_WILDCARD || STATUS_TOPIC_RE.test(topic || '')) {
        done(null, sub);
        return;
      }
      done(new Error('subscription not allowed'));
    },
    authorizePublish: (client, packet, done) => {
      // In-process publishes (client == null) bypass this hook in aedes; every
      // external client may only publish its own availability topic.
      const match = AVAILABILITY_TOPIC_RE.exec(packet && packet.topic ? packet.topic : '');
      const ownId = client ? printerIdFromClientId(client.id) : null;
      if (match && ownId && match[1] === ownId) {
        done(null);
        return;
      }
      done(new Error('publish not allowed'));
    },
  });

  broker.on('client', (client) => {
    const printerId = printerIdFromClientId(client && client.id);
    if (printerId) markDevice(printerId, true);
    logger.info('status light client connected', { clientId: client && client.id });
  });
  broker.on('clientDisconnect', (client) => {
    const printerId = printerIdFromClientId(client && client.id);
    if (printerId) markDevice(printerId, false);
    logger.info('status light client disconnected', { clientId: client && client.id });
  });
  broker.on('publish', (packet, client) => {
    if (!client) return; // ignore our own status publishes
    const match = AVAILABILITY_TOPIC_RE.exec(packet.topic || '');
    if (match) {
      markDevice(match[1], packet.payload.toString('utf8') === 'online');
    }
  });
  broker.on('clientError', (client, err) => {
    logger.warn('status light client error', {
      clientId: client && client.id,
      error: err && err.message ? err.message : String(err),
    });
  });

  // Raw MQTT/TCP listener.
  tcpServer = net.createServer(broker.handle);
  tcpServer.on('error', (err) => {
    logger.error('status light broker tcp listener failed', {
      error: err && err.message ? err.message : String(err),
    });
  });
  tcpServer.listen(LISTEN_PORT, '0.0.0.0', () => {
    logger.info('status light broker listening', { port: LISTEN_PORT, wsPath: WS_PATH });
  });

  // MQTT-over-WebSockets on the existing web HTTP server at /mqtt. No other
  // upgrade consumers exist today, so non-/mqtt upgrades are dropped.
  if (httpServer) {
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
    });
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        // fall through to destroy
      }
      if (pathname !== WS_PATH || !broker) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        broker.handle(createWebSocketStream(ws));
      });
    });
  }

  // Pre-warm the credential so the first device connect doesn't race schema
  // creation, then start the change-driven publisher.
  ensureBrokerCredential().catch((err) => {
    logger.warn('status light credential init failed (will retry on demand)', {
      error: err && err.message ? err.message : String(err),
    });
  });
  publisherTimer = setInterval(() => {
    publishStatusPass().catch(() => {});
  }, PUBLISH_INTERVAL_MS);
  if (typeof publisherTimer.unref === 'function') publisherTimer.unref();
  publishStatusPass().catch(() => {});
}
