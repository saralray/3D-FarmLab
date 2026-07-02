# 3D-FarmLab — API Reference

A versioned, API-key-gated HTTP API over the print farm's data. It is served by
the `web` service (`handleDataApi` in `server/app.js`) and is **entirely
separate** from the session-cookie-authenticated frontend `/api/*` endpoints the
dashboard uses (see [Frontend session API](#frontend-session-api--apiauth) for
those). This `/api/v1` namespace is for external integrations, scripts, and
dashboards.

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
  "resources": ["printers", "queue", "analytics", "notifications", "slicer-keys", "audit-logs", "settings", "users", "admin-credential", "manager-requests", "maintenance"]
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

Printer records include an `errorMessage` field: a human-readable description of
the printer's current fault (Bambu HMS faults, a Moonraker print error, or an
unreachable-connection reason), set per profile by the poller. It is absent/`null`
when the printer is healthy, and — not being a connection secret — is present even
in redacted/public-viewer responses.

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

Optional `totalPrintHours` and `currentNozzleHours` (doubles, hours) seed the
printer's preventive-maintenance clock for an already-used machine. They are
**honored on create only** — on an edit/reorder they are ignored so the poller's
accrued hours aren't overwritten.

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
| `GET /queue/export` | Metadata-only manifest of stored jobs → `{ "jobs": [...] }`. Pending jobs only by default; add `?includePrinted=true` to also include printed history. Migrate **only a selection** with `?ids=a,b,c` (comma-separated, repeatable). Each job carries `hasFile`, `fileMime`, `fileSize`. |
| `POST /queue/import` | Recreate rows from a manifest. Body is an array or `{ "jobs": [...] }`. Preserves `id`, `printedStatus`, and `submittedAt` (idempotent upsert on `id`). Returns `{ "imported": <count> }`. |
| `GET /queue/:id/file` | Stream a job's stored model bytes (`Content-Disposition: attachment`). `404` if the job has no stored file. |
| `PUT /queue/:id/file` | Attach model bytes to an already-imported job. Send the file as the **raw request body**; `Content-Type` becomes the stored MIME. `404` if the job doesn't exist yet. Returns `{ "id", "fileSize" }`. |
| `POST /queue/delete` | Bulk soft-delete the source rows after migration. Body is an array or `{ "ids": [...] }`. Returns `{ "deleted": <count> }`. |

The upload route is capped by `QUEUE_UPLOAD_MAX_BYTES` (default 50 MB), and nginx
lifts its body cap to 60 MB for `…/queue/:id/file` specifically.

**Migration flow** (controller drives both hosts):

```bash
SRC="http://host-a:8080/api/v1";  DST="http://host-b:8080/api/v1"

# 1. pull the manifest from the source — whole queue, or only a selection:
curl -H "X-Api-Key: $SRC_KEY" "$SRC/queue/export?includePrinted=true" -o jobs.json
# selection only:
curl -H "X-Api-Key: $SRC_KEY" "$SRC/queue/export?ids=job-1,job-2" -o jobs.json

# 2. recreate the rows on the destination
curl -H "X-Api-Key: $DST_KEY" -X POST "$DST/queue/import" \
     -H "Content-Type: application/json" --data-binary @jobs.json

# 3. for each job with hasFile=true, copy the bytes A → B
curl -H "X-Api-Key: $SRC_KEY" "$SRC/queue/$ID/file" -o model.bin
curl -H "X-Api-Key: $DST_KEY" -X PUT "$DST/queue/$ID/file" \
     -H "Content-Type: model/3mf" --data-binary @model.bin

# 4. remove the migrated jobs from the source — one job, or the whole selection:
curl -H "X-Api-Key: $SRC_KEY" -X DELETE "$SRC/queue/$ID"
curl -H "X-Api-Key: $SRC_KEY" -X POST "$SRC/queue/delete" \
     -H "Content-Type: application/json" -d '{"ids":["job-1","job-2"]}'
```

---

### Analytics — `/api/v1/analytics`

| Method & path | Description |
|---------------|-------------|
| `GET /analytics?days=7` | Daily analytics rollups. `days` defaults to `7`. |
| `POST /analytics/reset` | Reset the daily analytics. |

---

### Maintenance — `/api/v1/maintenance`

Preventive-maintenance parity. Printers accumulate `totalPrintHours` /
`currentNozzleHours` as jobs finish; pending `maintenance_events` are auto-created
when an interval is crossed (never duplicated while one is open), and a rolling
`healthScore` (0–100) is recomputed every 5 minutes.

| Method & path | Description |
|---------------|-------------|
| `GET /maintenance?printer=&status=&type=` | List maintenance events. Filters optional (`status` defaults to all). |
| `GET /maintenance/summary` | Fleet aggregates: `{ printersRequiringMaintenance, overdueTasks, averageHealth, totalFleetHours, printerCount }`. |
| `GET /maintenance/printer/:printerId` | Per-printer summary (hours, health, pending/completed tasks, `nextService`). |
| `POST /maintenance/:eventId/complete` | Mark a pending task completed. Body `{ notes? }`. Stamps completion hours/time, advances `lastMaintenanceAt`, and resets nozzle hours for a nozzle service. `404` if not pending. |

