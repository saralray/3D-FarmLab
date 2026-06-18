# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

STEM Lab Print Farm is a print-farm management dashboard for monitoring 3D printers, managing print queues, and tracking usage analytics. Staff see all printers from one dashboard; a public viewer mode hides sensitive printer details.

## Commands

**Frontend only (Vite dev server):**
```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # TypeScript validation + production build
npm run preview
```

**Full stack — Docker Compose (PostgreSQL + Node API + nginx + Python poller):**
```bash
cp .env.example .env   # first time only — review values
docker compose up --build
# App: http://localhost:8080   Health: http://localhost:8080/healthz
```

There is no `npm test`. Frontend validation = `npm run build`. Full-stack smoke test = `docker compose up --build`, then verify dashboard, queue, analytics, settings, and printer detail views render without console errors.

**Admin password:** not baked into the build. On first run, opening `/admin`
shows a one-time setup screen; the chosen password is hashed (sha256) and stored
server-side in `app_settings` (key `admin_credential`) via `/api/admin/credential`.
Admin login verifies against that endpoint; changing it later requires the current
password. There is no shipped default — `admin / "admin"` no longer exists.

## Architecture

Seven services orchestrated via Docker Compose:

| Service | Tech | Role |
|---------|------|------|
| `web` | Node.js 20 | Serves React SPA from `/dist`, hosts all `/api/*` endpoints, proxies printer HTTP/webcam requests |
| `db` | PostgreSQL 16 | Stores printers, queue jobs, analytics, Discord webhooks |
| `poller` | Python 3.12 + psycopg | Polls each printer every `PRINTER_POLL_INTERVAL_MS` ms, upserts state into `db` |
| `slicer-proxy` | Node.js 20 | OctoPrint-compatible upload endpoint on `SLICER_PROXY_PORT` (default 8091); accepts sliced files from a slicer and auto-starts the print on the chosen printer. Authenticated with named API keys |
| `nginx` | Nginx 1.27 | Reverse proxy on `HTTP_PORT` (default 8080), adds security headers |
| `exporter` | Python 3.12 + prometheus-client | Read-only Prometheus exporter; serves `printfarm_*` metrics from `db` on `:9180/metrics` (internal only) |
| `prometheus` | Prometheus 2.55 | Scrapes `exporter`, stores the time series; not published on its own host port — nginx serves it under `/prometheus` on the main site (runs with `--web.route-prefix=/prometheus`) |

**Request flow:**
```
Browser → nginx:8080 → Node web:5173
                              ├── static files (React SPA)
                              ├── /api/printers       → PostgreSQL
                              ├── /api/queue          → in-app print-request form → PostgreSQL → Discord webhooks
                              ├── /api/analytics      → PostgreSQL
                              ├── /api/notifications  → PostgreSQL (Discord webhook CRUD)
                              ├── /__printer_proxy/*  → printer hardware HTTP
                              └── /__printer_webcam/* → printer webcam stream
```

**Frontend layout (`src/app/`):**
- `pages/` — full-page views (Dashboard, PrinterDetail, Queue, Analytics, Settings, Login)
- `components/` — shared UI; `components/ui/` holds Radix-based primitives — prefer these before adding new patterns
- `lib/` — API helper modules (`printersApi.ts`, `queueApi.ts`, `notificationsApi.ts`); keep fetch logic here, not in pages
- `contexts/` — `AuthContext` (login state + roles), `SidebarContext`
- `types.ts` — shared TypeScript types
- `routes.tsx` — React Router v7 route tree

## Key Operational Behaviors

