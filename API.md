# STEM Lab Print Farm — Data API (`/api/v1`)

A versioned, API-key-gated HTTP API over the print farm's data. It is served by
the `web` service (`handleDataApi` in `server/app.js`) and is **entirely
separate** from the cookieless frontend `/api/*` endpoints the dashboard uses —
those stay unauthenticated and unchanged. This `/api/v1` namespace is for
external integrations, scripts, and dashboards.

The goal is **full UI/API parity**: every action available in the dashboard can
be driven through `/api/v1`, so an external print-farm manager (Portainer-style)
can run the whole farm headlessly — manage printers and their hardware, the
queue (including host→host migration), analytics, notifications, API keys, staff
users, the admin password, and all settings.

- **Base URL:** `http://<host>:<HTTP_PORT>/api/v1` (default port `8080`, served
  through nginx)
- **Format:** JSON request and response bodies (`Content-Type: application/json`)
- **Auth:** required on every request (see below)

---

## Authentication

Every request must present a valid API key. Keys are the **same named keys**
minted in **Settings → API Keys** (stored in `slicer_api_keys` as a sha256 hash;
the plaintext is shown only once at creation).

Pass the key either way:

```http
X-Api-Key: <your-key>
```
```http
Authorization: Bearer <your-key>
```

- Each key carries a **permissions scope** array. Reaching this API requires the
  **`printfarm_manage`** scope; a key with only `slicer_upload` is rejected with
  **`403 Forbidden`**. (Legacy keys minted before scopes existed backfill to
  both scopes, so they keep working.)
- A key with `printfarm_manage` grants **full read/write** to every resource —
  it can even reset the admin password and create admin users. Treat it as a
  superuser credential.
- Each request stamps the key's `last_used_at`.
- Every **mutation** (POST/PUT/DELETE) is recorded in the audit log with
  `source: "api"` and actor `api:<key name>`.
- A missing or invalid key returns **`401 Unauthorized`**; a valid key lacking
  the scope returns **`403 Forbidden`**.

> ⚠️ A `printfarm_manage` key is effectively full admin. Scope keys narrowly
> (mint `slicer_upload`-only keys for slicers) and revoke unused ones.

### Example

```bash
curl -H "X-Api-Key: $KEY" http://localhost:8080/api/v1/printers
```

---

## Conventions

| Status | Meaning |
|--------|---------|
| `200`  | OK, body returned |
| `201`  | Created |
| `204`  | OK, no body |
| `400`  | Bad request (missing/invalid fields) |
| `401`  | Missing or invalid API key |
| `403`  | Valid key, but it lacks the `printfarm_manage` scope |
| `404`  | Unknown resource or record |
| `405`  | Method not allowed for that path |
| `500`  | Server / database error |

Connection details (IP, API key header, serial) **are** returned by this API —
the key is the guard, so unlike the public-viewer mode nothing is redacted.

---

## Discovery

### `GET /api/v1`
Lists the available resources.

```json
{
  "version": "v1",
  "resources": ["printers", "queue", "analytics", "notifications", "slicer-keys", "audit-logs", "settings", "users", "admin-credential"]
}
```

---

## Resources

### Printers — `/api/v1/printers`

| Method & path | Description |
|---------------|-------------|
| `GET /printers` | List all printers (full detail). |
| `GET /printers/:id` | Fetch one printer; `404` if not found. |
| `POST /printers` | Create or update a printer. Body must include `id`. Returns the saved record. |
| `DELETE /printers/:id` | Delete a printer. |
| `POST /printers/:id/command` | Send a **Bambu** MQTT command (pause/resume/cancel, temps, fans, etc.). |
| `ANY /printers/:id/proxy/<path…>` | Raw HTTP passthrough to the printer's hardware API (e.g. Moonraker on a Snapmaker U1) — for **non-Bambu** control parity. |
| `GET /printers/:id/camera/snapshot` | A single JPEG frame from the printer's webcam. |
| `GET /printers/:id/camera/stream` | Live MJPEG stream where supported, else a single JPEG. |
| `GET /printers/:id/camera/health` | Live-view supervisor status (frame freshness, viewers, restarts). |