The admin-configurable global default intervals live in **app_settings** under the
key `maintenance_default_intervals` (array of `{ type, intervalHours, description }`),
reachable via the generic `settings` resource (`GET/PUT /api/v1/settings/maintenance_default_intervals`).

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
  "enabled": true,
  "tts": false
}
```

`tts` (default `false`): when `true`, notifications are delivered as Discord
text-to-speech — the payload is sent as **plain `content` text with `tts: true`
and no embed** (Discord only reads `content` aloud, never embeds), with the
spoken line derived from the embed title/description. Defaults to a silent,
richly-formatted embed-only message.

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
| `branding` | `{ siteName, logoDataUrl, logoSvg, logoAdaptive, logoScale, backgroundDataUrl, faviconDataUrl }` — `siteName` (browser tab + dashboard heading; empty = bundled default name), plus the site logo, an optional full-page website background image, and an optional browser/app icon (`faviconDataUrl`) (all base64 data URLs; empty = bundled defaults). |
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
separate **admin-credential** resource (below). Unlike the cookieless frontend
`/api/users`, the list/create/role responses here **include** each account's
stored `passwordHash` (the API key is the guard, matching `admin-credential`),
so accounts can be migrated host→host.

Passwords are supplied **pre-hashed** as a sha256 hex string (`passwordHash`),
matching how the frontend submits them — the server never sees plaintext. The
server then runs that sha256 through a slow, salted **scrypt** KDF before
storing it, so the persisted (and returned) `passwordHash` is a self-describing
`scrypt$N$r$p$salt$hash` string, **not** a bare sha256. For migration, create
and password-set also accept an already-derived `scrypt$…` value verbatim;
legacy bare-sha256 records keep working and are upgraded to scrypt on next login.

| Method & path | Description |
|---------------|-------------|
| `GET /users` | List staff users (each record includes its stored `passwordHash`). |
| `POST /users` | Create a user. Body `{ name, username, role, passwordHash }` (`passwordHash` a sha256 hex or a `scrypt$…` string). `role` ∈ `admin`/`operator`/`viewer`. Returns the record with its stored hash. |
| `DELETE /users/:id` | Remove a user. |
| `PUT /users/:id/password` | Set a new password. Body `{ passwordHash }` (sha256 hex or `scrypt$…`). |
| `PUT /users/:id/role` | Change the account role. Body `{ role }`, `role` ∈ `admin`/`operator`/`viewer`. Returns the updated record. |
| `POST /users/verify` | Validate a login. Body `{ username, passwordHash }` (sha256 hex) → `200 { valid: true, user }` (sanitized — no hash) or `401 { valid: false }`. |

`username` `admin` is reserved (`409`); duplicate usernames return `409`.

**Create body (example):**
```json
{ "name": "Jane Operator", "username": "jane", "role": "operator", "passwordHash": "<sha256-hex>" }
```

---

### Admin credential — `/api/v1/admin-credential`

The primary admin password (stored in `app_settings`). The supplied `passwordHash`
is a sha256 hex (hashed client-side); the server stretches it with a salted
**scrypt** KDF before storing (`scrypt$N$r$p$salt$hash`). Because a
`printfarm_manage` key is the guard, it may **set or reset** the password
outright — unlike the public frontend endpoint, which is first-run-only and
otherwise requires the current password.

| Method & path | Description |
|---------------|-------------|
| `GET /admin-credential` | `{ "configured": <bool> }` — whether a password is set. Never returns the hash. |
| `PUT /admin-credential` | Set or reset the password. Body `{ passwordHash }` (sha256 hex, or a `scrypt$…` string for migration). `201` on first set, `200` on reset. |
| `POST /admin-credential/verify` | Validate. Body `{ passwordHash }` (sha256 hex) → `200 { valid: true }` or `401 { valid: false }`. |

---

### Manager access requests — `/api/v1/manager-requests`

The operator/manager access-request workflow (someone requests access → an
admin approves or denies → a `printfarm_manage` key is minted on approval).
This is the key-gated mirror of the public [`/api/manager`](#manager-access-request-api-apimanager)
flow, giving an external manager app full parity over granting and revoking
access. Unlike the public status-poll flow (which reveals the minted key once
via `/status`), `approve` returns the plaintext `key` inline since the calling
key is the guard.

| Method & path | Description |
|---------------|-------------|
| `GET /manager-requests` | List all requests (pending/approved/denied). |
| `POST /manager-requests` | Create a request. Body `{ name, description? }` → `201 { id }`. |
| `GET /manager-requests/:id` | Fetch one request record. |
| `POST /manager-requests/:id/approve` | Approve a **pending** request: mints a `printfarm_manage` key → `200 { ok: true, apiKeyId, key }`. `400` if not pending. |
| `POST /manager-requests/:id/deny` | Deny a **pending** request → `200 { ok: true }`. `400` if not pending. |
| `DELETE /manager-requests/:id` | Delete the request (and revoke its minted key, if any). |

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

# manager access requests
curl -H "X-Api-Key: $KEY" "$BASE/manager-requests"
curl -H "X-Api-Key: $KEY" -X POST "$BASE/manager-requests/<id>/approve"
```

---

## Frontend session API (`/api/auth/*`)

The dashboard's own `/api/*` surface is authenticated with a **server-side
session**, not the `/api/v1` API key. A login issues an opaque token stored in an
HttpOnly, SameSite=Lax cookie (`pf_session`); only its sha256 hash is persisted
(in the `sessions` table). The cookie is sent automatically on same-origin
requests, so the SPA does not handle it directly. Authorization is enforced in
`server/app.js` (`authorizeFrontendApi`) before any frontend route runs.

> **Cookie `Secure` flag:** set only when the request arrives over HTTPS
> (`X-Forwarded-Proto: https`) or when `SESSION_COOKIE_SECURE=true`. Set that
> env var once the site is served over TLS.

