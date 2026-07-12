// Thin HTTP client over the print farm's key-gated /api/v1 data API.
//
// The MCP server never touches Postgres — every tool is a fetch to /api/v1
// carrying the caller's printfarm_manage key. That inherits the data API's
// auth (401/403), audit trail (source='api'), and secret-redaction rules for
// free. See server/app.js handleDataApi.
//
// createApiClient is bound to a single { apiBase, apiKey } pair: for stdio the
// key comes from PRINTFARM_API_KEY; for HTTP a fresh client is built per
// request from the caller's Authorization/X-Api-Key header (key passthrough).

export function createApiClient({ apiBase, apiKey }) {
  const base = String(apiBase || '').replace(/\/+$/, '');

  async function request(method, path, { body, raw = false } = {}) {
    // Guard against `..` traversal: a path like "/api/v1/../../metrics" passes a
    // naive startsWith('/api/v1/') check but fetch normalizes it to "/metrics",
    // reaching internal-only web endpoints the mcp container talks to directly
    // (bypassing nginx). Legitimate /api/v1 paths never contain a `..` segment.
    if (/(^|\/)\.\.(\/|$)/.test(String(path))) {
      throw new Error(`path may not contain ".." segments: "${path}"`);
    }

    const headers = {
      'X-Api-Key': apiKey,
      Accept: raw ? '*/*' : 'application/json',
    };
    let payload;
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const resp = await fetch(base + path, { method, headers, body: payload });

    if (raw) {
      if (!resp.ok) throw await toError(resp, method, path);
      const ab = await resp.arrayBuffer();
      return {
        buffer: Buffer.from(ab),
        contentType: resp.headers.get('content-type') || 'application/octet-stream',
        size: Number(resp.headers.get('content-length')) || ab.byteLength,
      };
    }

    const text = await resp.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!resp.ok) throw errorFrom(resp, data);
    return data;
  }

  return { request, base };
}

function errorFrom(resp, data) {
  const detail =
    data && typeof data === 'object' && data.error
      ? data.error
      : typeof data === 'string' && data
        ? data
        : resp.statusText || 'request failed';
  const err = new Error(`HTTP ${resp.status}: ${detail}`);
  err.status = resp.status;
  return err;
}

async function toError(resp, method, path) {
  let detail = resp.statusText;
  try {
    const text = await resp.text();
    if (text) {
      try {
        detail = JSON.parse(text).error || text;
      } catch {
        detail = text;
      }
    }
  } catch {
    /* ignore */
  }
  const err = new Error(`HTTP ${resp.status}: ${detail} (${method} ${path})`);
  err.status = resp.status;
  return err;
}