**Print-request form (self-hosted):** Print requests come from an **in-app form** at the public route `/request` (`pages/PrintRequest.tsx`, outside `ProtectedRoute` — no login, matching how the old Google Form was open to students). The form posts `multipart/form-data` to **`POST /api/queue/submit`** (public, like the rest of the cookieless frontend `/api/*` surface); the server parses it with **busboy** (`parsePrintRequest`, a web runtime dep added in `Dockerfile.web`), and stores the **uploaded model file directly in Postgres** — `queue_jobs.file_content` (`bytea`), with `file_mime`/`file_size_bytes` — via `insertQueueSubmission`, rather than as an external link. Uploads are capped by `QUEUE_UPLOAD_MAX_BYTES` (default 50 MB); the matching nginx `location = /api/queue/submit` lifts the global 2 MB body cap to 60 MB and streams the upload through. Allowed extensions: STL/3MF/OBJ/STEP/G-code/ZIP. On submit the server fires the same Discord add-notification (`sendQueueAddedNotifications`) the Sheet sync used to. Submissions are stored with `form_type = สั่งพิมพ์งาน 3D Print` so they appear in the queue read path. Stored files are downloaded from **`GET /api/queue/:id/file`** (streams the bytea with a `Content-Disposition` attachment); the queue read query resolves `stlFileUrl` to that endpoint (and sets `hasFile`) when a file is stored. `GET /api/queue` is a **cheap DB read** (`listQueueData`); there is no longer any Google Sheet fetch, background sync loop, or `POST /api/queue/sync` — the old CSV pipeline was removed. Marking a job printed sets `printed_status = 1`. Admin deletion is a soft delete (`deleted_at`). Resetting the queue only clears `printed_status` for non-deleted rows. Operators can mark jobs printed; only admins can delete. (The legacy Google Form/Sheet URL fields in Settings → Integrations are retained as an optional external link, but no longer drive the queue.)

