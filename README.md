# 3D-FarmLab

A print-farm management dashboard for monitoring 3D printers, queue requests, printer activity, and usage analytics from one local web app.

## Features

- dashboard for printer status, webcam previews, live job activity, drag-and-drop printer ordering, and in-app notification bell for printer events
- printer detail pages with current job progress, nozzle/bed temperatures and targets, print-time tracking, filament status, webcam refreshes, drag-rearrangeable cards per profile, and role-based printer controls
- multi-profile printer support: generic HTTP printers, Snapmaker U1 (Moonraker), Bambu Lab A1 Mini (MQTT + TLS camera), and Bambu H2 series (MQTT + RTSP-over-TLS live camera with per-printer ffmpeg hub)
- per-printer controls: pause/resume/cancel, temperature setpoints for multiple nozzles and the bed, manual jog/motion commands, and persisted chamber light state
- in-app print request form at `/request` (public, no login required) — students submit jobs with an STL/3MF/OBJ/STEP/G-code/ZIP upload; files are stored directly in PostgreSQL and trigger Discord notifications
- queue management: active jobs, history, printed status, soft deletion, and model file download; operators can mark jobs printed, admins can delete
- Discord webhook notifications for queue and printer events, managed in-app
- in-app notification bell surfacing printer status events (offline, online, errors) without leaving the dashboard
- manager access request system: non-admin accounts can request elevated access; admins approve or deny via the notification bell
- analytics backed by PostgreSQL for printer usage and queue activity
- branding settings with custom logo, colors, and background image upload
- OctoPrint-compatible slicer proxy so slicers (Orca/PrusaSlicer/Cura) can push files directly to a printer; API keys with permission scopes
- programmatic `/api/v1` REST API for external integrations, gated by API keys
- optional public viewer mode that hides sensitive printer details and viewer profile UI
- role-aware access for admin, operator, and viewer accounts

## Stack

- `src/`: React, Vite, TypeScript, Tailwind, Radix UI, lucide icons, and Sonner toasts
- `server/`: lightweight Node API middleware used by the web container
- `poller/`: Python background service for printer status refresh and offline detection
- `exporter/`: read-only Prometheus exporter that publishes print-farm metrics from PostgreSQL
- `db`: PostgreSQL
- `nginx`: reverse proxy in front of the app
- `monitoring/`: Prometheus scrape config and an importable Grafana dashboard
- `docker-compose.yml`: full local stack for PostgreSQL, web, nginx, poller, exporter, and Prometheus

## Quick Start

1. Copy env defaults:

```bash
cp .env.example .env
```

2. Review the values in `.env`.

3. Set production secrets in `.env`. Use a long random `POSTGRES_PASSWORD`.

4. Start the full production-style stack:

```bash
docker compose up --build
```

5. Open the app:

```text
http://localhost:8080
```

On first run, open `/admin` to complete the one-time admin password setup. The app uses its in-app login screen for restricted views; there is no shipped default password.

## Development

For frontend-only Vite development:

```bash
npm install
npm run dev
```

Available npm scripts:

```bash
npm run build
npm run preview
```

Use Docker Compose when you need PostgreSQL, the Node middleware, nginx, and the Python poller running together.

## Environment

Key settings in `.env.example`:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `HTTP_PORT`
- `VITE_PUBLIC_VIEWER_MODE`
- `PRINTER_POLL_INTERVAL_MS`
- `PRINTER_REQUEST_TIMEOUT_MS`
- `PRINTER_OFFLINE_GRACE_SECONDS`
- `PROMETHEUS_PORT` — host port for the Prometheus server (default 9090); use it as the Grafana datasource URL
- `EXPORTER_PORT` — internal metrics-exporter port (default 9180)

The app container, poller, and exporter derive their `DATABASE_URL` from the PostgreSQL values in `docker-compose.yml`.

`PRINTER_OFFLINE_GRACE_SECONDS` controls how long a printer must be unreachable before the poller sends an offline notification.

## Viewer Mode

Set `VITE_PUBLIC_VIEWER_MODE="true"` to start the app in public viewer mode.

In viewer mode:

