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
- **Phase 3 — done & verified.** Sessions & auth: cookie parse/issue (`pf_session`,
  SameSite=Lax), `internal/pwcrypto` (scrypt derive/verify + legacy sha256, wire
  format identical to app.js), session DB store, the default-deny gate
  (`authorizeFrontendApi` / `classifyApiRequest` / `isSensitiveRead` / admin/operator
  matrices) + CSRF same-origin check, and the endpoints `GET /api/auth/{session,
  providers}`, `POST /api/auth/{login,logout}`, `GET|POST|PUT /api/admin/credential`,
  `POST /api/admin/credential/verify`, `POST /api/users/verify`. `isPrivileged(session)`
  now drives the full-secrets printer path. Verified two ways: (1) the 20-case gate
  matrix (401/403/public, CSRF) byte-identical vs the live Node server; (2) a full
  happy-path flow (login → session → privileged unredacted printers → logout →
  re-redaction) byte-identical vs Node on a throwaway DB — incl. an admin credential
  set as scrypt by Node and verified by Go (cross-runtime KDF compatibility). Redis
  session caching + login throttle are omitted (disabled deployment; Node falls back
  to the same Postgres path). Remaining: SSO grant `/api/auth/verify`, slicer-token,
  and the SAML endpoints (Phase 8).
- **Phase 4 — done & verified.** Operator/admin mutations: printers upsert (encrypt +
  config-only upsert + maintenance seeding) / delete, queue printed/reset/delete,
  analytics reset, maintenance complete (txn + nozzle reset) / notifications-read /
  intervals PUT, settings PUTs (integrations / public-viewer / analytics-layout /
  printer-card-layout), users CRUD (create / delete / password / role + list), and
  audit-logs GET+POST. Verified by running **Node and Go against two identical
  throwaway DBs** and diffing both HTTP responses and resulting state across ~24 cases
  (validation 400/404/409, success 200/204/201, privileged read-back, seeded
  schedules, and the complete-event transaction incl. the nozzle-reset side effect).
  Bug found & fixed: Go's json.Unmarshal allocates a non-nil zero pointer on a type
  mismatch, so `*bool`/`*string` nil-checks passed where Node's `typeof` rejected —
  the settings PUTs now decode into a generic map and assert the JSON type. Deferred:
  branding PUT (SVG theme analysis), slicer-keys, Discord notifications, home-assistant,
  saml/oauth settings writes, manager (their own phases). queue submit = Phase 5,
  printer command = Phase 6.