**Upsert body (example):**
```json
{
  "id": "printer-1",
  "name": "Bambu A1 #1",
  "model": "A1 Mini",
  "profile": "bambulab_a1_mini",
  "ipAddress": "192.168.1.50",
  "apiKeyHeader": "<lan-access-code>",
  "serial": "0309XXXXXXXXXXX"
}
```

**Command body (example):**
```json
{ "command": "pause" }
```
Other accepted fields: `heater`, `target`, `nozzleIndex`, `gcode`, `trayId`,
`fanPort`, `speed`, `modeId`, `submode`.

#### Hardware control (non-Bambu) — `/printers/:id/proxy/<path…>`

`POST /printers/:id/command` only covers Bambu (which is MQTT-driven). For
HTTP-driven printers (e.g. **Snapmaker U1**, which runs Moonraker), the dashboard
controls the hardware through a raw proxy — and that proxy is exposed here under
`/proxy/`. The request method, path tail, query string, and body are forwarded
verbatim to the printer's hardware API; the response is streamed straight back.
This is exactly how the UI drives those printers, so you get full parity:

```bash
# pause / resume / cancel (Moonraker)
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers/u1-01/proxy/printer/print/pause"
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers/u1-01/proxy/printer/print/resume"
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers/u1-01/proxy/printer/print/cancel"

# run a gcode script (set bed temp, LED, fans, filament macros, …)
curl -H "X-Api-Key: $KEY" -X POST \
  "$BASE/printers/u1-01/proxy/printer/gcode/script?script=M140%20S60"

# read live status objects
curl -H "X-Api-Key: $KEY" \
  "$BASE/printers/u1-01/proxy/printer/objects/query?print_stats"
```

- Non-GET proxy calls are written to the audit log (`printer.proxy`); read-only
  status polls are not, to avoid log spam.
- Your `X-Api-Key` / `Authorization` headers are **stripped** before the request
  reaches the printer — they never leak to the hardware.
- The proxy targets the printer's own API surface, so consult that firmware's
  docs (Moonraker, etc.) for the available paths.

#### Webcam

The camera endpoints return image data, **not** JSON:

- `GET /printers/:id/camera/snapshot` → `image/jpeg` (one frame).
- `GET /printers/:id/camera/stream` → `multipart/x-mixed-replace` MJPEG for
  live-capable profiles (Snapmaker U1, Bambu H2 series); other profiles
  (e.g. Bambu A1 Mini, which is snapshot-only) return a single JPEG.
- `GET /printers/:id/camera/health` → JSON supervisor status
  (`status`, `online`, `viewers`, `lastFrameAgeMs`, `restarts`, `lastError`).

They route through the same internal webcam proxy as the dashboard, so the
printer must have its camera reachable (and for Bambu, **LAN Mode Liveview**
enabled). Drop a snapshot straight into an `<img>`:

```html
<img src="http://localhost:8080/api/v1/printers/printer-1/camera/stream" />
```

> Note: an `<img>`/`<video>` tag cannot send an `X-Api-Key` header. For
> browser-embedded streams, either use the unauthenticated friendly route
> `/webcam/<id>` (no key), or proxy the `/api/v1` request server-side and
> forward the key.

---

### Queue — `/api/v1/queue`

GET returns the **stored** queue jobs. It does **not** trigger a Google Sheet
sync — that behavior lives on the frontend `/api/queue` path only.

| Method & path | Description |
|---------------|-------------|
| `GET /queue` | List stored queue jobs. |
| `POST /queue` | Upsert jobs. Body is an array, or `{ "jobs": [...] }`. Returns `{ "added": [...] }`. |
| `POST /queue/reset` | Clear `printed_status` for all non-deleted jobs. |
| `POST /queue/:id/printed` | Mark a job printed. |
| `DELETE /queue/:id` | Soft-delete a job (sets `deleted_at`). |

#### Migration (host → host)

Move a queue — including the stored model files — from one print-farm host to
another. The manifest carries **metadata only**; file bytes transfer per-job so
a large model never has to be base64-encoded inside one JSON document.