- the app auto-enters the viewer session
- printer list responses redact sensitive connection fields
- sensitive printer details, including IP address, API key header state, and printer profile, are hidden
- the sidebar viewer profile UI is hidden
- viewer accounts can monitor jobs but cannot pause, resume, cancel, remove, or reorder printers

## Printer Profiles

The poller and web API support these printer profiles, selected per printer:

- **generic** — HTTP reachability ping for basic online/offline status.
- **Snapmaker U1** — polled over the Moonraker HTTP API; supports temperature, motion, and chamber light control. Webcam served as MJPEG stream.
- **Bambu Lab A1 Mini** — persistent MQTT-over-TLS connection (port 8883). Requires the device serial, LAN access code, and LAN Mode enabled. Pause/resume/cancel are MQTT commands; chamber webcam is captured as still snapshots over a raw TLS socket (port 6000, requires LAN Mode Liveview).
- **Bambu H2 series** (H2S, H2D) — same MQTT connection as A1 Mini, but the camera is an RTSP-over-TLS stream (port 322). The web server runs a per-printer ffmpeg hub that holds one persistent connection and fans JPEG frames out to all viewers, with automatic stall detection and restart. This enables real-time live MJPEG view alongside still snapshots.

## Print Request Form

Students submit print jobs at `/request` — a public route that requires no login. The form accepts:

- contact info and job details
- file upload (STL, 3MF, OBJ, STEP, G-code, ZIP; up to 50 MB)

Submitted files are stored directly in PostgreSQL and appear in the staff queue immediately. On submission the server fires Discord notifications to any configured webhooks. Staff download files from the queue view.

## Queue Behavior

- Print requests come from the in-app form at `/request`. There is no Google Sheet sync.
- Only rows for the 3D print form type are shown in the queue.
- Marking a job as printed moves it from the active queue into history.
- Admin deletion is a soft delete.
- Operators can mark jobs as printed. Admins can delete queue and history jobs.
- Queue jobs and their model files can be migrated between instances via the `/api/v1/queue/export` and `/api/v1/queue/import` endpoints.

## Notifications

### In-app notification bell

The notification bell in the header surfaces real-time printer events (offline, online, errors) without leaving the dashboard. It also shows pending manager access requests for admins to approve or deny.

### Discord webhooks

Discord webhook notifications fire for queue submissions and printer events. Admins manage webhooks in Settings → Notifications (stored in PostgreSQL via `/api/notifications`).

## Slicer Proxy

The `slicer-proxy` service emulates the OctoPrint HTTP API so slicers (Orca, PrusaSlicer, Cura — host type "OctoPrint") can push sliced files to a printer and auto-start it.

- Base URL per printer: `http://<domain>/printers/<printerId>`
- Authenticate with `X-Api-Key`; mint keys in Settings → API Keys (admin only)
- Keys carry permission scopes (`slicer_upload`, `printfarm_manage`); the upload path requires `slicer_upload`
- Dispatch by profile: Snapmaker U1 → Moonraker upload with `print=true`; Bambu → FTPS upload + MQTT `project_file` command

Opening the slicer's "Device" tab redirects to the dashboard printer-management page and grants an operator session.

## API Keys and `/api/v1`

API keys are minted in Settings → API Keys and stored as sha256 hashes (plaintext shown once). A key with the `printfarm_manage` scope gives full read/write access to the `/api/v1` programmatic API:

- `GET /api/v1` — list all resources
- **Printers**: list, get, upsert, delete, send commands (Bambu MQTT), and raw proxy passthrough to printer hardware (`/printers/:id/proxy/<path>`)
- **Queue**: list, upsert, mark printed, delete, reset, bulk delete, export/import for migration
- **Analytics**: daily rollups, reset
- **Notifications**: Discord webhook CRUD
- **Slicer keys**: list, mint, revoke
- **Audit logs**: read, append
- **Settings**: per-key app settings GET/PUT (branding, integrations, layouts)
- **Users**: staff account CRUD (list, create, delete, change password)
- **Admin credential**: get configured status, set/reset password hash, verify

Pass the key via `X-Api-Key` header or `Authorization: Bearer <key>`. Missing or invalid key returns 401; missing scope returns 403. See `API.md` for the full reference.