- **Phase 5 — done & verified.** Queue intake & files: `POST /api/queue/submit` (public
  multipart intake, busboy replaced by a streaming `mime/multipart` reader that buffers
  the single uploaded file bounded by `QUEUE_UPLOAD_MAX_BYTES`, stores it as
  `queue_jobs.file_content` bytea + `file_mime`/`file_size_bytes`, and fires the Discord
  `queue_added` webhook in a detached goroutine) and `GET /api/queue/:id/file` (streams the
  bytea out in 256 KB chunks read straight from Postgres via `substring`, with the
  `Content-Disposition` attachment/inline + sanitized filename). Both routes are public
  (submit is in `publicAPIMutations`; the file GET is a plain read), wired via
  `handleQueueIntake` between `handleMutations` and the GET read switch. Verified by running
  **Node and Go against two identical throwaway DBs** (Node-dumped schema loaded into the Go
  DB, since the Go server doesn't run `ensureSchema` yet) and diffing responses + DB state:
  the four validation paths (no-name/no-file/bad-ext/empty-file 400/415), the 201 `{ok,id}`
  success shape, download headers (Content-Type/Length/Disposition/Cache-Control), body
  byte-equality (upload↔download↔cross-runtime), full DB row parity (filename, counts,
  notes assembly, priority/estimated_time defaults, form_type, mime, sizes), inline `?open=1`
  disposition, filename sanitization (`my odd@name#2.stl` → `my odd_name_2.stl`), explicit
  mime passthrough, and 404 for a missing file. Bug found & fixed: busboy's `fileSize` limit
  is **inclusive** (a file that reaches `limit` bytes is rejected; max accepted is
  `limit-1`) — confirmed against Node at the 998/999/1000/1001 boundary — so the Go check is
  `>=` not `>`. The `id` (sha1 of `submittedAt.toISOString()|studentId||name|filename`) is
  non-deterministic across runs by design, so it's structure-normalized (`queue-<HEX16>`)
  rather than byte-compared. **Gap found & fixed (security):** this phase was originally
  ported from a `server/app.js` snapshot that predated the queue-availability window
  (`queue_availability` app_setting, `evaluateQueueAvailability`), so the Go submit path
  never rejected a submission outside the admin-configured closing schedule regardless of
  how it was set — confirmed independently on a live deployment. `queue.go` now carries its
  own `getQueueAvailabilitySetting`/`evaluateQueueAvailability` (using `time.LoadLocation`
  instead of Node's `Intl.DateTimeFormat` workaround; `time.Weekday` numbering already
  matches Node's Sunday=0..Saturday=6), checked at the top of `handleQueueSubmit` before
  parsing the multipart body, plus the previously-missing `GET /api/queue/availability` and
  `GET`/`PUT /api/settings/queue-availability` routes (`api.go`/`mutations.go`), so all three
  endpoints are now at parity with Node.
- **Phase 6 — done & verified.** Printer hardware: the raw HTTP passthrough
  (`handlePrinterProxy` in `cmd/web/proxy.go`, backing `/__printer_proxy/` and
  `/__printer_webcam/`, plus the friendly `/webcam/<id-or-name>` URL), and the Bambu MQTT
  command surface (`POST /api/printers/:id/command` in `cmd/web/command.go` — all payload
  builders + validators + a short-lived publish-only TLS publish via paho). Wired into
  `handleRequest` after `handleAPI`; the command route is added to `handleMutations` (gated
  operator, as before). The proxy uses a no-timeout `http.Client` (webcam can be an endless
  MJPEG stream) and aborts the upstream via the request context on client disconnect; webcam
  responses get the relaxed headers (WEBCAM_CSP, X-Frame-Options SAMEORIGIN, CORP
  cross-origin, no-store) and the HTML style-injection. The `api_key_header` is parsed
  exactly like `parseHeaderString` (`Name: value` → that header; bare value → X-API-Key).
  **Bambu cameras (A1/P1 port-6000 JPEG snapshot, H2 RTSP hub) are deferred to Phase 7** —
  a Bambu webcam request hits a Phase-7 stub. Verified Node vs Go against throwaway DBs with
  a fake upstream HTTP printer + a real TLS mosquitto broker: proxy passthrough byte-identical
  (method/path/query/forwarded headers/api-key injection/request body/upstream status);
  webcam passthrough byte-identical (HTML `<style>` injection before `</head>`, all relaxed
  headers, JPEG piped unchanged, `/webcam/<name>` case-insensitive resolution); command
  gate (401)/404/15 validation-error messages byte-identical; and **22 success command
  payloads captured off the broker byte-identical incl. JSON key order** (print actions with
  the stop `param`, gcode_line for temp/gcode/fan, set_airduct with default submode -1, AMS
  load/unload/setting with the ams_id/tray_id split, and the H2 dual-LED light). Bug found &
  fixed: an unsupported-command error interpolates the raw value JS-style, so a missing/
  non-string command must render `undefined`/`null` (Go now uses `commandDisplay`, not the
  empty asserted string). Note: MQTT connection-failure messages differ by library (Node
  "connack timeout" vs Go "i/o timeout") — both 500; not parity-comparable. No `API.md`
  change (pure port).
- **Phase 7 — done & verified.** The camera hub (`cmd/web/camera.go`, port of
  `server/bambuCamera.js` + `captureBambuSnapshot`): one persistent ffmpeg per printer
  (RTSP→MJPEG), fanned out to every live viewer over per-viewer channels and reused for
  snapshots, with the health-check supervisor (frame-stall restart, exponential backoff,
  idle shutdown). The Phase-6 Bambu-webcam stub is replaced with the real `handleBambuWebcam`
  (RTSP profiles → hub stream/snapshot; A1/P1 → `captureBambuSnapshot` port-6000 TLS JPEG),
  and the camera-health routes now read the live hub. Go differs from Node's single-threaded
  event loop by guarding all stream state with a per-stream mutex and dropping frames to a
  backed-up viewer via a non-blocking size-1 channel send; the mpjpeg parser state is local
  to the stdout-reader goroutine (never shared). Verified Node vs Go with a **deterministic
  fake `ffmpeg`** (emits known JPEGs as mpjpeg so both hubs ingest identical bytes) and a
  **fake port-6000 TLS server**: snapshot byte-identical (frame + headers); MJPEG fan-out
  byte-identical multipart framing with valid source JPEGs in correct cyclic order; health
  JSON identical for the running shape (with `name`), the idle default (no `name`), and the
  array form; Bambu path validation (404 "Unsupported Bambu camera path", A1 stream→404, A1
  snapshot→502); and `captureBambuSnapshot` byte-identical for a valid frame plus both error
  cases ("non-image frame (N bytes)…", "frame was not a JPEG"). The `-race` build ran clean
  (0 data races) under concurrent snapshot/stream/health/A1-capture load. Not live-tested:
  real ffmpeg against a real RTSP camera (none available) — but `ffmpegArgs`/`buildRtspURL`
  are byte-identical to Node's production strings and the full hub machinery (spawn, stdout
  parse, lifecycle, fan-out, snapshot, supervisor) was exercised via the fake ffmpeg. No
  `API.md` change (pure port).
- **Phase 8 — done & verified.** SAML 2.0 SSO (the dashboard is the SP) + the shared HMAC
  grant/state hand-off. New `internal/saml` (port of samlSp.js: validation helpers,
  `BuildAuthnRequest` deflate+base64, `ParseAndVerify`, `BuildSpMetadata`) and `cmd/web/sso.go`
  (port of oauthGrant.js sign/verify state+grant, getOAuthSigningSecret, the SAML config
  getters, and the routes: `GET /api/auth/saml/metadata`, `GET /api/auth/saml/start`,
  `POST /api/auth/saml/acs`, `GET /launch`, `POST /api/auth/verify`, `GET|PUT /api/settings/saml`,
  `POST /api/settings/saml/test`). XML-signature verification uses **goxmldsig v1.4.0** (+
  beevik/etree v1.1.0 — pinned to keep go.mod at 1.22; v1.6.0 needs go 1.23). Verified Node vs
  Go against throwaway DBs, with **assertions signed by the image's own xml-crypto** (the same
  lib Node verifies with) fed to both ACS endpoints: providers/metadata(host-normalized)/
  settings GET+PUT+test/AuthnRequest(deflate round-trip) byte-identical; the full
  signed-assertion → ACS → grant → `/api/auth/verify` flow yields an **identical user object**;
  and every failure/condition variant (tampered sig, wrong configured cert, audience/window/
  recipient/status/scd-expired, auto-provision off → not_provisioned, known-staff-user keeps
  its role) produces a matching ACS outcome. Bug found & fixed: goxmldsig validates a detached
  element, so namespaces declared on an ancestor (Response) are "undeclared" on the Assertion —
  `selfContainedAssertion` injects inherited xmlns declarations before validating, reproducing
  xml-crypto's exclusive-c14n; and the `saml/test` response needed an ordered struct for the
  `{ok, checks}` key order. **Known stricter-than-Node edges** (goxmldsig vs xml-crypto, both
  secure): goxmldsig also checks the signing cert's NotBefore/NotAfter (Node doesn't), and
  prefers the KeyInfo cert (falling back to the single configured root). Standard IdP responses
  (cert in KeyInfo, currently valid) verify identically. Deferred: the OAuth provider login
  dance (Google/Microsoft `/start`+`/callback`) — separate from SAML; `/api/auth/providers`
  already reports their configured status (Phase 3). No `API.md` change (pure port).

