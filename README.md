# STEM Lab Print Farm

A print-farm management dashboard for monitoring 3D printers, queue requests, printer activity, and usage analytics from one local web app.

## Features

- dashboard for printer status, webcam previews, live job activity, drag-and-drop printer ordering, and bottom-right popup notifications
- printer detail pages with current job progress, temperatures, filament status, webcam refreshes, and role-based printer controls
- queue sync from a Google Sheet into PostgreSQL, with local printed status, queue history, and soft deletion for admin cleanup
- analytics backed by PostgreSQL for printer usage and queue activity
- optional public viewer mode that hides sensitive printer details and viewer profile UI
- role-aware access for admin, operator, and viewer accounts

## Stack

- `src/`: React, Vite, TypeScript, Tailwind, Radix UI, lucide icons, and Sonner toasts
- `server/`: lightweight Node API middleware used by the web container
- `poller/`: Python background service for printer status refresh and offline detection
- `db`: PostgreSQL
- `nginx`: reverse proxy in front of the app
- `docker-compose.yml`: full local stack for PostgreSQL, web, nginx, and poller

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

Use a long random `POSTGRES_PASSWORD` and set `APP_BASIC_AUTH_PASSWORD_SHA256` to the generated hash.

4. Start the full production-style stack:

```bash
docker compose up --build
```

5. Open the app:

```text
http://localhost:8080
```

The browser will prompt for the `APP_BASIC_AUTH_USERNAME` and matching password.

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
- `APP_BASIC_AUTH_USERNAME`
- `APP_BASIC_AUTH_PASSWORD_SHA256`
- `VITE_PUBLIC_VIEWER_MODE`
- `VITE_GOOGLE_SHEET_QUEUE_URL`
- `VITE_GOOGLE_FORM_URL`
- `PRINTER_POLL_INTERVAL_MS`
- `PRINTER_REQUEST_TIMEOUT_MS`
- `PRINTER_OFFLINE_GRACE_SECONDS`

The app container and poller derive their `DATABASE_URL` from the PostgreSQL values in `docker-compose.yml`.

`PRINTER_OFFLINE_GRACE_SECONDS` controls how long a printer must be unreachable before the poller sends an offline notification.

## Viewer Mode

Set `VITE_PUBLIC_VIEWER_MODE="true"` to start the app in public viewer mode.

In viewer mode:

- the app auto-enters the viewer session
- printer list responses redact sensitive connection fields
- sensitive printer details, including IP address, API key header state, and printer profile, are hidden
- the sidebar viewer profile UI is hidden
- viewer accounts can monitor jobs but cannot pause, resume, cancel, remove, or reorder printers

## Queue Behavior

- Queue jobs sync from `VITE_GOOGLE_SHEET_QUEUE_URL`.
- Only rows for the 3D print form type are shown in the queue.
- Marking a job as printed moves it from the active queue into history.
- Admin deletion is a soft delete so removed jobs do not reappear after the next Google Sheet sync.
- Operators can mark jobs as printed. Admins can delete queue and history jobs.

## Notifications

The app uses bottom-right popup notifications for operational feedback such as queue updates, dashboard order updates, printer status changes, and dashboard load/save errors.

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
