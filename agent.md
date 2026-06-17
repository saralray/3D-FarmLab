# Agent Notes

Use this file to document project-specific instructions for coding agents working in this repository.

## Project

3D-FarmForge is a print-farm management dashboard built with React, Vite, PostgreSQL, and a Python printer poller.

## Project Idea

This project helps a STEM lab manage multiple 3D printers from one dashboard. It gives staff a central place to monitor printer status, view webcam previews, track active and past print jobs, sync the print queue from a Google Sheet, and review usage analytics. The goal is to make print-farm operations easier to scan, update, and audit while supporting a public viewer mode that hides sensitive printer details.

Main parts:

- `src/`: React/Vite frontend.
- `server/`: lightweight Node API middleware used by the web container.
- `poller/`: Python background service for printer status refresh.
- `nginx/`: reverse proxy configuration.
- `docker-compose.yml`: local full-stack runtime with PostgreSQL, web, nginx, and poller.

## Operational Behavior

- Queue jobs sync from the Google Sheet URL configured by an admin in Settings → Integrations (stored in the DB) into PostgreSQL, and only show rows whose form type is `สั่งพิมพ์งาน 3D Print`.
- Marking a queue job as printed sets `printed_status = 1`, moving it from the active queue into history.
- Admin queue deletion is a soft delete using `deleted_at`; this prevents deleted Google Sheet rows from reappearing on the next sync.
- Resetting the queue only clears `printed_status` for non-deleted 3D print queue rows; deleted jobs must stay hidden and should not reappear after reset.
- Queue operators can mark active jobs as printed. Only admins can delete queue or history jobs.
- Numeric printer and analytics values shown in the frontend should be formatted with no more than two decimal places.

## Run The Project

For the full local stack:

```bash
cp .env.example .env
docker compose up --build
```

Then open:

```text
http://localhost:5173
```

Review `.env` before running. It controls PostgreSQL settings, viewer mode, and printer polling behavior.

## Run Dev

For frontend-only Vite development:

```bash
npm install
npm run dev
```

Other available npm scripts:

```bash
npm run build
npm run preview
```

Use Docker Compose when you need PostgreSQL, the Node middleware, nginx, and the Python poller running together.

## Test The Project

There is currently no dedicated `npm test` script in `package.json`.

For frontend validation, run:

```bash
npm run build
```

For a full-stack smoke test, run:

```bash
docker compose up --build
```

Then verify:

- The app loads at `http://localhost:5173`.
- Dashboard, Queue, Analytics, Settings, and printer detail views render without console errors.
- PostgreSQL starts successfully and the web service can connect to it.
- The poller service starts and uses the expected printer polling environment variables.
- Public viewer mode still redacts sensitive printer connection fields when `VITE_PUBLIC_VIEWER_MODE="true"`.

When changing Python poller behavior, also run any focused manual checks needed for printer status polling, offline grace timing, and notification behavior.

## Guidelines

- Prefer existing project patterns before introducing new abstractions.
- Keep changes scoped to the requested task.
- Run relevant checks before handing work back when practical.
- Do not commit `.env`; use `.env.example` for documented defaults.
- Keep sensitive printer connection details out of public viewer flows.
- Treat `VITE_PUBLIC_VIEWER_MODE="true"` as a privacy-focused mode where printer list responses should redact sensitive connection fields.
- Keep frontend changes consistent with the existing React, Vite, Tailwind, Radix, MUI, and lucide dependency stack.
- Prefer Docker Compose for validating full-stack behavior and npm scripts for frontend-only checks.
- When changing poller or database behavior, verify the interaction with `docker-compose.yml` environment variables.

## Code Style

- Use TypeScript and React function components for frontend code in `src/app`.
- Keep page-level views in `src/app/pages`, shared UI in `src/app/components`, reusable helpers in `src/app/lib`, and shared types in `src/app/types.ts`.
- Prefer existing UI primitives from `src/app/components/ui` before adding new component patterns.
- Use Tailwind utility classes and existing theme CSS variables for styling; avoid hardcoded one-off colors when a theme token already exists.
- Use `lucide-react` icons for interface actions when an appropriate icon exists.
- Keep API access in focused helper modules such as `printersApi.ts`, `queueApi.ts`, and `notificationsApi.ts` instead of embedding fetch logic directly in pages.
- Keep environment-dependent behavior behind existing runtime config helpers.
- In server and poller code, keep database and environment handling explicit and compatible with the Docker Compose service names and variables.
- Use clear names for printer, queue, job, and analytics concepts so operational behavior is easy to audit.
- Avoid broad refactors unless they directly support the requested change.
