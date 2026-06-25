# Go web/api port — roadmap

Porting the Node `web` service (`server/app.js` ~5.5k lines + `server/postgres.js`
~2.1k lines + support modules) to Go (`go-services/cmd/web`). The exporter and
poller are already ported and verified. This is a multi-session effort; the Node
service stays the live `web` container until the Go one reaches full parity — the
Go server is brought up on a **separate port** for parity testing and only swapped
into compose at the end.

## Verification strategy

Run Go `web` on an alt port against the live DB; for each endpoint group, diff Go
vs Node JSON (status, headers, body) with the same requests. `API.md` is the
authoritative contract — keep it in sync. Cut over in compose only after the full
matrix passes and the dashboard renders against the Go server with no console
errors.

## Module layout (planned)

```
go-services/
  internal/
    db/        pgxpool (shared); reuse + add pool
    secretcrypto/  (done) AES-GCM printer secrets
    metrics/   (done, exporter) — web gets its own printfarm_web_* writer
    redis/     optional sessions/ratelimit/telemetry cache (go-redis)
    pwcrypto/  scrypt + legacy sha256 verify/upgrade
    saml/      SAML SP: metadata, ACS, signed-assertion verify (xml-c14n + dsig)
  cmd/web/
    main.go        server, signal handling
    router.go      top-level dispatch (mirrors app.js)
    auth.go        session resolve, classifyApiRequest, CSRF origin check, roles
    security.go    setSecurityHeaders (CSP/HSTS/etc), logger, X-Request-Id
    metrics.go     printfarm_web_* (port of server/metrics.js)
    store/         port of server/postgres.js (70 fns) — grouped by resource
    printers.go    /api/printers, redaction, /command (MQTT), proxy
    queue.go       /api/queue + submit (busboy→multipart), file stream
    analytics.go   /api/analytics/daily
    maintenance.go /api/maintenance/*
    notifications.go, slicerkeys.go, auditlogs.go, settings.go, users.go
    admincred.go, manager.go
    camera.go      Bambu camera hub (port of bambuCamera.js + captureBambuSnapshot)
    proxy.go       /__printer_proxy, /__printer_webcam (handlePrinterProxy)
    dataapi.go     /api/v1 (handleDataApi*) — key-gated, full read/write
    auth_sso.go    /api/auth/* providers, oauth, SAML
```

## Status

- **Phase 1 — done & verified.** Foundation at full parity (commit "web Go port phase 1").
- **Phase 2 — done & verified** for the polled data reads + on-load settings reads
  (`GET /api/printers`, `/api/printers/:id`, `/api/queue`, `/api/analytics/daily`,
  `/api/cameras/health`, `/api/printers/:id/camera/health`, `/api/settings/{branding,
  integrations,public-viewer,analytics-layout,printer-card-layout/:profile}`). Byte-
  identical body + headers vs the live Node server across the matrix above. The
  **maintenance reads** (`/api/maintenance*`, `/api/printers/:id/maintenance`,
  `/api/settings/maintenance-intervals`) are split out as **Phase 2b** (still TODO).
  Key parity mechanism: `jsCompact` re-serializes Postgres `json` output the way
  Node's `JSON.parse`→`JSON.stringify` does (compact, JS-normalized numbers,
  preserved key order); ordered structs reproduce object-literal key order where Go
  maps would sort. The privileged (full-secrets) printer path is stubbed off until
  sessions land in Phase 3 — every caller is currently treated as anonymous/redacted.
- **Phase 2b — done & verified.** Maintenance reads at parity (`GET /api/maintenance`,
  `/api/maintenance/summary`, `/api/maintenance/notifications`, `/api/printers/:id/
  maintenance`, `/api/settings/maintenance-intervals`). Unlike the json_build_object
  reads, the Node maintenance fns return raw `pg` rows, so timestamptz arrives as a JS
  `Date` and is emitted via `toISOString()` (ms + `Z`). The Go port scans typed columns
  and formats with `jsISO`, verified byte-identical to `Date.toISOString()` including
  sub-ms truncation (node-postgres floors micros→ms). `getPrinterMaintenance`'s
  next-service / overdue / health-score computation is reproduced in Go with the same
  float arithmetic. Mutations (mark-read, complete, intervals PUT) remain Phase 4.

## Phased plan (each phase build + parity-verify + commit)

1. **Foundation** — server, pgxpool, logger, X-Request-Id, setSecurityHeaders
   (CSP/HSTS/etc.), `/healthz`, `/readyz` (pingDatabase + redis-degraded),
   `/metrics` (printfarm_web_* request metrics), static SPA serving from `/dist`.
2. **Public reads** — `GET /api/printers` (+ viewer redaction), `GET /api/printers/:id`,
   `GET /api/queue`, `GET /api/analytics/daily`, `GET /api/cameras/health`,
   `GET /api/maintenance*` (→ Phase 2b), settings/branding/layout reads.
3. **Sessions & auth** — `/api/auth/*` (login/logout/me), session cookie
   (SameSite=Lax), scrypt password verify (`pwcrypto`), role gate
   (`classifyApiRequest`), CSRF same-origin check, admin credential first-run.
4. **Operator/admin mutations** — printers upsert/delete, queue printed/reset/
   delete, analytics reset, maintenance complete, users CRUD, slicer-keys,
   notifications, audit-logs, settings writes.
5. **Queue intake & files** — `POST /api/queue/submit` (multipart via mime/
   multipart, the busboy replacement), `GET /api/queue/:id/file` bytea stream.
6. **Printer hardware** — `/__printer_proxy/*` (HTTP passthrough),
   `POST /api/printers/:id/command` (Bambu MQTT), `/__printer_webcam/*`.
7. **Camera hub** — port `bambuCamera.js` (persistent ffmpeg RTSP→MJPEG fan-out +
   health supervisor) and `captureBambuSnapshot` (port-6000 TLS JPEG). Highest risk.
8. **SAML SSO** — SP metadata, `/launch`, ACS POST, signed-assertion verification
   (XML c14n + RSA-SHA256 signature check). High risk; needs a real IdP to verify.
9. **/api/v1 data API** — key-gated full read/write parity (`handleDataApi*`),
   audit `source='api'`, no redaction, migration routes.
10. **Manager request API** (`/api/manager/*`, CORS) and remaining edges.
11. **Cutover** — swap compose `web` to Dockerfile.go (needs ffmpeg + ca-certs in
    the runtime image — distroless/static has ca-certs but **not ffmpeg**, so the
    web image needs a different base, e.g. debian-slim + ffmpeg, not distroless).

## Known risk / parity notes

- **CSP/HSTS live in the app**, not nginx — must reproduce `setSecurityHeaders`
  exactly (nginx also sets 4 legacy headers; duplicates are fine).
- **`/metrics` is internal-only** (nginx 404s it publicly); Prometheus scrapes
  `web:5173` directly — keep the same.
- Password hashes: scrypt (`scrypt$…`) with legacy bare-sha256 upgraded on verify.
- JSONB/response shapes must match the frontend exactly (camelCase, nesting).
- The camera hub holds **one ffmpeg per printer** — the web runtime image must
  ship ffmpeg, so it can't be distroless/static like the poller/exporter.
- SAML signature verification has no pure-stdlib path; needs an XML-dsig impl.
