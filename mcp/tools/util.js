// Shared helpers for MCP tool registration.

// Wrap a JSON-serializable result as MCP text content.
export function asText(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Register a tool with uniform error handling: any thrown error (including a
// 401/403 from /api/v1) is surfaced to the client as an isError result rather
// than crashing the transport.
export function tool(server, name, definition, handler) {
  server.registerTool(name, definition, async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });
}

// Build a querystring from a plain object, skipping undefined/null/'' values.
export function query(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}