### Endpoints

| Method | Path | Auth | Body / result |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | public | `{ username, passwordHash, remember }` → sets cookie, returns `{ user }`. `passwordHash` is sha256 hex of the password (hashed client-side). Rate-limited per IP (8 failures / 15 min → `429` with `Retry-After`). |
| `POST` | `/api/auth/logout` | public | Destroys the session and clears the cookie. Idempotent. |
| `GET` | `/api/auth/session` | public | `{ user }` for the current cookie session, or `{ user: null }`. Used to restore auth state on load. |
| `POST` | `/api/auth/verify` | public | OAuth/SSO grant exchange. On success **also issues a session cookie**. |
| `POST` | `/api/slicer-grant/verify` | public | Verifies a slicer "Device" grant and issues an **operator** session cookie. |
| `POST` | `/api/admin/credential` | public (first-run only) | Sets the initial admin password and issues an admin session. Refuses (`409`) once configured. |
| `PUT` | `/api/admin/credential` | public + current-password proof | Changes the admin password; **revokes all existing admin sessions** and re-issues the caller's. |

Sessions are also revoked server-side when a staff account is deleted, its
password is reset, or its role changes, so a stale cookie can't outlive the
change.

### Authorization matrix (frontend `/api/*`)

Reads are public (the dashboard has an anonymous viewer mode) **except** those
that expose secrets. Mutations are **default-deny**: anything not explicitly
classified below requires an admin session.

| Class | Who | Examples |
| --- | --- | --- |
| **public read** | anyone | `GET /api/printers`, `GET /api/queue`, `GET /api/analytics/daily`, `GET /api/cameras/health`, `GET /api/maintenance`, `GET /api/maintenance/summary`, `GET /api/maintenance/notifications`, `GET /api/printers/:id/maintenance`, `GET /api/settings/maintenance-intervals`, `GET /api/settings/favicon`, branding/layout reads |
| **admin read** | admin only | `GET /api/users`, `GET /api/slicer-keys`, `GET /api/audit-logs`, `GET /api/admin/update-status`, `GET /api/notifications/*`, `GET /api/manager/requests`, `GET /api/settings/saml`, `GET /api/settings/home-assistant*` |
| **public mutation** | anyone | `POST /api/queue/submit` (student intake), `POST /api/manager/request`, the auth endpoints above |
| **operator** | operator or admin | `POST /api/printers` (create/edit/reorder), `POST /api/printers/:id/command`, `POST /api/queue/:id/printed`, `POST /api/maintenance/:id/complete`, `POST /api/maintenance/notifications/read` |
| **authed** | any session | `POST /api/audit-logs` (actor is taken from the session, not the body) |
| **admin** | admin only | `DELETE /api/printers/:id`, `DELETE /api/queue/:id`, `/api/queue/reset`, `/api/analytics/daily/reset`, all `/api/users/*` writes, all `/api/slicer-keys` writes, `/api/notifications/*` writes, `/api/settings/*` writes, `POST /api/admin/update/apply`, manager request approve/deny/delete |

> **Connection-secret redaction:** `GET /api/printers` and `GET /api/printers/:id`
> return connection fields (`ipAddress`, `apiKeyHeader`, `serial`, `url`) only to
> an operator/admin session. Anonymous, viewer, and student sessions always get
> the redacted record, regardless of `VITE_PUBLIC_VIEWER_MODE`.

Denials return `401` (no/expired session) or `403` (insufficient role).

> **CSRF / same-origin (browser writes):** Cookie-authenticated **mutations**
> (any non-`GET`/`HEAD` to a non-public frontend `/api/*` route) also require a
> same-origin request — the `Origin` (or `Referer`) hostname must match the
> request host, else `403 {"error":"Cross-origin request blocked."}`. This is
> defense-in-depth on top of the `SameSite=Lax` session cookie. It does **not**
> apply to the **public mutation** endpoints (so the IdP's cross-origin SAML ACS
> POST and the CORS manager-request API still work), nor to the key-gated
> `/api/v1` surface. Requests with no `Origin`/`Referer` (curl, server-to-server)
> are allowed — use `/api/v1` with an API key for automation.

### Version endpoint

`GET /api/version` — **public, no auth**. Returns `{ buildId: string }` where `buildId` is a 16-hex-char SHA-256 of `dist/index.html`, computed once at server startup. Changes on every new deploy. Cached `no-store`. The frontend polls this every 5 minutes and prompts users to reload when the value changes. Suppressed from access logs (treated as a quiet probe alongside `/healthz`).

### Software update (admin — Settings → Maintenance)

Lets a deployed site detect that a newer version has been published and (when a Watchtower sidecar is wired up) apply it in place. Both are **admin only** (cookie session); the apply is CSRF same-origin-gated and audited.

| Method & path | Description |
|---------------|-------------|
| `GET /api/admin/update-status` | Compares the running image's baked commit SHA against the latest commit on the tracked GitHub branch (cached ~20 min server-side). Pass `?force=1` (the UI's "Check again" button) to bypass the TTL cache and re-poll GitHub immediately so a just-pushed commit shows up right away. Returns `{ enabled, current, latest, updateAvailable, latestCommittedAt, checkedAt, canApply }`. When `UPDATE_CHECK_REPO` is unset → `{ enabled: false, current }`. On an upstream failure → `{ enabled: true, current, error }`. `canApply` reflects whether `WATCHTOWER_TOKEN` is configured. Cached `no-store`. |
| `POST /api/admin/update/apply` | Triggers the Watchtower sidecar (`WATCHTOWER_URL` + `WATCHTOWER_TOKEN`) to pull the newer `:latest` images and recreate the app containers. `202 { started: true }` on success — also returned if the request to Watchtower is still outstanding after 5 minutes (a backstop, not a real failure: the trigger already reached Watchtower, which may still be mid-pull or may have already recreated this `web` container). `503` when no updater is configured; `502` only on a genuine connect failure (Watchtower unreachable). Writes an audit-log entry (`action: software.update.apply`). The update itself runs entirely server-side via Watchtower, independent of the client connection — closing the browser tab after the trigger succeeds does not stop or affect it. |