- **Phase 9 — done & verified.** The key-gated `/api/v1` data API (`cmd/web/dataapi.go` +
  `cmd/web/store_dataapi.go`, port of `handleDataApi*` from app.js): X-Api-Key / Bearer auth
  against `slicer_api_keys` (best-effort `last_used_at` stamp), the `printfarm_manage` scope
  gate, and every resource — `printers` (list/get/upsert/delete + `/command` MQTT +
  `/proxy/<path...>` HTTP passthrough + `/camera/{snapshot,stream,health}`, all delegating to
  the Phase 6/7 `handlePrinterProxy`/hub with our own API creds stripped), `queue`
  (list/upsert/printed/reset/delete + the migration routes export/import/bulk-delete and
  per-job `GET|PUT /:id/file`), `analytics`, `maintenance`, `notifications`, `slicer-keys`,
  `audit-logs`, `settings/<key>`, `users` (with `passwordHash`, like admin-credential),
  `admin-credential`, and `manager-requests` (incl. approve minting a `printfarm_manage` key).
  Mutations audit with `source='api'`. Connection secrets are **not** redacted here (reuses the
  unredacted `listPrintersJSON(…, true)` / `getPrinterByIdJSON(…, true)`). Wired into `handleAPI`
  before the cookie-session gate (which already exempts `/api/v1`). Verified Node vs Go against
  two identical throwaway DBs (Node-dumped schema into the Go DB) across **~90 cases**: 33 reads
  byte-identical (incl. queue export/file-stream, `manager-requests/:id` returning `key_secret`,
  `settings/<key>`, `users` with hash, discovery root, 401/403/404 auth paths); 28
  validation/no-state cases; success mutations with response + **full DB-state parity** on every
  deterministic table (printers, queue_jobs, discord_webhooks, maintenance_events,
  analytics_daily, app_settings) and structural parity on the random-id tables (staff_users,
  slicer_api_keys, manager_requests); the audit trail identical (24 entries, ordered details,
  `source='api'`); file-download headers byte-identical; camera health/validation byte-identical;
  proxy connect-failure status-identical. **Two real bugs found & fixed:** (1) `markQueueJobPrinted`
  must also clear `file_content`/`file_mime`/`file_size_bytes` (Node reclaims storage on
  mark-printed; the Phase-4 port only set `printed_status`) — this also fixes the frontend
  `POST /api/queue/:id/printed`; (2) the settings PUT stored the raw request bytes, so `1.50`
  persisted un-normalized — now `jsCompact`-normalized before the jsonb write to match Node's
  `JSON.parse`→store (`1.50`→`1.5`). Also made `recordAuditLog` marshal details without HTML
  escaping (Node's `JSON.stringify`) so user-text details with `<>&` match. **Known edges**
  (consistent with prior phases, not Phase-9-specific): an uncaught store error yields Node's
  raw `error.message` vs Go's generic `Internal Server Error` (only reachable via input that
  passes app-validation but violates a DB constraint, e.g. a printer upsert missing a NOT-NULL
  column); MQTT/HTTP-upstream connect failures give library-specific 500 bodies (status parity
  only); and an over-limit file PUT — Node's `readBodyBounded` `req.destroy()`s mid-stream so the
  client sees a connection reset, while Go sends the intended clean `413` JSON (both reject and
  store nothing). No `API.md` change (pure port of existing routes). The Node-web background
  maintenance `setInterval` (app.js:5444) drifts `health_score`→100 over time and is not
  request-path code — excluded from the state diff.

