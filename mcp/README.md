# MCP server (`mcp` service)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that
exposes the print farm's `/api/v1` data API as tools, so an LLM client (Claude
Desktop, Claude Code, etc.) can monitor and control the farm in natural
language.

It holds no state and never touches Postgres — every tool is an HTTP call to
`/api/v1` carrying the caller's API key. That means it inherits the data API's
authentication (`printfarm_manage` scope), audit trail (`source='api'`), and
connection-secret redaction rules for free. See `server/app.js` `handleDataApi`.

## Authentication

Every request needs an API key with the **`printfarm_manage`** permission scope.
Mint one in the dashboard under **Settings → API Keys** (or
`POST /api/v1/slicer-keys` with `permissions: ["printfarm_manage"]`). The
plaintext key is shown once — copy it then.

- **HTTP transport:** the client sends its own key on the `initialize` request
  (`Authorization: Bearer <key>` or `X-Api-Key`). The key is bound to that MCP
  session, so audit-log entries are attributed to that key (`api:<key name>`).
- **stdio transport:** a single key from the `PRINTFARM_API_KEY` env var is used
  for every call.

A missing/invalid key surfaces the data API's `401`; a key without
`printfarm_manage` surfaces its `403`.

## Transports

The same code runs two ways, chosen by `MCP_TRANSPORT`:

| Mode | `MCP_TRANSPORT` | Endpoint | Auth |
|------|-----------------|----------|------|
| Remote (default) | `http` | `https://<domain>/mcp` (Streamable HTTP via nginx → `mcp:8092`) | per-request key header |
| Local | `stdio` | launched by the client over stdio | `PRINTFARM_API_KEY` env |

### Remote (Streamable HTTP)

The `mcp` Compose service runs with `MCP_TRANSPORT=http` and is reached through
nginx at `/mcp`. Point an MCP client that supports Streamable HTTP at:

```
URL:    https://<your-domain>/mcp
Header: Authorization: Bearer <printfarm_manage key>
```

### Local (stdio) — e.g. Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "printfarm": {
      "command": "node",
      "args": ["/absolute/path/to/repo/mcp/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "PRINTFARM_API_BASE": "https://<your-domain>",
        "PRINTFARM_API_KEY": "<printfarm_manage key>"
      }
    }
  }
}
```

`PRINTFARM_API_BASE` should point at wherever `/api/v1` is reachable — the public
HTTPS URL for a remote farm, or `http://localhost:8080` against a local
`docker compose up`.

## Tools

Curated tools cover the high-frequency surfaces; the rarer admin verbs go
through one escape-hatch. Tools that delete/reset state or can return secrets are
annotated `destructiveHint` so clients prompt for confirmation.

| Group | Tools |
|-------|-------|
| Printers | `list_printers`, `get_printer`, `upsert_printer`, `delete_printer`, `printer_command` (Bambu MQTT: pause/resume/cancel/temps/light), `printer_proxy` (raw Moonraker/hardware passthrough), `get_camera_snapshot` (returns an image), `get_camera_health` |
| Queue | `list_queue`, `upsert_queue_jobs`, `mark_job_printed`, `delete_job`, `reset_queue`, `get_job_file` (metadata) |
| Analytics | `get_analytics`, `reset_analytics` |
| Maintenance | `list_maintenance`, `maintenance_summary`, `get_printer_maintenance`, `complete_maintenance` |
| Notifications | `list_notifications`, `create_notification`, `delete_notification` |
| Status lights | `list_status_light_devices`, `get_printer_status` |
| Admin escape-hatch | `printfarm_admin_request` — raw request to any `/api/v1` path (slicer-keys, users, admin-credential, manager-requests, settings, audit-logs, queue export/import, filament-station). Can return one-time secrets and reset credentials — confirm before destructive calls. |

## Development / testing

Point [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at
either transport:

```bash
# stdio
MCP_TRANSPORT=stdio PRINTFARM_API_KEY=<key> PRINTFARM_API_BASE=https://<domain> \
  npx @modelcontextprotocol/inspector node mcp/index.js

# http (against a running compose stack)
docker compose up --build mcp nginx
#   then connect Inspector (Streamable HTTP) to http://localhost:8080/mcp
#   with header Authorization: Bearer <key>
```

## Notes / caveats

- HTTP sessions are held in memory in a single process — run **one** `mcp`
  replica (same caveat as `server/eventStream.js`).
- The server adds no new `/api/*` routes; it only consumes existing `/api/v1`
  ones, so `API.md` is unaffected.