**Printer polling:** The Python poller queries all active printers from PostgreSQL and applies an offline grace period (`PRINTER_OFFLINE_GRACE_SECONDS`, default 30 s) before marking a printer offline. Supports three printer profiles: generic (HTTP reachability ping), Snapmaker U1 (Moonraker HTTP API), and Bambu Lab A1 Mini. The Bambu profile is the exception to the HTTP model — it holds a persistent MQTT-over-TLS connection per printer (port 8883, user `bblp`, password = the printer's LAN access code stored in `api_key_header`). It requires the device **serial** (stored in the `serial` column): Bambu's broker only authorizes a subscription to the printer's exact `device/<serial>/report` topic — a wildcard subscription gets the client disconnected — and an idle printer stays silent until sent a `pushall` request on `device/<serial>/request`, so the poller pushalls on connect and when its cached data goes stale. The printer must be in LAN Mode. Pause/resume/cancel are not HTTP-proxied for Bambu — the web server publishes them as MQTT commands to `device/<serial>/request` (via `POST /api/printers/:id/command`; `mqtt` is a web runtime dep installed in `Dockerfile.web`). The webcam is also not HTTP, and the two Bambu families use **different camera protocols**. The A1 Mini (A1/P1 class) chamber camera is a length-prefixed JPEG stream over a raw TLS socket on port 6000 (auth: user `bblp` + the LAN access code in `api_key_header`); `captureBambuSnapshot` in `server/app.js` connects to port 6000 and reads one frame. The H2 series (`bambulab_h2s`, `bambulab_h2d`, and `bambulab_h2c`, like the X1) instead exposes an **RTSP-over-TLS** stream on **port 322** (LIVE555 server, digest auth: `rtsps://bblp:<access code>@<ip>:322/streaming/live/1`); for those profiles (`BAMBU_RTSP_PROFILES`) the camera is served by the **camera hub** (`server/bambuCamera.js`), modeled on go2rtc/Bambuddy: because a Bambu camera only tolerates a couple of concurrent connections, the hub holds **one persistent `ffmpeg`** (installed in `Dockerfile.web`) per printer — low-latency H264→MJPEG transcode (`-fflags nobuffer -flags low_delay -analyzeduration 0`, scaled 1280-wide) — parses ffmpeg's `mpjpeg` output into discrete JPEG frames, and **fans those frames out to every live viewer** while reusing the latest frame for **still snapshots** (`snapshot.jpg`). So one camera connection feeds both the live view and all snapshots. A **health-check supervisor** (`supervise()` on a 4 s interval) restarts a feed whose frames stall (>12 s) or whose ffmpeg dies (exponential backoff 1→15 s), and shuts an idle feed (no viewers, no recent snapshot demand) down after 30 s. Per-camera health (`status`, `online`, `viewers`, `lastFrameAgeMs`, `restarts`, `lastError`) is exposed read-only at **`GET /api/printers/:id/camera/health`** (and all cameras at `GET /api/cameras/health`); the detail page polls it to drive a Live/Reconnecting badge (`CameraHealthBadge`). The live MJPEG stream is at `/__printer_webcam/:id/stream.mjpg` (`addCameraViewer`, `multipart/x-mixed-replace`, slow viewers get frames dropped rather than stalling the feed) — the detail page renders it in an `<img>` for real-time view (`printerSupportsLiveMjpeg`). The A1 Mini (port-6000, ~one slow frame per connection) stays snapshot-only via `captureBambuSnapshot`. For all Bambu the printer must have **LAN Mode Liveview** enabled. Note: recreating only the `web` container can leave nginx pointing at its old IP (502) — restart nginx or rebuild all services.

**Bambu filament usage:** Bambu's MQTT report carries no live "grams used" field, so per-job filament usage is resolved from three sources, best first (modeled on maziggy/bambuddy): (1) the slicer's exact 3MF estimate — total plate weight from `Metadata/slice_info.config` — recorded in `slicer_print_estimates` keyed by `(printer_id, subtask_name)`. The slicer-proxy writes this when *it* starts a print (`extractFilamentGramsFrom3mf` in `slicer-proxy/parse3mf.js`); the poller additionally fetches the active print's `.3mf` **directly off the printer over implicit FTPS** (port 990, `bblp` + LAN access code) and records the same row, so a print started from Bambu Studio / the SD card / Handy — never routed through the proxy — still gets the exact figure (`ensure_bambu_slicer_estimate` → `parse_3mf_filament_grams` in `poller/printer_status_poller.py`, gated to active prints with no estimate yet, 5-min retry cool-down per job, and **skipped for the H2 series** whose firmware blocks FTP file access, `BAMBU_FTP_BLOCKED_PROFILES`). The stored grams are scaled by live progress (`apply_slicer_filament_estimate`). (2) When no 3MF estimate exists, the **AMS remaining-grams delta** since print start (`update_bambu_filament_used`) — low-resolution (remain% moves in ~10 g steps), RFID spools only. This whole pipeline only feeds the existing `slicer_print_estimates` table + `currentJob.filamentUsed`, so analytics/Discord/exporter need no change.

**Viewer mode:** When `VITE_PUBLIC_VIEWER_MODE="true"`, the app auto-enters the viewer session, printer list responses server-side redact sensitive connection fields (IP, API key, profile), and viewers cannot pause/resume/cancel/reorder printers.

**Metrics / monitoring:** The `exporter` service (`exporter/printfarm_exporter.py`, a `prometheus_client` custom collector) exposes the print-farm data as Prometheus metrics under the `printfarm_*` namespace on `:9180/metrics`. It is read-only, queries PostgreSQL fresh on each scrape (printers, `analytics_daily`, `queue_jobs`), never creates schema, and reports a database failure as `printfarm_scrape_success 0` instead of crashing. Cumulative job/print-time/filament series are counters (`_total`); per-printer temps/progress/status and queue depth are gauges. The `prometheus` service scrapes it and retains the series for an external Grafana. Prometheus is **not** published on its own host port; nginx serves it under `/prometheus` on the main site (Prometheus runs with `--web.route-prefix=/prometheus`, so its own `/metrics` is at `/prometheus/metrics`). Point Grafana at `http://<host>:HTTP_PORT/prometheus` (or, on the same Docker network, `http://prometheus:9090/prometheus`; provision the datasource from `monitoring/grafana/provisioning/datasources/prometheus.yml`, mounted into Grafana's `/etc/grafana/provisioning/datasources/`) and import `monitoring/grafana-dashboard.json`. Note this puts the Prometheus UI/API on the public `:8080` site — gate `/prometheus` by network or auth if the dashboard is internet-facing. The `exporter` itself is still **not** proxied through nginx, so raw `printfarm_*` metrics are only reachable internally. Connection secrets (IP, API key, serial) are never emitted as metrics.

**Slicer upload:** The `slicer-proxy` service (`slicer-proxy/index.js`) emulates the OctoPrint HTTP API so a slicer (Orca / PrusaSlicer / Cura, host type "OctoPrint") can push a sliced file to a printer and auto-start it. nginx routes `/printers/` on the main site to this service, so the slicer points at a per-printer base URL on the **same domain as the dashboard** — `http://<domain>/printers/<printerId>` (the proxy is not published on its own host port; `SLICER_PROXY_PORT` is just the container's internal listen port) — and authenticates with the `X-Api-Key` header. One key reaches any printer; the printer is selected by the base URL path. Keys are minted/revoked in Settings → API Keys (admin only), stored in `slicer_api_keys` as a **sha256 hash only** (plaintext shown once at creation), and the management CRUD lives on the `web` server (`/api/slicer-keys`); the proxy validates by hashing the presented key and stamps `last_used_at`. Each key carries a `permissions` scope array (`slicer_upload`, `printfarm_manage`) chosen at creation; the proxy upload path requires `slicer_upload` (403 otherwise). Legacy keys (pre-scopes) backfill to both scopes so existing integrations keep working. Dispatch is by printer profile: `snapmaker_u1` → Moonraker `POST /server/files/upload` with `print=true`; `bambulab_a1_mini` → upload the `.3mf` over implicit FTPS (port 990, user `bblp`, pass = LAN access code) then publish an MQTT `project_file` command to `device/<serial>/request` (reuses the Bambu MQTT pattern from `server/app.js`). The Bambu `project_file` params and file URL are device-specific and need live tuning. The proxy is reachable through nginx at `/printers/` on the main site; that location lifts nginx's `client_max_body_size` cap and disables request buffering so large uploads stream straight through. Opening the slicer's "Device" tab (a GET on the base URL) 302-redirects to the dashboard's printer-management page with `?slicer_access=operator`, which the frontend turns into an operator session (pause/resume/cancel). Because the endpoint now lives on the public site, the `X-Api-Key` is the only guard — keep keys scoped and revoke unused ones. The proxy has no published host port; nginx reaches it over the internal compose network (`slicer-proxy:8091`). Connection secrets are read from the DB inside the container and never returned to the slicer.

**Programmatic data API (`/api/v1`):** A versioned, API-key-gated API over the print-farm's data, served by the `web` server (`handleDataApi` in `server/app.js`) and entirely separate from the cookieless frontend `/api/*` endpoints (which stay unauthenticated). Keys are the **same `slicer_api_keys`** minted in Settings → API Keys (sha256-hashed); a caller passes one via the `X-Api-Key` header or `Authorization: Bearer <key>`. A key must carry the `printfarm_manage` permission scope to reach this API (missing scope → 403); a key so scoped grants **full read/write**; usage stamps `last_used_at` and every mutation is written to the audit log with `source = 'api'`. Because the key is the guard, printer connection details (`url`, `ipAddress`, `apiKeyHeader`, `serial` — needed to reach each printer's hardware/webcam) are **not** redacted here, even in public viewer mode: the list path calls `listPrinters(true)` to force the full records, matching the single-printer `getPrinterById` read (unlike the public-viewer frontend `/api/printers` path, which still redacts). Each `printers` entry also carries its `profile` and per-printer webcam reachability so a client can resolve `GET /printers/:id/camera/{snapshot,stream,health}` for any profile. The intent is **full UI/API parity** — an external print-farm manager (Portainer-style) can drive every dashboard feature through `/api/v1`. Resources (`GET /api/v1` lists them): `printers` (list/get/upsert/delete, plus `POST /printers/:id/command` for Bambu, and `ALL /printers/:id/proxy/<path...>` — a raw HTTP passthrough to the printer hardware API (e.g. Moonraker on a Snapmaker U1) that reuses the same `handlePrinterProxy` backing `/__printer_proxy/`, giving full non-Bambu control parity: pause/resume/cancel via `printer/print/<cmd>`, gcode scripts, LED, temps, fans, filament macros; non-GET proxy calls are audited), `queue` (list stored jobs/upsert/`:id/printed`/delete/`reset` — GET does **not** trigger a Google Sheet sync — plus the host→host **migration** routes: `GET /queue/export[?includePrinted=true][?ids=a,b,c]` returns a metadata-only job manifest (pass `ids` to migrate only a selection rather than the whole queue), `POST /queue/import` recreates rows from a manifest preserving ids/printedStatus, `GET`/`PUT /queue/:id/file` stream each job's model bytes across — file bytes move per-job rather than as base64 in the manifest, and the matching nginx `~ ^/api/v1/queue/[^/]+/file$` location lifts the 2 MB body cap to 60 MB for the upload — and `POST /queue/delete { ids: [...] }` bulk soft-deletes the source rows after a migration ("migrate selection, then remove the source queue")), `analytics` (daily rollups + `reset`), `notifications` (Discord webhook CRUD), `slicer-keys` (list/mint/revoke; plaintext returned once), `audit-logs` (read/append), `settings/<key>` (app_settings GET/PUT — this is also how branding, integrations, and analytics/printer-card layouts are managed, since each is just an app_settings key), `users` (staff-account CRUD: list/create/`:id` delete/`:id/password`/`verify` — mirrors the frontend `/api/users`, but its list/create responses include each account's sha256 `passwordHash` since the key is the guard here, like `admin-credential` — unlike the cookieless frontend `/api/users`, which redacts hashes; the primary `admin` account is separate), and `admin-credential` (GET `{ configured }` / PUT to set or reset the admin password hash / POST `/verify` — the key is the guard, so unlike the first-run-only public endpoint a `printfarm_manage` key may reset it outright). A missing/invalid key returns 401.

**Numeric formatting:** All printer and analytics values shown in the frontend must use no more than two decimal places.

## Code Style

- React function components + TypeScript in `src/app`; keep page views in `pages/`, shared UI in `components/`, helpers in `lib/`, types in `types.ts`
- Tailwind utility classes + existing theme CSS variables for styling — avoid one-off hardcoded colors when a theme token exists
- `lucide-react` icons for interface actions
- Keep environment-dependent behavior behind runtime config helpers (`lib/runtimeConfig.ts`)
- In `server/` and `poller/`, keep database and env handling explicit and compatible with Docker Compose service names
- Numeric values: format to ≤ 2 decimal places in the frontend

## Guidelines

- Prefer Docker Compose for full-stack validation; npm scripts for frontend-only checks
- When changing poller or database behavior, verify interaction with `docker-compose.yml` env vars
- Do not commit `.env`; document defaults in `.env.example`
- Keep sensitive printer connection details out of public viewer flows
- Prefer existing project patterns before introducing new abstractions; scope changes to the requested task
- **Keep `API.md` in sync:** whenever you add, remove, or change any `/api/v1` endpoint or `/api/*` endpoint in `server/app.js` (route path, method, request/response shape, auth requirement, or query-param behavior), update `API.md` in the same task before reporting the work as done. If you only touch frontend files and no server routes change, skip this step.