- **Phase 10 — done & verified.** The manager access-request workflow (`cmd/web/manager.go`,
  port of the `/api/manager/*` block in app.js) plus the low-risk admin CRUD edges that reuse
  the Phase-9 stores and the `/api/version` build-id probe. Routes: `POST /api/manager/request`
  (public create + CORS, `OPTIONS` preflight 204), `GET /api/manager/requests` (admin list),
  `GET /api/manager/requests/:id/status` (public poll + CORS; reveals the minted key once then
  `clearManagerRequestKeySecret`), `POST …/:id/approve` (admin; mints a `printfarm_manage`
  key, returns `{ok:true}` — the key is revealed via the later status poll, unlike the data
  API's inline-key approve), `POST …/:id/deny`, `DELETE …/:id` (admin; revokes the key); the
  admin Discord-webhook CRUD (`GET|POST /api/notifications/discord-webhooks`, `DELETE …/:id`)
  and slicer-key CRUD (`GET|POST /api/slicer-keys`, `DELETE …/:id`); and `GET /api/version`
  (`{buildId}` = `sha256(dist/index.html)[:16]`, computed once like Node's startup hook,
  served public before the gate). Wired into `handleAPI` after `handleMutations`; the CORS
  blocks set headers then fall through for non-matching methods, mirroring Node. Verified Node
  vs Go against two identical throwaway DBs (with a seeded admin session cookie for the gated
  routes and a shared `index.html` so the build-id hashes match) across **35 cases**: build-id
  byte-identical; the full manager lifecycle (create→list→status-pending→approve→status-reveal
  →status-cleared→deny→delete-with-key-revocation) byte-identical (incl. CORS preflight + CORS
  response headers); slicer-key/webhook create+delete; every 400/404/401 path; and **full
  DB-state parity** across manager_requests, slicer_api_keys, and discord_webhooks (key minting,
  key-secret clearing, key revocation on delete, scope normalization). The manager-request store
  (`createManagerRequest`/`getManagerRequest`/`listManagerRequestsJSON`/approve/deny/delete) was
  already ported in Phase 9; this phase added `clearManagerRequestKeySecret`. No `API.md` change
  (pure port). **Still deferred to a pre-cutover pass** (each its own subsystem): the slicer-grant
  session dance (`POST /api/slicer-grant/verify`, `POST|DELETE /api/auth/slicer-token`), the OAuth
  provider login flow (Google/Microsoft `/start`+`/callback` — `/api/auth/providers` already
  reports status), `PUT /api/settings/branding` (SVG theme analysis), `/api/settings/favicon`, and
  the Home-Assistant integration (`/api/settings/home-assistant/{,devices,rules,test}` + its engine
  timer). These must land before the Phase-11 compose cutover.

- **Pre-cutover edges, part 1 (auth hand-off completers) — done & verified.** `cmd/web/oauth.go`,
  ports of the slicer operator-grant verify (`slicerGrant.js`), the session-bound slicer-token
  mint/revoke, and the OAuth (Google / Microsoft Entra ID) Authorization-Code login dance from
  app.js. Routes: `POST /api/slicer-grant/verify` (verify the `SLICER_GRANT_SECRET`-HMAC grant →
  issue an operator session → `{printerId}`); `POST|DELETE /api/auth/slicer-token` (mint/revoke a
  `slicer_upload` key bound to the caller's session token hash — POST is idempotent, dropping any
  prior session key first); and `GET /api/auth/(google|microsoft)/(config|start|callback)` — the
  start hop signs a state token and 302s to the provider's consent screen (cloud-tenant **and**
  on-prem AD FS `authority` modes for Microsoft, with `prompt=select_account` vs `login`), the
  callback verifies state, exchanges the code at the provider's token endpoint, decodes the
  id_token claims (`email` → `preferred_username` → `upn` fallback), enforces `allowedDomains` /
  `email_verified`, and mints the same HMAC auth grant the SAML ACS uses (consumed by the existing
  `POST /api/auth/verify`). Reuses the Phase-8 `ssoSign`/`signState`/`verifyState`/`mintAuthGrant`
  helpers and adds `deleteSlicerApiKeysBySession` to the store. Wired into `handleAPI` after
  `handleSSORoutes` (the SAML provider routes are claimed first; the `(google|microsoft)` match
  excludes `saml` by construction). The gate already classified every path correctly (slicer-grant
  verify = public, slicer-token = authed, the GET provider routes = public). Verified Node vs Go
  across two identical throwaway DBs (`SLICER_GRANT_SECRET` shared, a seeded admin session cookie,
  configs INSERTed identically): **slicer-grant** valid/expired/tampered/malformed/empty/
  pid-not-string/exp-not-number all byte-identical (incl. the operator `Set-Cookie` shape);
  **slicer-token** mint (201 `{id,key,permissions}` + DB row with matching name/permissions/
  `session_token_hash`), re-mint idempotency (stays one row), revoke (204 + row cleared), the
  no-session and method-not-allowed paths; **OAuth** `config`/`start` for both providers in all
  three endpoint modes (Google, Microsoft cloud-tenant, Microsoft AD FS authority) — the authorize
  redirect byte-identical down to query-param order, the `redirect_uri`, and `prompt`; and the
  **callback** rejection paths (`not_configured`, `denied` for error/no-code/bad-state) plus the
  full **token exchange** against a fake `authority` token endpoint with per-DB-signed state:
  verified-allowed-domain, domain-not-allowed, unverified-email, `preferred_username` fallback +
  name-defaults-to-email, no-email-claim, and `exchange_failed` (unreachable endpoint) — the
  decoded grant **claims** (`provider`/`sub`/`email`/`name`/`role`) identical on both (the grant
  signatures differ only because each DB auto-generates its own `oauth_signing_secret`). No new
  deps; go directive stays 1.22.2. No `API.md` change (pure port of existing routes). **Still
  deferred** (each its own subsystem, must land before the Phase-11 cutover): `PUT
  /api/settings/branding` (SVG theme analysis), `/api/settings/favicon`, and the Home-Assistant
  integration (`/api/settings/home-assistant/{,devices,rules,test}` + its engine timer).