| Method & path | Description |
|---------------|-------------|
| `GET /queue/export` | Metadata-only manifest of stored jobs → `{ "jobs": [...] }`. Pending jobs only by default; add `?includePrinted=true` to also include printed history. Each job carries `hasFile`, `fileMime`, `fileSize`. |
| `POST /queue/import` | Recreate rows from a manifest. Body is an array or `{ "jobs": [...] }`. Preserves `id`, `printedStatus`, and `submittedAt` (idempotent upsert on `id`). Returns `{ "imported": <count> }`. |
| `GET /queue/:id/file` | Stream a job's stored model bytes (`Content-Disposition: attachment`). `404` if the job has no stored file. |
| `PUT /queue/:id/file` | Attach model bytes to an already-imported job. Send the file as the **raw request body**; `Content-Type` becomes the stored MIME. `404` if the job doesn't exist yet. Returns `{ "id", "fileSize" }`. |

The upload route is capped by `QUEUE_UPLOAD_MAX_BYTES` (default 50 MB), and nginx
lifts its body cap to 60 MB for `…/queue/:id/file` specifically.

**Migration flow** (controller drives both hosts):

```bash
SRC="http://host-a:8080/api/v1";  DST="http://host-b:8080/api/v1"

# 1. pull the manifest from the source
curl -H "X-Api-Key: $SRC_KEY" "$SRC/queue/export?includePrinted=true" -o jobs.json

# 2. recreate the rows on the destination
curl -H "X-Api-Key: $DST_KEY" -X POST "$DST/queue/import" \
     -H "Content-Type: application/json" --data-binary @jobs.json

# 3. for each job with hasFile=true, copy the bytes A → B
curl -H "X-Api-Key: $SRC_KEY" "$SRC/queue/$ID/file" -o model.bin
curl -H "X-Api-Key: $DST_KEY" -X PUT "$DST/queue/$ID/file" \
     -H "Content-Type: model/3mf" --data-binary @model.bin

# 4. (optional) remove the migrated jobs from the source
curl -H "X-Api-Key: $SRC_KEY" -X DELETE "$SRC/queue/$ID"
```

---

### Analytics — `/api/v1/analytics`

| Method & path | Description |
|---------------|-------------|
| `GET /analytics?days=7` | Daily analytics rollups. `days` defaults to `7`. |
| `POST /analytics/reset` | Reset the daily analytics. |

---

### Notifications (Discord webhooks) — `/api/v1/notifications`

| Method & path | Description |
|---------------|-------------|
| `GET /notifications` | List configured Discord webhooks. |
| `POST /notifications` | Create/update a webhook. Generates an `id` if omitted; returns `{ "id": ... }`. |
| `DELETE /notifications/:id` | Delete a webhook. |

**Body (example):**
```json
{
  "name": "Build Room",
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "events": ["queue_added", "print_done"],
  "enabled": true
}
```

---

### Slicer API keys — `/api/v1/slicer-keys`

| Method & path | Description |
|---------------|-------------|
| `GET /slicer-keys` | List keys (metadata only — never the secret). |
| `POST /slicer-keys` | Mint a key. Body `{ "name": "..." }`. **Plaintext key returned once** in the response. |
| `DELETE /slicer-keys/:id` | Revoke a key. |

**Create response (key shown only here):**
```json
{ "id": "uuid", "name": "Orca Slicer", "key": "plaintext-key-shown-once" }
```

---

### Audit logs — `/api/v1/audit-logs`

| Method & path | Description |
|---------------|-------------|
| `GET /audit-logs?limit=200` | Most recent entries first. `limit` clamped to 1–1000. |
| `POST /audit-logs` | Append an entry. Body requires `action`; optional `target`, `details`. |

---

### Settings (app_settings key/value) — `/api/v1/settings`

| Method & path | Description |
|---------------|-------------|
| `GET /settings/:key` | Read a setting. Returns `{ "key": ..., "value": ... }` (`value` is `null` if unset). |
| `PUT /settings/:key` | Write a setting. Body `{ "value": <any> }`, or the raw value as the whole body. |

`POST` is accepted as an alias for `PUT`.

Most dashboard configuration is stored here as plain `app_settings` keys, so this
endpoint is also how you manage them via the API. Notable keys:

