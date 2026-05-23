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

**Generate a password hash for auth:**
```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "your-password"
```

**Full stack — Kubernetes:**

All manifests live in `k8s/`. Apply with Kustomize or plain kubectl:
```bash
kubectl apply -k k8s/          # Kustomize (recommended)
kubectl apply -f k8s/          # plain kubectl (applies alphabetically)
```

Before applying, edit `k8s/secret.yaml` (fill in `CHANGE_ME` values) and `k8s/configmap.yaml` (set the Google Sheet/Form URLs).

Build and push the two custom images (only `web` and `poller` — nginx uses the upstream image directly):
```bash
# VITE_* build args are baked into the web bundle; keep them in sync with k8s/configmap.yaml
docker build \
  --build-arg VITE_PUBLIC_VIEWER_MODE=false \
  --build-arg VITE_GOOGLE_SHEET_QUEUE_URL=<your-url> \
  --build-arg VITE_GOOGLE_FORM_URL=<your-url> \
  -f Dockerfile.web -t stemlab-printfarm/web:latest .

docker build -f Dockerfile.poller -t stemlab-printfarm/poller:latest .

# Push to your registry, or load into a local cluster:
# kind:      kind load docker-image stemlab-printfarm/web:latest
# minikube:  minikube image load stemlab-printfarm/web:latest
# k3s:       k3s ctr images import <(docker save stemlab-printfarm/web:latest)
```

Useful runtime commands:
```bash
kubectl -n stemlab-printfarm get pods
kubectl -n stemlab-printfarm logs -f deployment/web
kubectl -n stemlab-printfarm logs -f deployment/poller
kubectl -n stemlab-printfarm get svc nginx   # check EXTERNAL-IP for LoadBalancer
```

## Architecture

Four services orchestrated via Docker Compose:

| Service | Tech | Role |
|---------|------|------|
| `web` | Node.js 20 | Serves React SPA from `/dist`, hosts all `/api/*` endpoints, proxies printer HTTP/webcam requests |
| `db` | PostgreSQL 16 | Stores printers, queue jobs, analytics, Discord webhooks |
| `poller` | Python 3.12 + psycopg | Polls each printer every `PRINTER_POLL_INTERVAL_MS` ms, upserts state into `db` |
| `nginx` | Nginx 1.27 | Reverse proxy on `HTTP_PORT` (default 8080), adds security headers |

**Request flow:**
```
Browser → nginx:8080 → Node web:5173
                              ├── static files (React SPA)
                              ├── /api/printers       → PostgreSQL
                              ├── /api/queue          → Google Sheets CSV → PostgreSQL → Discord webhooks
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

**Queue sync:** `/api/queue` fetches the Google Sheet as CSV, upserts rows to `queue_jobs`, and only surfaces rows whose form type is `สั่งพิมพ์งาน 3D Print`. Marking a job printed sets `printed_status = 1`. Admin deletion is a soft delete (`deleted_at`) so deleted jobs never reappear after re-sync. Resetting the queue only clears `printed_status` for non-deleted rows. Operators can mark jobs printed; only admins can delete.

**Printer polling:** The Python poller queries all active printers from PostgreSQL and applies an offline grace period (`PRINTER_OFFLINE_GRACE_SECONDS`, default 30 s) before marking a printer offline. Supports three printer profiles: generic (HTTP reachability ping), Snapmaker U1 (Moonraker HTTP API), and Bambu Lab A1 Mini. The Bambu profile is the exception to the HTTP model — it holds a persistent MQTT-over-TLS connection per printer (port 8883, user `bblp`, password = the printer's LAN access code stored in `api_key_header`). It requires the device **serial** (stored in the `serial` column): Bambu's broker only authorizes a subscription to the printer's exact `device/<serial>/report` topic — a wildcard subscription gets the client disconnected — and an idle printer stays silent until sent a `pushall` request on `device/<serial>/request`, so the poller pushalls on connect and when its cached data goes stale. The printer must be in LAN Mode. Pause/resume/cancel are not HTTP-proxied for Bambu — the web server publishes them as MQTT commands to `device/<serial>/request` (via `POST /api/printers/:id/command`; `mqtt` is a web runtime dep installed in `Dockerfile.web`). The webcam snapshot still does not work (proprietary camera stream). Note: recreating only the `web` container can leave nginx pointing at its old IP (502) — restart nginx or rebuild all services.

**Viewer mode:** When `VITE_PUBLIC_VIEWER_MODE="true"`, the app auto-enters the viewer session, printer list responses server-side redact sensitive connection fields (IP, API key, profile), and viewers cannot pause/resume/cancel/reorder printers.

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