- **Pre-cutover edges, part 2 (branding write + favicon) — done & verified.** `cmd/web/branding.go`,
  ports of `PUT /api/settings/branding` and `GET /api/settings/favicon` from app.js. The PUT
  validates/normalizes the logo / background / favicon data URLs (case-sensitive `data:image/...`
  prefix checks, per-asset size caps → 413 with the exact Node messages, a 5.06 MB body cap → 413
  "Request body is too large"), clamps `logoScale` to [0.5, 2] rounded to 2 dp, truncates
  `siteName` to 120, and for SVG logos runs the full theme analysis (`sanitizeSvg` →
  `normalizeSvgSize` → `analyzeSvgForTheme`): strips active-content vectors, drops root
  width/height and synthesizes a `viewBox`, and — for a single-color ("monochrome") mark — swaps
  every visible color (and a missing fill on the root) for `currentColor` so it follows the theme,
  while genuine multi-color art is left untouched. The favicon GET decodes the stored data URL and
  streams the raw image (`Content-Type` from the data URL, `Cache-Control: no-cache`), 404 when
  none, 500 when malformed. The Node SVG regexes were ported to RE2 (no lookahead/backrefs needed;
  the one `(?=[\s>])` lookahead on the width/height-stripping regex is unnecessary because the
  pattern doesn't consume the trailing boundary, so a plain global replace chains identically for
  well-formed markup). **Also fixed a pre-existing Phase-2 gap:** the branding GET shape
  (`brandingResponse`/`brandingShape`) was missing `faviconDataUrl`, which Node's `getBranding`
  emits — added so the GET (and the PUT echo) match. Wired the PUT into `handleMutations` (gated
  admin) and the favicon GET into the public GET switch in `handleAPI`. Verified Node vs Go across
  two identical throwaway DBs (admin cookie + same-origin): **24 cases** — all 8 validation 400s,
  the 3 per-asset 413s **and** the body-level 413, scale clamp-hi/clamp-lo/round/string-coerce,
  siteName trim+truncate, clear-to-empty, and **7 SVG theme cases** (monochrome→currentColor +
  viewBox synthesis + width/height strip, multi-color untouched, no-fill→root `fill=currentColor`,
  pre-existing-viewBox kept, color-keyword/`stop-color` handling, and `<?xml>`/`<script>`
  sanitization) — every PUT response (a re-read of the stored branding, so this also confirms
  stored-state parity) byte-identical; the favicon GET byte-identical on image bytes, `Content-Type`,
  `Cache-Control`, the 404, and the 500. No new deps; go directive stays 1.22.2. No `API.md` change
  (pure port). **Last deferred subsystem before cutover:** the Home-Assistant integration
  (`/api/settings/home-assistant/{,devices,rules,test}` + its `evaluateHaRules` engine timer).