Version detection relies on `APP_VERSION` (the git SHA baked into the image by `.github/workflows/deploy.yml`); the one-click apply relies on `docker-compose.deploy.yml` (pulls published images + runs the Watchtower sidecar). Both are documented in `.env.example`.

### Maintenance (frontend `/api/*`)

Cookieless, like the rest of the frontend surface (reads public; the complete /
mark-read writes are operator-or-admin; interval config is admin).

| Method & path | Description |
|---------------|-------------|
| `GET /api/printers/:id/maintenance` | Per-printer summary: `{ printerId, totalHours, nozzleHours, healthScore, healthStatus, lastMaintenanceAt, pendingTasks[], completedTasks[], nextService:{ type, intervalHours, remainingHours } }`. Pending tasks carry an `overdue` flag. |
| `GET /api/maintenance?printer=&status=&type=` | List maintenance events. `status` defaults to `pending`. |
| `POST /api/maintenance/:id/complete` | Mark a pending task done. Body `{ notes? }`. |
| `GET /api/maintenance/summary` | Fleet widget aggregates (`printersRequiringMaintenance`, `overdueTasks`, `averageHealth`, `totalFleetHours`, `printerCount`). |
| `GET /api/maintenance/notifications[?unread=true]` | In-app maintenance notifications for the bell. |
| `POST /api/maintenance/notifications/read` | Mark notifications read. Body `{ ids? }` (all unread when omitted). |
| `GET /api/settings/maintenance-intervals` | Global default service intervals (array of `{ type, intervalHours, description }`). |
| `PUT /api/settings/maintenance-intervals` | Replace the default intervals (admin). Body is the array, or `{ intervals: [...] }`. New printers seed from this; existing printers are backfilled by the worker. |
| `GET /api/settings/favicon` | Serves the custom browser/app icon as a raw image (correct `Content-Type`). Returns `404` when no custom favicon is configured (bundled `/icon.svg` is used instead). Referenced by the dynamic PWA manifest's `icons` array when a custom favicon is set. |

`healthScore` deductions: lubrication overdue −5, nozzle hours >1000 −10, any
overdue task −15, print failure rate >10% −10 (clamped 0–100). Status bands:
90–100 Excellent, 70–89 Good, 50–69 Warning, 0–49 Service Required.

---

## Manager Access Request API (`/api/manager`)

A separate, **public** endpoint group that lets an external manager app request a
`printfarm_manage`-scoped API key without any prior credentials. The request
appears in the admin's notification bell and **Settings → API Keys → Managers**
for approval or denial.

These endpoints live under `/api/manager/` — **not** under `/api/v1/` — and
require **no API key**. Two of the endpoints (`POST /api/manager/request` and
`GET /api/manager/requests/:id/status`) are **CORS-enabled** (`Access-Control-Allow-Origin: *`)
so that a manager app hosted on a different origin can call them.

### Request lifecycle

```
pending  →  approved  (key delivered once via status poll)
         →  denied
approved →  deleted   (admin revokes from Settings → API Keys → Managers; record removed)
```

### Endpoints

#### `POST /api/manager/request`

Submit a new manager access request. **Public. CORS-enabled.**

**Request body:**

```json
{
  "name": "My Dashboard",
  "description": "Optional — what this manager is used for"
}
```

**Response `201`:**

```json
{ "id": "01j..." }
```

The `id` is a UUIDv4 string. The caller stores it to poll the status endpoint.

---

#### `GET /api/manager/requests/:id/status`

Poll the status of a request. **Public. CORS-enabled.**

Returns the current status. When the request is approved and the key has not yet
been retrieved, the response includes the plaintext `key`. The key is
**immediately cleared** from the server after the first response that includes
it — subsequent polls return `approved` status but no `key`.

**Response `200`:**

```json
{ "id": "01j...", "status": "pending" }
```

```json
{ "id": "01j...", "status": "approved", "key": "abc123..." }
```

```json
{ "id": "01j...", "status": "approved" }
```

```json
{ "id": "01j...", "status": "denied" }
```

```json
{ "id": "01j...", "status": "revoked" }
```

**Response `404`** if the id is not found.

---

#### `GET /api/manager/requests`

List all manager requests. **Admin only (frontend session guard).**

**Response `200`:**

```json
[
  {
    "id": "01j...",
    "name": "My Dashboard",
    "description": "What it's for",
    "status": "approved",
    "apiKeyId": "uuid...",
    "createdAt": "2026-06-17T12:00:00.000Z",
    "updatedAt": "2026-06-17T12:05:00.000Z"
  }
]
```

Ordered by `created_at DESC`. The `key_secret` field (one-time plaintext) is
**never** included in this list response.

---

#### `POST /api/manager/requests/:id/approve`

Approve a pending request. **Admin only (frontend session guard).**

