# STEM Lab Print Farm System

A print-farm management dashboard for monitoring 3D printers, queue requests, printer activity, and usage analytics from one local web app.

## Features

- dashboard for printer status, webcam previews, live job activity, drag-and-drop printer ordering, and bottom-right popup notifications
- printer detail pages with current job progress, nozzle/bed temperatures and targets, print-time tracking, filament status, webcam refreshes, drag-rearrangeable cards per profile, and role-based printer controls
- multi-profile printer support: generic HTTP printers, Snapmaker U1 (Moonraker), and Bambu Lab A1 Mini (MQTT over TLS)
- per-printer controls: pause/resume/cancel, temperature setpoints for multiple nozzles and the bed, manual jog/motion commands, and persisted chamber light state
- queue sync from a Google Sheet into PostgreSQL, with local printed status, queue history, and soft deletion for admin cleanup
- Discord webhook notifications for queue and printer events, managed in-app
- analytics backed by PostgreSQL for printer usage and queue activity
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

3. Set production secrets in `.env`.

Generate the Basic Auth password hash with:

```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "your-password"
```

Use a long random `POSTGRES_PASSWORD`.

4. Start the full production-style stack:

```bash
docker compose up --build
```

5. Open the app:

```text
http://localhost:8080
```

The app opens directly in the browser and uses its in-app login screen for restricted views.

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

The poller and web API support three printer profiles, selected per printer:

- **generic** — HTTP reachability ping for basic online/offline status.
- **Snapmaker U1** — polled over the Moonraker HTTP API; supports temperature, motion, and chamber light control.
- **Bambu Lab A1 Mini** — holds a persistent MQTT-over-TLS connection (port 8883). Requires the device **serial**, the LAN access code, and LAN Mode enabled. Pause/resume/cancel are sent as MQTT commands; the chamber webcam is captured as still snapshots over a raw TLS socket (port 6000, requires LAN Mode Liveview).

## Queue Behavior

- Queue jobs sync from the Google Sheet configured by an admin in Settings → Integrations (stored in the DB).
- Only rows for the 3D print form type are shown in the queue.
- Marking a job as printed moves it from the active queue into history.
- Admin deletion is a soft delete so removed jobs do not reappear after the next Google Sheet sync.
- Operators can mark jobs as printed. Admins can delete queue and history jobs.

## Monitoring (Prometheus + Grafana)

The stack ships a read-only **exporter** and a **Prometheus** server so you can
graph and alert on print-farm activity in your own Grafana.

- The `exporter` service reads PostgreSQL on every scrape and exposes metrics
  under the `printfarm_*` namespace on `:9180/metrics`. It is internal only (not
  proxied through nginx), so metrics never appear on the public site.
- The `prometheus` service scrapes the exporter every 15s and stores the time
  series. It is published on `PROMETHEUS_PORT` (default 9090).

Metrics include per-printer status, nozzle/bed temperature, progress, success
rate and lifetime print hours; fleet counts by status; cumulative and today's
completed/failed jobs, print hours and filament grams; and queue depth. (No
connection secrets — IP, API key, serial — are ever exposed as metrics.)

**Connect your Grafana** (it runs separately):

- **Provision it (recommended):** mount the datasource file into your Grafana at
  `/etc/grafana/provisioning/datasources/` and restart Grafana — e.g. add to your
  Grafana's `docker run`/compose:

  ```bash
  -v /path/to/monitoring/grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro
  ```

  Edit `url` in `monitoring/grafana/provisioning/datasources/prometheus.yml`
  first: use `http://prometheus:9090` if Grafana shares this Docker/Kubernetes
  network, or `http://<this-host>:9090` (the published `PROMETHEUS_PORT`) if it
  runs on another host.

- **Or add it in the UI:** Connections → Data sources → add **Prometheus** with
  the same URL.

Then import `monitoring/grafana-dashboard.json` (Dashboards → New → Import) and
pick the **Print Farm Prometheus** data source when prompted.

Prometheus only retains data from when it started scraping, so analytics from
before it was deployed are not backfilled.

## Kubernetes Deployment

This repo is designed to be forked and deployed by anyone — **no secrets or
deployment-specific URLs are committed**. On every push to `main`, GitHub
Actions builds the images and pushes them to Docker Hub; deploying them to a
cluster is a manual `kubectl` step (below).

### One-time setup — GitHub Actions (build & push)

Configure these in your repo under **Settings → Secrets and variables →
Actions**.

**Secrets** (encrypted, masked in logs):

| Name | Purpose |
|------|---------|
| `DOCKERHUB_USERNAME` | Username used to push images; also the K8s image prefix |
| `DOCKERHUB_TOKEN` | Docker Hub access token for that user |

The Google Sheet/Form URLs are **not** repo secrets — admins configure them at
runtime in Settings → Integrations (stored in the DB).

**Variables** (plain text):

| Name | Default | Purpose |
|------|---------|---------|
| `PUBLIC_VIEWER_MODE` | `false` | Set to `true` to ship a public viewer build |

### One-time setup — cluster

The cluster needs a `printfarm-secret` Secret holding the database credentials.
The build workflow does **not** create it (the values never enter the repo
or workflow). Create it once, with strong random values:

```bash
kubectl create namespace printfarm

# Use a URL-safe alphabet (hex) so the password drops into DATABASE_URL
# without needing URL-encoding. base64 includes '/' and '+', which break
# postgresql:// parsing and lead to SASL auth errors at runtime.
PG_PASS="$(openssl rand -hex 32)"
kubectl -n printfarm create secret generic printfarm-secret \
  --from-literal=POSTGRES_DB=printfarm \
  --from-literal=POSTGRES_USER=printfarm_app \
  --from-literal=POSTGRES_PASSWORD="$PG_PASS" \
  --from-literal=DATABASE_URL="postgresql://printfarm_app:$PG_PASS@postgres:5432/printfarm"
```

`k8s/examples/secret.example.yaml` documents the same shape if you'd rather
template it.

After that, every push to `main` builds and pushes the images to Docker Hub
automatically; deploy them to your cluster with the manual step below.

### Manual deploy

Deploying to the cluster is manual. With the images built and pushed (by the
workflow above, or by hand), rewrite the placeholder image prefix and apply the
manifests:

```bash
export IMAGE_PREFIX=your-dockerhub-username

# (build & push your four images as in deploy.yml…)

kubectl apply -f k8s/namespace.yaml

# Runtime config — never commit a filled-in copy:
kubectl -n printfarm create configmap printfarm-config \
  --from-literal=VITE_PUBLIC_VIEWER_MODE=false \
  --dry-run=client -o yaml | kubectl apply -f -

# Apply with your image prefix substituted:
for f in k8s/*.yaml; do
  sed "s|saralray/|${IMAGE_PREFIX}/|g" "$f"; echo "---"
done | kubectl apply -f -
```

The `printfarm-secret` (see above) must already exist.

## Notifications

The app uses bottom-right popup notifications for operational feedback such as queue updates, dashboard order updates, printer status changes, and dashboard load/save errors.

It also supports Discord webhook notifications for queue and printer events. Admins manage webhooks in-app (stored in PostgreSQL via `/api/notifications`).

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
- The deployed stack adds server-side Basic Auth in front of the app and APIs. The in-app browser auth still controls UI roles after the outer Basic Auth gate.
- Keep sensitive printer connection details out of public viewer flows.
- Put TLS in front of nginx for public deployments, either with a cloud/load-balancer certificate or a local TLS reverse proxy.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