| Key | What it holds |
|-----|---------------|
| `branding` | Site name, theme color, logo. |
| `integration_urls` | `{ googleSheetQueueUrl, googleFormUrl }` (optional external links). |
| `analytics_layout` | Analytics page grid layout (array of `{i,x,y,w,h}`). |
| `printer_card_layout:<profile>` | Per-profile detail-card column layout (array of arrays). |

> The dedicated frontend endpoints validate these shapes; the generic
> `PUT /settings/:key` stores the value **as-is**, so send the same shape the UI
> would write.

---

### Staff users — `/api/v1/users`

Manage staff accounts (operators / extra admins). Mirrors the dashboard's user
management. The primary `admin` account is **not** in this list — it's the
separate **admin-credential** resource (below). Password hashes are
**never** returned.

Passwords are supplied **pre-hashed** as a sha256 hex string (`passwordHash`),
matching how the frontend submits them — the server never sees plaintext.

| Method & path | Description |
|---------------|-------------|
| `GET /users` | List staff users (sanitized — no hashes). |
| `POST /users` | Create a user. Body `{ name, username, role, passwordHash }`. `role` ∈ `admin`/`operator`/`viewer`. Returns the sanitized record. |
| `DELETE /users/:id` | Remove a user. |
| `PUT /users/:id/password` | Set a new password. Body `{ passwordHash }`. |
| `POST /users/verify` | Validate a login. Body `{ username, passwordHash }` → `200 { valid: true, user }` or `401 { valid: false }`. |

`username` `admin` is reserved (`409`); duplicate usernames return `409`.

**Create body (example):**
```json
{ "name": "Jane Operator", "username": "jane", "role": "operator", "passwordHash": "<sha256-hex>" }
```

---

### Admin credential — `/api/v1/admin-credential`

The primary admin password (a sha256 hash in `app_settings`). Because a
`printfarm_manage` key is the guard, it may **set or reset** the password
outright — unlike the public frontend endpoint, which is first-run-only and
otherwise requires the current password.

| Method & path | Description |
|---------------|-------------|
| `GET /admin-credential` | `{ "configured": <bool> }` — whether a password is set. Never returns the hash. |
| `PUT /admin-credential` | Set or reset the password. Body `{ passwordHash }`. `201` on first set, `200` on reset. |
| `POST /admin-credential/verify` | Validate. Body `{ passwordHash }` → `200 { valid: true }` or `401 { valid: false }`. |

---

## Quick reference (curl)

```bash
KEY="your-api-key"
BASE="http://localhost:8080/api/v1"

# discovery
curl -H "X-Api-Key: $KEY" "$BASE"

# printers
curl -H "X-Api-Key: $KEY" "$BASE/printers"
curl -H "X-Api-Key: $KEY" "$BASE/printers/printer-1"
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers" \
     -H "Content-Type: application/json" \
     -d '{"id":"printer-1","name":"A1 #1","profile":"bambulab_a1_mini"}'
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers/printer-1/command" \
     -H "Content-Type: application/json" -d '{"command":"pause"}'
curl -H "X-Api-Key: $KEY" -X DELETE "$BASE/printers/printer-1"

# non-Bambu hardware control (Moonraker passthrough)
curl -H "X-Api-Key: $KEY" -X POST "$BASE/printers/u1-01/proxy/printer/print/pause"

# webcam
curl -H "X-Api-Key: $KEY" "$BASE/printers/printer-1/camera/snapshot" -o frame.jpg
curl -H "X-Api-Key: $KEY" "$BASE/printers/printer-1/camera/health"

# queue / analytics / settings
curl -H "X-Api-Key: $KEY" "$BASE/queue"
curl -H "X-Api-Key: $KEY" "$BASE/analytics?days=30"
curl -H "X-Api-Key: $KEY" -X PUT "$BASE/settings/printer_card_layout" \
     -H "Content-Type: application/json" -d '{"value":{"foo":"bar"}}'

# queue migration (host → host)
curl -H "X-Api-Key: $KEY" "$BASE/queue/export?includePrinted=true" -o jobs.json
curl -H "X-Api-Key: $KEY" -X POST "$BASE/queue/import" \
     -H "Content-Type: application/json" --data-binary @jobs.json

# staff users / admin password
curl -H "X-Api-Key: $KEY" "$BASE/users"
curl -H "X-Api-Key: $KEY" "$BASE/admin-credential"
```