Generates a new `printfarm_manage`-scoped API key, stores its sha256 hash in
`slicer_api_keys` (visible in Settings → API Keys with the name `Manager: <name>`),
and saves the plaintext temporarily for one-time delivery via the status endpoint.

**Response `200`:**

```json
{ "ok": true }
```

**Response `404`** if the id is not found.

---

#### `POST /api/manager/requests/:id/deny`

Deny a pending request. **Admin only (frontend session guard).**

**Response `200`:**

```json
{ "ok": true }
```

---

#### `DELETE /api/manager/requests/:id`

Revoke an approved manager's access. **Admin only (frontend session guard).**

Deletes the associated API key from `slicer_api_keys` and **permanently removes**
the `manager_requests` row. The entry disappears from the Managers list immediately.
Any subsequent calls using that key will receive `401`.

**Response `200`:**

```json
{ "ok": true }
```

### End-to-end flow example

```bash
# 1. External manager app submits a request
curl -X POST http://printfarm.local/api/manager/request \
  -H "Content-Type: application/json" \
  -d '{"name":"Portainer","description":"Farm management"}'
# → {"id":"01j..."}

# 2. Poll until approved (do this every few seconds)
curl http://printfarm.local/api/manager/requests/01j.../status
# → {"id":"01j...","status":"pending"}

# (admin approves in the notification bell or Settings → API Keys → Managers)

# 3. Next poll returns the key — copy it immediately
curl http://printfarm.local/api/manager/requests/01j.../status
# → {"id":"01j...","status":"approved","key":"abc123..."}

# 4. Use the key against /api/v1
curl -H "X-Api-Key: abc123..." http://printfarm.local/api/v1/printers
```

## SSO sign-in API (`/api/auth`)

A **public** endpoint group (no API key) that runs the OAuth 2.0 Authorization
Code flow for two providers — **`google`** and **`microsoft`** (Microsoft Entra
ID / Azure AD) — plus **SAML 2.0** SSO against an external identity provider (the
dashboard is the Service Provider). The dashboard auth is cookieless, so instead
of a server session the flow mints a short-lived, **HMAC-signed grant token** and
hands it back to the browser as a `?oauth_grant=<token>` URL param — the same
hand-off shape as the slicer grant. The client verifies the token server-side
before establishing a session. OAuth sign-ins are granted the read-only
**`student`** role; SAML sign-ins take their role from the assertion (or keep the
stored role of an existing staff account) — see the SAML section below.

Configure each provider's client id/secret, optional allowed email domains, and
(Microsoft only) either the cloud directory **Tenant ID** or an on-prem **AD FS
authority URL** (the `/adfs` deep link) in **Settings → Sign-in**; nothing is
baked into the build. Register `<origin>/api/auth/<provider>/callback` as a
redirect URI with the provider (Google Cloud console / Azure app registration /
AD FS relying-party); the origin is the configured [SSO public
URL](#sso-public-url-apisettingssso-public-url) (Settings → Sign-in), else
`APP_BASE_URL`, else derived from `X-Forwarded-Proto`/`Host`.

Both providers may be enabled at once — the login page shows a button for each
enabled provider.

### Endpoints

#### `GET /api/auth/providers`

Which providers are configured **and** enabled. Drives the login buttons.
**Public.** Never returns any secret.

**Response `200`** (`saml` reflects whether SAML SSO is enabled + configured):

```json
{ "google": true, "microsoft": false, "saml": false }
```

---

#### `GET /api/auth/:provider/config`

Whether a single provider (`google` or `microsoft`) is configured **and**
enabled. **Public.**

**Response `200`:** `{ "enabled": true }`

---

#### `GET /api/auth/:provider/start`

Begins the flow for `:provider`. **Public.** `302`-redirects the browser to that
provider's consent screen (with `scope=openid email profile`, the derived
`redirect_uri`, and a signed `state` carrying the provider). When the provider is
disabled/unconfigured it redirects to `/login?oauth_error=not_configured`.

---

#### `GET /api/auth/:provider/callback`

The provider redirects here with `?code=&state=`. **Public.** Verifies `state`
(including that it was minted for this provider), exchanges the code at the
provider's token endpoint (server-to-server with the client secret), requires an
email (Google `email`; Microsoft falls back to `preferred_username`/`upn`) that
is not explicitly unverified and (if configured) an allowed domain, then mints
the grant token and `302`-redirects to `/login?oauth_grant=<token>`.

On any failure it `302`-redirects to `/login?oauth_error=<code>` where `<code>`
is one of `not_configured`, `denied`, `exchange_failed`, `unverified_email`, or
`domain_not_allowed`.

---

#### `POST /api/auth/verify`

Verifies a grant token from any provider's callback (the grant carries its own
provider). **Public.**

**Request body:**

```json
{ "token": "<oauth_grant value>" }
```

**Response `200`** — `id` is namespaced by provider (`google:` / `microsoft:`):

```json
{
  "user": {
    "id": "microsoft:1234567890",
    "name": "Jane Student",
    "username": "jane@school.edu",
    "role": "student"
  }
}
```

**Response `401`** if the token is missing, forged, or expired.

For SAML sign-ins the ACS (below) mints the **same** grant token, so this one
`verify` endpoint serves all providers; the returned `id` is `saml:<email>`.

---

### SAML 2.0 SSO endpoints

