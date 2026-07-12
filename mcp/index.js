// MCP server for the print farm.
//
// Wraps the key-gated /api/v1 data API as Model Context Protocol tools so an LLM
// client (Claude Desktop / Claude Code, etc.) can monitor and control the farm.
// It holds no state and never touches Postgres — every tool is a fetch to
// /api/v1 (see apiClient.js), inheriting that API's auth, audit and redaction.
//
// One codebase, two transports (MCP_TRANSPORT):
//   - stdio: launched by a local MCP client; the single API key is PRINTFARM_API_KEY.
//   - http : Streamable HTTP behind nginx /mcp; the caller supplies their own
//            printfarm_manage key (Authorization: Bearer / X-Api-Key) on the
//            initialize request. The key is bound to that MCP session and used
//            for every /api/v1 call it makes, so audit attribution stays per-user.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const transport = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
const apiBase = process.env.PRINTFARM_API_BASE || 'http://web:5173';

if (transport === 'stdio') {
  await startStdio();
} else {
  startHttp();
}

async function startStdio() {
  const apiKey = process.env.PRINTFARM_API_KEY || '';
  if (!apiKey) {
    console.error('[printfarm-mcp] PRINTFARM_API_KEY is required for stdio transport');
    process.exit(1);
  }
  const server = createMcpServer({ apiBase, apiKey });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; logs must go to stderr.
  console.error(`[printfarm-mcp] ${SERVER_NAME} v${SERVER_VERSION} stdio ready (api ${apiBase})`);
}

function startHttp() {
  const port = Number.parseInt(process.env.MCP_PORT || '8092', 10);
  const host = process.env.HOST || '0.0.0.0';

  // Session id -> { transport, server }. In-memory and single-process — run one
  // mcp replica (same caveat as eventStream.js / statusLightPresence.js).
  const sessions = new Map();

  const server = createServer((req, res) => {
    handleHttp(req, res, sessions).catch((error) => {
      console.error('[printfarm-mcp]', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonRpcError(null, -32603, 'Internal server error'));
      } else {
        res.end();
      }
    });
  });

  server.listen(port, host, () => {
    console.error(
      `[printfarm-mcp] ${SERVER_NAME} v${SERVER_VERSION} http listening on http://${host}:${port} (api ${apiBase})`,
    );
  });
}

async function handleHttp(req, res, sessions) {
  const url = new URL(req.url || '/', 'http://localhost');

  // Cheap liveness probe (not part of the MCP protocol).
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname.endsWith('/healthz'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION }));
    return;
  }

  const sessionId = header(req, 'mcp-session-id');

  // Established-session request (POST follow-ups, GET SSE stream, DELETE teardown).
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(jsonRpcError(null, -32001, 'Unknown or expired MCP session.'));
      return;
    }
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await entry.transport.handleRequest(req, res, body);
    return;
  }

  // No session id: only a POST carrying an `initialize` request may open one.
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(jsonRpcError(null, -32000, 'Method not allowed without an MCP session. POST initialize first.'));
    return;
  }

  const body = await readJsonBody(req);
  if (!isInitializeRequest(body)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonRpcError(null, -32000, 'Missing mcp-session-id; the first request must be initialize.'));
    return;
  }

  // Opening a session: the caller's key is captured here and bound to it.
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(
      jsonRpcError(
        null,
        -32001,
        'A valid printfarm_manage API key is required (Authorization: Bearer <key> or X-Api-Key header).',
      ),
    );
    return;
  }

  const mcp = createMcpServer({ apiBase, apiKey });
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport: httpTransport, server: mcp });
    },
  });
  httpTransport.onclose = () => {
    const sid = httpTransport.sessionId;
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      mcp.close().catch(() => {});
    }
  };

  await mcp.connect(httpTransport);
  await httpTransport.handleRequest(req, res, body);
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : typeof v === 'string' ? v : '';
}

function extractApiKey(req) {
  const headerKey = header(req, 'x-api-key');
  if (headerKey && headerKey.trim()) return headerKey.trim();
  const auth = header(req, 'authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = 4 * 1024 * 1024; // MCP payloads are small; cap to avoid abuse.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}