- **Pre-cutover edges, part 3 (Home-Assistant integration) — done & verified.** `cmd/web/homeassistant.go`,
  the full port of the HA subsystem from app.js. Routes (all admin-gated by the classifier):
  `GET|PUT /api/settings/home-assistant` (config — GET returns `{baseUrl,enabled,hasToken}`, never
  the token; PUT validates/normalizes the base URL — strips a trailing `/` and `/api` — encrypts
  the token via the shared `secretCipher` and retains the existing token when none/blank is sent),
  `POST …/test` (probes HA's `GET /api/`), `GET …/devices` (maps HA `GET /api/states` to
  `{entities, groups}` — entities sorted by id, groups keyed by domain in first-appearance order),
  and the automation-rule CRUD `GET|POST …/rules` + `PUT|DELETE …/rules/:id` (validate +
  normalize both rule directions, create with id/createdAt, a bare `{enabled}` toggle vs a full
  re-validating update, soft 404). Also ported the background **`evaluateHaRules` engine**
  (`startHaAutomationEngine`, wired into `main.go` on a cancellable context): edge-triggered
  printer→HA (`callHaService`) and HA→printer (`dispatchPrintControl` — Bambu MQTT / Moonraker
  HTTP) rule firing with the same last-seen baseline-then-transition semantics, non-overlapping
  cycles, default 15 s interval (`HA_AUTOMATION_INTERVAL_MS`, min 5 s). The **tricky parity work**
  was the rule responses: a created rule is emitted in insertion order (`id, createdAt, …rule`)
  but reads/updates echo the **jsonb-canonical** order Postgres stores (length-then-bytewise), and
  `PUT` merges via `{...existing, ...override}` — so the port emits POST in struct order, reads via
  the raw stored array, and re-implements the ordered spread-merge (`parseOrderedObject` +
  `mergeOrdered`) over the canonical-ordered existing rule, normalizing numbers with `jsCompact` to
  match `JSON.stringify`. Verified Node vs Go across two identical throwaway DBs (admin cookie +
  same-origin, two fake HA servers for the reachable paths): **31 cases** — config GET, PUT
  validation (non-string / bad-scheme), save + base-URL normalization + token retention (omitted /
  blank), `test` not-configured / connected / non-200 `data.message`, `devices` not-configured /
  the full sorted-entities + first-appearance-ordered groups payload, all **10 rule-validation
  errors**, create (both directions), list, bare-enabled toggle, full update, the **direction-change
  mongrel-merge** (both field-sets present in spread order), 404s, and delete — every response
  byte-identical (incl. the jsonb-canonical key order on reads/updates), plus HA-config DB-state
  parity. **Known divergences** (consistent with prior phases): an *unreachable*-HA `test`/`devices`
  error carries a library-specific dial message (Node `fetch` vs Go `net/http`) — status/shape
  match, text differs; entity sort uses Go bytewise vs Node `localeCompare` (identical for the
  ASCII entity ids HA emits); and the engine itself isn't live-tested (needs a real HA + printers,
  like the Node maintenance/HA timers). No new deps; go directive stays 1.22.2. No `API.md` change
  (pure port). **All deferred pre-cutover edges are now landed — the remaining work is Phase 11
  (the compose cutover to `Dockerfile.go`).**

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