The dashboard is the SAML **Service Provider**. Configure the IdP in **Settings →
SSO Configuration** (`/api/settings/saml`). The AuthnRequest uses the
**HTTP-Redirect** binding (DEFLATE + base64); the IdP returns the response via the
**HTTP-POST** binding to the ACS. The assertion's enveloped XML signature is
verified against the stored IdP certificate (the cert embedded in the assertion is
ignored), the audience must match the SP entity ID, the recipient must match the
ACS URL, the validity window is enforced, and `InResponseTo` must match the
AuthnRequest id (carried in a signed `RelayState`).

#### `GET /api/auth/saml/metadata`

**Public.** Returns the SP metadata XML (`application/samlmetadata+xml`) generated
from the saved SP entity ID + ACS URL (falling back to the resolved public origin
— see [SSO public URL](#sso-public-url-apisettingssso-public-url) — when left
blank). Import this into the IdP to register the dashboard as an SP.

---

#### `GET /api/auth/saml/start`

**Public.** Begins SAML sign-in: `302`-redirects the browser to the IdP SSO URL
with a DEFLATE+base64 `SAMLRequest` and a signed `RelayState`. Redirects to
`/login?oauth_error=not_configured` when SAML is disabled/unconfigured.

---

#### `GET /launch`

**Public.** Friendly deep-link alias for the SSO portal — a one-click,
SP-initiated SAML sign-in. `302`-redirects to `GET /api/auth/saml/start`, which
takes the browser through the IdP and lands the signed-in user on the dashboard.
Intended as the `href` for a "Print Farm" button on the IdP portal page
(`https://<this-host>/launch`). No body or query params.

---

#### `POST /api/auth/saml/acs`

**Public.** The Assertion Consumer Service. The IdP posts
`application/x-www-form-urlencoded` with `SAMLResponse` (base64 XML) and
`RelayState`. Verifies the assertion, then resolves the user:

- **Existing staff account** (matched by username = asserted email): admitted with
  its **stored** role (the assertion cannot escalate it).
- **Unknown user + Auto Provision Users on:** admitted with the asserted `role`
  (validated to `admin`/`operator`/`viewer`/`student`; anything else →
  `student`).
- **Unknown user + Auto Provision Users off:** rejected with
  `/login?oauth_error=saml_not_provisioned`.

On success mints the grant token and `302`-redirects to
`/login?oauth_grant=<token>`. On a verification failure redirects to
`/login?oauth_error=saml_invalid` (or `not_configured`/`denied`).

## Website access mode (`/api/settings/public-viewer`)

Controls whether an unauthenticated visitor gets a read-only "public viewer"
session of the dashboard, or is redirected to the login screen. Stored in
`app_settings` under the `public_viewer` key; **defaults to enabled** (preserving
the prior behavior where anonymous visitors fell back to a viewer session). The
build-time `VITE_PUBLIC_VIEWER_MODE=true` flag forces public viewing on
regardless of this setting. Connection secrets remain redacted for non-privileged
sessions either way.

#### `GET /api/settings/public-viewer`

Public (the unauthenticated client bootstrap reads it to decide whether to grant
a viewer session).

**Response `200`:**

```json
{ "enabled": true }
```

#### `PUT /api/settings/public-viewer`

Admin-only (covered by the `/api/settings/*` write rule).

**Request body:** `{ "enabled": false }` — `enabled` must be a boolean (else `400`).

**Response `200`:** the saved setting, e.g. `{ "enabled": false }`.

## SSO public URL (`/api/settings/sso-public-url`)

Admin override for the site's own public origin, used as the top-priority tier
when the server builds OAuth `redirect_uri` / SAML `spEntityId`+`acsUrl` (see the
OAuth and SAML sign-in sections). Resolution order: **(1)** this setting, stored
in `app_settings` under `sso_public_url` → **(2)** the `APP_BASE_URL` env var →
**(3)** the `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host` request headers. Set
it when SSO logins land on the wrong host because the reverse proxy doesn't
forward a correct host. Not sensitive (it's the site's own public URL, not a
secret) — `GET` is world-readable like `/api/settings/integrations`; `PUT` is
admin-only (covered by the `/api/settings/*` write rule).

#### `GET /api/settings/sso-public-url`

**Response `200`:**

```json
{ "publicUrl": "", "envFallback": "" }
```

`publicUrl` is the stored override (empty if unset). `envFallback` is the current
`APP_BASE_URL` env value (read-only — shown so an admin can see what tier 2
resolves to before setting tier 1).

#### `PUT /api/settings/sso-public-url`

**Request body:** `{ "publicUrl": "https://printfarm.example.com" }` — `publicUrl`
must be a string; if non-empty it must start with `http://` or `https://`
(else `400`). A trailing `/` is normalized off.

**Response `200`:** the saved setting, in the same shape as `GET`.

## Home Assistant (`/api/settings/home-assistant`)

Connects the dashboard to a Home Assistant instance via its base URL and a
**long-lived access token**. Config is stored in `app_settings` under the
`home_assistant` key; the token is encrypted at rest (same AES-256-GCM scheme as
printer secrets) and **never returned** by any read path. The server holds the
token and proxies every HA REST call, so it never reaches the browser. All
endpoints are **admin-only** — the reads are classified sensitive
(`/api/settings/home-assistant*`), the writes covered by the `/api/settings/*`
write rule.

> Device discovery uses HA's REST API (`GET /api/states`), which exposes
> **entities/states** — the full device registry requires HA's WebSocket API.
>
> **Automation rules** (`/rules`) bridge the print farm and Home Assistant in both
> directions. They are **not** native HA automations (those can't see our
> printers) — they are print-farm-side rules stored in `app_settings`
> (`ha_automation_rules`) and evaluated by a background engine in the `web` server
> (default every 15 s, `HA_AUTOMATION_INTERVAL_MS`). The engine only fires on a
> *transition into* the target value (a value seen for the first time, or after a
> restart, is recorded as a baseline without firing). A `printer_to_ha` rule calls
> an HA service when a printer reaches a status; a `ha_to_printer` rule sends a
> printer command (pause/resume/cancel — Bambu over MQTT, others over Moonraker
> HTTP) when an HA entity reaches a state.

#### `GET /api/settings/home-assistant`

**Response `200`:** `{ "baseUrl": "http://homeassistant.local:8123", "enabled": true, "hasToken": true }` — the token itself is never returned.

#### `PUT /api/settings/home-assistant`

**Request body:** `{ "baseUrl": string, "token"?: string, "enabled": boolean }`.
`baseUrl` must be a string and (if non-empty) start with `http://`/`https://`; a
trailing `/` or `/api` is normalized off. A blank/omitted `token` keeps the stored
one (so the form can round-trip without re-entering it).

**Response `200`:** the saved config in the `GET` shape (`baseUrl`, `enabled`, `hasToken`).

#### `POST /api/settings/home-assistant/test`

Probes `GET <baseUrl>/api/` with the stored token.

**Response `200`:** `{ "ok": true, "message": "Connected to Home Assistant." }` or `{ "ok": false, "error": "…" }`. Returns `400` if the URL/token aren't set yet.

#### `GET /api/settings/home-assistant/devices`

Fetches `GET <baseUrl>/api/states` and shapes it.

**Response `200`:**

```json
{
  "entities": [
    { "entityId": "switch.lab_lights", "domain": "switch", "friendlyName": "Lab Lights", "state": "on" }
  ],
  "groups": { "switch": [ /* …entities… */ ] }
}
```

Returns `502 { "error": … }` if Home Assistant is unreachable or returns an error.

#### `GET /api/settings/home-assistant/rules`

Lists the stored automation rules.

**Response `200`:** `{ "rules": [ <rule>, … ] }`. Each rule is a flat object: common fields `id`, `name`, `direction` (`"ha_to_printer"` | `"printer_to_ha"`), `enabled`, `printerId`, `createdAt`; plus, per direction:
- `ha_to_printer`: `triggerEntity`, `triggerState`, `printerCommand` (`pause`|`resume`|`cancel`).
- `printer_to_ha`: `printerStatus` (`printing`|`idle`|`paused`|`error`|`offline`), `actionService` (`domain.service`), `actionEntity` (optional), `actionData` (object).

#### `POST /api/settings/home-assistant/rules`

Creates a rule. **Request body** = a rule without `id`/`createdAt`; `name`,
`direction`, and `printerId` are always required, plus the per-direction fields
above. `printerCommand`/`printerStatus` are validated against the allowed sets;
`actionService` must look like `domain.service`; `actionData` may be a JSON object
or a JSON string (parsed) and must resolve to an object. `enabled` defaults to
`true`. Invalid input → `400` with an `error` message.

**Example (printer → HA):**

```json
{
  "name": "Lights off when print done",
  "direction": "printer_to_ha",
  "printerId": "printer-1",
  "printerStatus": "idle",
  "actionService": "switch.turn_off",
  "actionEntity": "switch.lab_lights",
  "actionData": "{ }"
}
```

**Example (HA → printer):**

```json
{
  "name": "Pause when door opens",
  "direction": "ha_to_printer",
  "printerId": "printer-1",
  "triggerEntity": "binary_sensor.lab_door",
  "triggerState": "on",
  "printerCommand": "pause"
}
```

**Response `201`:** the created rule (with `id` and `createdAt`).

#### `PUT /api/settings/home-assistant/rules/:id`

Updates a rule. A bare `{ "enabled": boolean }` body toggles enablement; any other
body is re-validated as a full rule (same rules as `POST`). **Response `200`:** the
updated rule. `404` if the id is unknown.

#### `DELETE /api/settings/home-assistant/rules/:id`

Deletes a rule. **Response `204`**; `404` if the id is unknown.

## Sign-in settings (`/api/settings/oauth/:provider`)

Admin-only in the UI (client-side session guard, like
`/api/settings/integrations`). Stores each provider's OAuth config in
`app_settings` (`:provider` is `google`, `microsoft`, or `adfs`). `tenant` and
`authority` are Microsoft-only; they are accepted for any provider but ignored
where unused.

For Microsoft, two modes are supported:
- **Cloud (Entra ID):** leave `authority` blank and set `tenant` (a directory GUID,
  or `common`). Endpoints are `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/*`.
- **On-prem AD FS:** set `authority` to the AD FS base URL (the `/adfs` deep link,
  e.g. `https://sso.example.com/adfs`). Endpoints become `<authority>/oauth2/authorize`
  and `<authority>/oauth2/token`. `authority` takes precedence over `tenant`.

For `adfs`, `authority` is **required** (unlike Microsoft where it is optional) —
the provider is not considered configured without it, since all endpoints are
derived as `<authority>/oauth2/{authorize,token}`. `tenant` is ignored. The
registered callback path is `/api/auth/oauth2_redirect` (not the default
`/api/auth/adfs/callback` pattern). All config is stored in the database via
Settings → Sign-in → ADFS.

#### `GET /api/settings/oauth/:provider`

**Response `200`** — the client secret is **never** returned, only whether one
is stored:

```json
{
  "enabled": true,
  "clientId": "xxxx",
  "tenant": "00000000-0000-0000-0000-000000000000",
  "authority": "",
  "allowedDomains": ["school.edu"],
  "hasClientSecret": true
}
```

#### `PUT /api/settings/oauth/:provider`

**Request body:**

```json
{
  "enabled": true,
  "clientId": "xxxx",
  "clientSecret": "secret-value",
  "tenant": "00000000-0000-0000-0000-000000000000",
  "authority": "https://sso.example.com/adfs",
  "allowedDomains": ["school.edu"]
}
```

A blank/omitted `clientSecret` **keeps** the stored one (so the form can
round-trip without re-entering it); a non-empty value replaces it. Returns the
same redacted shape as `GET`.

**SSO providers are independent:** Google, Microsoft/AD FS, and SAML can each be
enabled at the same time. Saving one provider no longer disables the others — the
login screen shows one sign-in button per enabled provider.

## SSO configuration (`/api/settings/saml`)

Admin-only in the UI (client-side session guard, like `/api/settings/oauth`).
Stores the SAML SSO config in `app_settings` (`saml_sso`) and applies it on the
next sign-in with no restart. The IdP certificate is a **public** signing cert, so
it is returned in full (unlike the OAuth client secret).

#### `GET /api/settings/saml`

**Response `200`:**

```json
{
  "enabled": false,
  "idpEntityId": "https://idp.example.com",
  "idpSsoUrl": "https://idp.example.com/adfs/ls/",
  "idpCertificate": "-----BEGIN CERTIFICATE-----\n...",
  "spEntityId": "",
  "acsUrl": "",
  "autoProvisionUsers": false,
  "updatedAt": "2026-06-18T00:00:00.000Z",
  "defaultSpEntityId": "https://<origin>/api/auth/saml/metadata",
  "defaultAcsUrl": "https://<origin>/api/auth/saml/acs",
  "effectiveSpEntityId": "https://<origin>/api/auth/saml/metadata",
  "effectiveAcsUrl": "https://<origin>/api/auth/saml/acs"
}
```

`spEntityId`/`acsUrl` fall back to the origin-derived `default*` values (which the
metadata endpoint advertises) when left blank; `effective*` is the resolved value.

#### `PUT /api/settings/saml`

**Request body:**

```json
{
  "enabled": true,
  "idpEntityId": "https://idp.example.com",
  "idpSsoUrl": "https://idp.example.com/adfs/ls/",
  "idpCertificate": "-----BEGIN CERTIFICATE-----\n...",
  "spEntityId": "",
  "acsUrl": "",
  "autoProvisionUsers": false
}
```

Validates before saving: any provided URL must be absolute http(s) (`400`
otherwise); the certificate, if provided, must be a valid X.509 PEM (`400`
otherwise); enabling requires both an IdP SSO URL and certificate (`400`
otherwise). Stamps `updatedAt`, writes an audit log, and — when enabling —
disables the OAuth providers. Returns the same shape as `GET`.

#### `POST /api/settings/saml/test`

Validates the submitted (or, where blank, stored) `idpSsoUrl` + `idpCertificate`
and probes the IdP SSO URL for reachability (5 s timeout; any HTTP response counts
as reachable). Does **not** save.

**Request body** (optional — falls back to stored values):

```json
{ "idpSsoUrl": "https://idp.example.com/adfs/ls/", "idpCertificate": "-----BEGIN CERTIFICATE-----\n..." }
```

**Response `200`:**

```json
{
  "ok": true,
  "checks": [
    { "label": "IdP SSO URL is a valid http(s) URL", "ok": true },
    { "label": "IdP certificate is a valid X.509 certificate", "ok": true },
    { "label": "IdP SSO URL is reachable", "ok": true, "detail": "HTTP 200" }
  ]
}
```

## Operational endpoints

Unauthenticated infrastructure endpoints served by the `web` process, outside the
`/api` surface. Intended for orchestrators, load balancers, and monitoring — not
the application UI. See `monitoring/RUNBOOK.md` for response procedures.

#### `GET /healthz`

Liveness probe. Cheap and **database-independent** so a brief DB outage never
cascades into the container being killed (this backs the Docker `healthcheck`).
Always `200`:

```json
{ "ok": true }
```

#### `GET /readyz`

Readiness probe. Reports dependency health: the **database** is required (a
failure returns `503`), while **Redis** is optional — when `REDIS_URL` is set it
is reported, but a Redis outage is `degraded`, never failing readiness (the app
falls back to Postgres/in-memory). Use for load-balancer routing.

**Response `200` (ready):**

```json
{ "ok": true, "status": "ready", "checks": { "database": "ok", "redis": "ok" } }
```

**Response `503` (database unreachable):**

```json
{ "ok": false, "status": "unavailable", "checks": { "database": "error" } }
```

(`checks.redis` is present only when `REDIS_URL` is configured.)

#### `GET /metrics`

Prometheus exposition of the web tier's own request metrics
(`printfarm_web_http_requests_total`, `printfarm_web_http_request_duration_seconds`,
`printfarm_web_http_requests_in_flight`, `printfarm_web_resident_memory_bytes`,
`printfarm_web_start_time_seconds`). **Internal only** — nginx returns `404` for
`/metrics` on the public site; Prometheus scrapes `web:5173/metrics` directly
over the compose network. Carries no secrets. Distinct from the `exporter`
service, which exposes the print-farm *data* metrics (`printfarm_*`) from Postgres.

Every response (on all endpoints) carries an `X-Request-Id` header, echoed in the
server's access log line (`reqId`) for correlation; a client may supply its own
via the `X-Request-Id` request header.