## Monitoring (Prometheus + Grafana)

The stack ships a read-only **exporter** and a **Prometheus** server so you can graph and alert on print-farm activity in your own Grafana.

- The `exporter` service reads PostgreSQL on every scrape and exposes metrics under the `printfarm_*` namespace on `:9180/metrics`. It is internal only (not proxied through nginx), so metrics never appear on the public site.
- The `prometheus` service scrapes the exporter every 15s and stores the time series. Nginx serves it under `/prometheus` on the main site.

Metrics include per-printer status, nozzle/bed temperature, progress, success rate and lifetime print hours; fleet counts by status; cumulative and today's completed/failed jobs, print hours and filament grams; and queue depth. Connection secrets (IP, API key, serial) are never emitted as metrics.

**Connect your Grafana** (it runs separately):

- **Provision it (recommended):** mount the datasource file into your Grafana at `/etc/grafana/provisioning/datasources/` and restart:

  ```bash
  -v /path/to/monitoring/grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro
  ```

  Edit `url` in `monitoring/grafana/provisioning/datasources/prometheus.yml` first: use `http://prometheus:9090/prometheus` if Grafana shares this Docker/Kubernetes network, or `http://<this-host>:HTTP_PORT/prometheus` if it runs on another host.

- **Or add it in the UI:** Connections → Data sources → add **Prometheus** with the same URL.

Then import `monitoring/grafana-dashboard.json` (Dashboards → New → Import) and pick the **Print Farm Prometheus** data source when prompted.

## Kubernetes Deployment

This repo is designed to be forked and deployed by anyone — **no secrets or deployment-specific URLs are committed**. On every push to `main`, GitHub Actions builds the images and pushes them to Docker Hub; deploying them to a cluster is a manual `kubectl` step (below).

### One-time setup — GitHub Actions (build & push)

Configure these in your repo under **Settings → Secrets and variables → Actions**.

**Secrets** (encrypted, masked in logs):

| Name | Purpose |
|------|---------|
| `DOCKERHUB_USERNAME` | Username used to push images; also the K8s image prefix |
| `DOCKERHUB_TOKEN` | Docker Hub access token for that user |

**Variables** (plain text):

| Name | Default | Purpose |
|------|---------|---------|
| `PUBLIC_VIEWER_MODE` | `false` | Set to `true` to ship a public viewer build |

### One-time setup — cluster

```bash
kubectl create namespace printfarm

PG_PASS="$(openssl rand -hex 32)"
kubectl -n printfarm create secret generic printfarm-secret \
  --from-literal=POSTGRES_DB=printfarm \
  --from-literal=POSTGRES_USER=printfarm_app \
  --from-literal=POSTGRES_PASSWORD="$PG_PASS" \
  --from-literal=DATABASE_URL="postgresql://printfarm_app:$PG_PASS@postgres:5432/printfarm"
```

`k8s/examples/secret.example.yaml` documents the same shape if you'd rather template it.

### Manual deploy

```bash
export IMAGE_PREFIX=your-dockerhub-username

kubectl apply -f k8s/namespace.yaml

kubectl -n printfarm create configmap printfarm-config \
  --from-literal=VITE_PUBLIC_VIEWER_MODE=false \
  --dry-run=client -o yaml | kubectl apply -f -

for f in k8s/*.yaml; do
  sed "s|saralray/|${IMAGE_PREFIX}/|g" "$f"; echo "---"
done | kubectl apply -f -
```

The `printfarm-secret` (see above) must already exist.

## Validation

There is no dedicated test script in `package.json`. For frontend validation, run:

```bash
npm run build
```

For a full-stack production smoke test, run:

```bash
docker compose up --build
```

Then verify the app loads at `http://localhost:8080`, `/healthz` returns `{"ok":true}`, and the dashboard, queue, analytics, settings, and printer detail views render without console errors.

## Notes

- `.env` is intentionally ignored by git and should not be committed.
- Put TLS in front of nginx for public deployments, either with a cloud/load-balancer certificate or a local TLS reverse proxy.
- Keep sensitive printer connection details out of public viewer flows.
- The `/request` print form is intentionally public (no login) so students can submit jobs without accounts.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
