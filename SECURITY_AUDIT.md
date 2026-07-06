# Security Audit Report — 3D-FarmLab

> Audit scope: Go backend (`go-services/cmd/web/`, `go-services/cmd/poller/`), Node.js server (`server/`), React frontend (`src/`), Python exporter (`exporter/`), slicer proxy (`slicer-proxy/`), Docker/nginx setup, and GitHub Actions CI/CD.

---

## CRITICAL (must fix before production)

---

### C-1 — Unauthenticated Access to Printer Control Proxy

> **Status (Node web): fixed.** `handlePrinterProxy` (`server/app.js`) now requires
> an **operator/admin** session for the `/__printer_proxy/` prefix (401 with no
> session, 403 for a non-privileged one), matching the RBAC on
> `/api/printers/:id/command`. This covers GET too, because Moonraker executes
> gcode via `GET /printer/gcode/script?script=`. The read-only webcam prefix
> (`/__printer_webcam/`) stays public so the dashboard camera works in viewer
> mode. The Go port is not deployed by `docker-compose.yml`; apply the same gate
> there if it is ever built.

**Files:** `go-services/cmd/web/server.go:131-137`, `go-services/cmd/web/proxy.go:48-125`, `go-services/cmd/web/auth.go:280-283`

`handlePrinterProxy` and `handleWebcamStream` are dispatched in `handleRequest` **after** `handleAPI`, which only guards paths under `/api/`. The authorization gate explicitly skips everything else:

```go
// auth.go:280-283
func authorizeFrontendApi(...) bool {
    if !strings.HasPrefix(pathname, "/api/") ... {
        return true  // all non-/api/ paths bypass auth
    }
```

Because `/__printer_proxy/` and `/__printer_webcam/` do not start with `/api/`, every request to those prefixes is served with **zero authentication**. The nginx `location /` block passes them through to the web container, so they are reachable from the internet. `/__printer_proxy/<printerId>/...` proxies the full Moonraker HTTP API for Snapmaker printers — any anonymous user can cancel prints, upload G-code, execute arbitrary commands, and read all job state. The identical bypass exists in `server/app.js`.

**Fix:** Add a session check inside `handlePrinterProxy`, or extend `authorizeFrontendApi` to also gate `/__printer_proxy/` (require at least a viewer session). The `/webcam/` stream can remain public if intentional, but must not share the same unauthenticated path as write/control operations.

---

### C-2 — Login Rate Limiter Bypassed via X-Forwarded-For Spoofing

> **Status (Node web): addressed.** nginx now sets `X-Real-IP $remote_addr` in
> addition to replacing `X-Forwarded-For` (`nginx/default.conf.template`), and
> `getClientIp` (`server/app.js`) prefers `X-Real-IP`, then the **rightmost**
> `X-Forwarded-For` value (the trusted-proxy hop), then the socket peer — so a
> client-supplied header can no longer mint a fresh rate-limit bucket. The Go port
> (`go-services/cmd/web/`) is not deployed by `docker-compose.yml`; apply the same
> change there if it is ever built.

**Files:** `go-services/cmd/web/auth.go:115-127`, `server/app.js:1023-1029`

The rate limiter keys on `getClientIP`, which takes the **first** (leftmost) value in `X-Forwarded-For`:

```go
ip := strings.TrimSpace(strings.Split(fwd, ",")[0])
```

Behind nginx, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` **appends** the real client IP; it does not replace the header. A client sending `X-Forwarded-For: 1.2.3.1` produces `X-Forwarded-For: 1.2.3.1, <real_ip>` in the app, and the code picks the spoofed value. An attacker rotating fake IPs in this header defeats the 8-attempt lockout entirely, even from behind nginx.

**Fix:** Use the **rightmost** IP in `X-Forwarded-For` (the value appended by the trusted proxy), or configure nginx to set `X-Real-IP $remote_addr` and read that header instead.

---

### C-3 — No Rate Limiting on `/api/admin/credential/verify` and `/api/users/verify`

> **Status (Node web): addressed.** Both frontend verify endpoints (`server/app.js`)
> now run through the same combined `guardCredentialAttempt` / `recordCredentialFailure`
> throttle as `/api/auth/login`, keyed on the shared per-IP and per-username buckets —
> so they return `429` when locked and can't be used as an unthrottled oracle to
> sidestep the login lockout. A new **per-username escalating lockout** (5 failures →
> 15 min, doubling to a 6 h cap, auto-unlock) also defends against wordlist attacks
> that rotate source IPs. The Go port (`go-services/cmd/web/`) is not deployed; apply
> the same guard there if it is ever built.

**File:** `go-services/cmd/web/authroutes.go:338-366`

Both endpoints are classified as `public` with no rate limiting of any kind. An attacker can call them at wire speed. The login endpoint has an 8-attempt lockout; these two verify endpoints that perform the same credential check are completely unprotected alternatives.

Although scrypt slows each verification, a weak password is still attackable online in hours via parallelized requests with no throttling.

**Fix:** Apply the same IP-rate-limiting logic as `handleLogin` to both verify endpoints, or unify all credential checks through a single rate-limited path.

---

### C-4 — Slicer Upload Has No File Size Limit

**Files:** `slicer-proxy/index.js:166-199`, `nginx/default.conf.template:87`

`parseUpload` calls `busboy({ headers: req.headers })` with no `limits` option. The nginx config sets `client_max_body_size 0` (unlimited) for `/printers/`. An attacker with any valid slicer API key can upload multi-gigabyte files, exhausting server memory (entire file is `Buffer.concat(chunks)` in RAM) and database storage.

**Fix:** Pass `{ limits: { fileSize: MAX_UPLOAD_BYTES } }` to busboy and set a sensible `client_max_body_size` in nginx (e.g., `200m`).

---

## HIGH (fix soon)

---

### H-1 — Prometheus UI Exposed on Public Site Without Authentication

**File:** `nginx/default.conf.template:97-110`

```nginx
location /prometheus/ {
    proxy_pass http://prometheus:9090;
}
```

Prometheus is proxied with no auth, no IP restriction. The config itself warns: *"NOTE: this puts Prometheus on the public site — gate it by network/auth if the dashboard is internet-facing."* It exposes internal time-series data including printer counts, job throughput, request rates, and the full Prometheus TSDB/PromQL API.

**Fix:** Add `auth_basic` or restrict to a management IP range. Alternatively, stop proxying Prometheus externally — the monitoring stack is internal.

---

### H-2 — TLS Certificate Verification Disabled for All Bambu Printer Connections

**Files:** `go-services/cmd/web/command.go:373`, `go-services/cmd/web/camera.go:608`, `go-services/cmd/poller/bambu.go:43`, `slicer-proxy/index.js:282`, `slicer-proxy/index.js:378`

Every MQTT, FTPS, and RTSP-over-TLS connection to Bambu printers uses `InsecureSkipVerify: true` / `rejectUnauthorized: false`. A network-positioned attacker on the printer LAN can MITM these connections to intercept the LAN access code, inject print commands, or redirect camera feeds.

**Fix (best effort):** At first-connect, store the printer's self-signed certificate fingerprint in the DB and pin it on subsequent connections. This eliminates the MITM window without requiring a CA.

---

### H-3 — SSRF via SAML Test Endpoint (Admin-Reachable)

**File:** `go-services/cmd/web/sso.go:538`

```go
probe, perr := client.Get(idpSsoURL)
```

`POST /api/settings/saml/test` performs an outbound HTTP GET to an admin-supplied URL, validated only for `http`/`https` scheme. There are no restrictions on private IPs, loopback, or cloud metadata endpoints (`169.254.169.254`). A compromised admin session can probe IMDS or internal services.

**Fix:** Block reserved/private IP ranges (RFC 1918, RFC 3927, loopback) before making the outbound request.

---

### H-4 — In-Memory Login Rate Limiting Not Shared Across Go Web Replicas

**File:** `go-services/cmd/web/authroutes.go:368-427`

The Go web service uses a per-process in-memory map for login rate limiting. With N replicas the effective limit multiplies: 2 replicas → 16 attempts, 8 replicas → 64. The Node service correctly uses Redis for a shared counter; the Go port has no Redis-backed path.

**Fix:** Add a Redis-backed counter path matching the Node implementation, or document clearly that horizontal scaling of the Go web service disables effective rate limiting.

---

### H-5 — Slicer Upload Filename Not Sanitized Before FTP Write

**Files:** `slicer-proxy/index.js:185`, `slicer-proxy/index.js:262-285`

The multipart `filename` field is used directly as the FTP `STOR` argument without sanitization. A path traversal filename (`../../../init.d/foo.3mf`) could escape the expected directory on the printer's SD card.

**Fix:** Sanitize the filename before use:
```js
const safeName = path.basename(filename).replace(/[^\w.\-]/g, '_');
```

---

### H-6 — SAML Auto-Provisioned Users Can Receive IdP-Asserted Admin Role

**File:** `go-services/cmd/web/sso.go:399-410`

When `autoProvisionUsers` is enabled, the `role` attribute from the SAML assertion is trusted directly. A malicious or compromised IdP can assert `role=admin` and give an arbitrary user full dashboard admin access.

**Fix:** Default `autoProvisionUsers` to `false`. Consider separating "allow new SAML users" from "trust IdP-asserted role" — new auto-provisioned users should default to `student` regardless of the assertion unless an explicit allow-list is configured.

---

## MEDIUM

---

### N-1 — Queue Model-File Download Not Gated by Viewer Mode

> **Status (Node web): fixed.** `GET /api/queue/:id/file` now classifies as a
> viewer-gated read (`isViewerGatedRead`), so when public viewer mode is **off**
> it requires a session, matching the `/api/queue` listing. Previously it was
> classified `public` regardless of mode, leaving uploaded model files
> world-downloadable to anyone with (or guessing) a job id on a deployment that
> had deliberately disabled the public dashboard.

**File:** `server/app.js` (`classifyApiRequest`)

Found during the second scan pass. The recent PII-redaction work protected the
queue *listing* metadata, but the model *file bytes* (which can themselves carry
identifying detail — embedded thumbnails, project names) streamed from
`/api/queue/:id/file` were not gated. Job ids are UUIDv4 (not enumerable), so
severity is moderate, but the endpoint contradicted the intent of gating the
queue when viewer mode is disabled. The key-gated `/api/v1/queue/:id/file` path
is separate and unaffected.

---

### M-1 — OAuth JWT Claims Not Signature-Verified

**File:** `go-services/cmd/web/oauth.go:195-209`

`decodeJwtClaims` base64-decodes the JWT payload without verifying its HMAC/RSA signature. The comment justifies this by trust in the TLS token endpoint. If TLS is MITMed (rogue CA, corporate proxy), forged claims are accepted.

**Fix:** Verify the id_token signature against the provider's JWKS endpoint. This is the formally correct OIDC flow and adds defense in depth.

---

### M-2 — Public Queue Submit and Manager Request Not Rate-Limited

**File:** `server/app.js` (PUBLIC_API_MUTATIONS)

`POST /api/queue/submit` (up to 50 MB file, stored in DB) and `POST /api/manager/request` have no rate limiting. A bot can exhaust database storage and trigger unlimited Discord webhook notifications.

**Fix:** Add IP-based rate limiting (e.g., 5 requests per IP per hour) with a `429 Too Many Requests` response.

---

### M-3 — Webcam HTML from Printer Served on Dashboard Origin

**File:** `go-services/cmd/web/proxy.go:155-172`

When a printer webcam endpoint returns `text/html`, the proxy injects a `<style>` tag and serves the response from the dashboard origin with `webcamCSP` (which permits `'unsafe-inline'` scripts). An attacker who can MITM the printer's HTTP connection or compromise printer firmware can inject scripts that run on the dashboard's origin.

**Fix:** Serve webcam HTML in a sandboxed `<iframe>` or from a distinct subdomain to prevent injected scripts from accessing dashboard cookies/localStorage.

---

### M-4 — User-Controlled X-Request-Id Reflected in Response Header

**File:** `go-services/cmd/web/server.go:80-87`

The `X-Request-Id` request header is echoed back in the response after a 64-character truncation. Go's HTTP layer strips CRLF, preventing header injection, but arbitrary values appear in structured logs and may confuse log aggregators.

**Fix:** Validate that the reflected value matches UUID format (`^[0-9a-f-]{36}$`) before echoing; otherwise generate a fresh UUID.

---

### M-5 — Admin Credential First-Run Endpoint Permanently Public

**File:** `go-services/cmd/web/authroutes.go:278-302`

`POST /api/admin/credential` is permanently classified as `public` and protected only by a TOCTOU-susceptible `if configured { return 409 }` check. If the database is wiped or a race occurs at startup, the endpoint is transiently open to credential takeover with no audit trail.

**Fix:** Generate a one-time setup token printed to stdout on first boot (when no credential exists), require it in the `POST` body, and audit failed attempts.

---

### M-6 — SVG Sanitizer Uses Regex — Multiple Bypass Vectors

**File:** `server/app.js:746-756`

The admin-uploaded logo sanitizer misses:
- Unquoted event handlers: `onerror=alert(1)` (no surrounding quotes)
- `<animate>`, `<set>`, `<animateTransform>` — load external resources via `href`
- CSS `url(javascript:...)` in `style` attributes

Upload is admin-only, so exploitation requires a compromised admin account.

**Fix:** Replace the regex sanitizer with an allowlist-based SVG library (e.g., `DOMPurify` with SVG namespace support).

---

### M-7 — Internal Error Details Forwarded to Clients

**File:** `go-services/cmd/web/proxy.go:109`

```go
sendJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()}, "")
```

When the printer proxy fails, the raw Go error string (which may include the printer's internal IP, port, or hostnames) is returned to the browser.

**Fix:** Log the full error server-side; return a generic `"upstream printer unreachable"` message to the client.

---

## LOW / Code Quality

---

### L-1 — Redis Has No Password

**File:** `docker-compose.yml:25-28`

The Redis service runs without a password. The port is unpublished, but any co-located compromised container has full Redis access. An attacker can delete rate-limit keys to re-enable brute-force.

**Fix:** Set `requirepass <secret>` in the Redis command and configure `REDIS_URL=redis://:<password>@redis:6379`.

---

### L-2 — CI/CD Only Tags `:latest` — No Rollback Capability

**File:** `.github/workflows/deploy.yml:38-60`

All images are pushed only as `:latest`. A bad deployment has no pinned tag to roll back to without rebuilding.

**Fix:** Push a secondary tag with the short Git SHA: `printfarm-web:${GITHUB_SHA::8}`.

---

### L-3 — Printer URL/IP Not Validated to Private Address Space

**Files:** `server/postgres.js` (upsertPrinter), `go-services/cmd/web/mutations.go`

Admin-configured `url` and `ip_address` fields are not restricted to RFC 1918 ranges. An admin can configure a printer pointing to an external host, turning the printer proxy into an admin-reachable SSRF.

**Fix:** Validate `ip_address` and the host in `url` to be within `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16` at save time.

---

### L-4 — No Audit Log on Failed Credential Verify Calls

**File:** `go-services/cmd/web/authroutes.go:338-366`

Unlike `/api/auth/login`, failed calls to `/api/admin/credential/verify` and `/api/users/verify` are not recorded in the audit log. An attacker can probe these silently.

**Fix:** Add `recordAuditLog` entries for failures, matching the pattern in `handleLogin`.

---

### L-5 — No Security Headers on Slicer Proxy Responses

**File:** `slicer-proxy/index.js`

The slicer proxy's `sendJson` never sets security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`). When accessed directly on its internal port (bypassing nginx), responses carry no protections.

**Fix:** Add a security-headers middleware to the slicer proxy server.

---

### L-6 — Sessions Not Bound to IP or User-Agent

**File:** `go-services/cmd/web/sessionstore.go:24-30`

Sessions are stored with a `created_ip` field for display only, not for validation. A stolen `pf_session` cookie (up to 30-day TTL) is valid from any client anywhere.

**Fix:** Log security events when a session is used from an IP different from `created_ip`. Optionally bind to a user-agent hash as a soft anomaly signal.

---

### L-7 — MQTT Client ID Embeds Printer Serial and Nanosecond Timestamp

**File:** `go-services/cmd/web/command.go:374`

```go
opts.SetClientID(fmt.Sprintf("printfarm-web-%s-%d", serial, time.Now().UnixNano()))
```

Bambu printers log connected MQTT clients. A physical attacker with printer access can read logs to infer the web server's timing behavior and the printer's serial number from the client ID.

**Fix:** Use `uuid.NewString()` for MQTT client IDs instead of embedding the serial and timestamp.

---

## Positive Security Observations

The codebase gets several things right:

- **No SQL injection surface** — all queries use parameterized placeholders throughout `server/postgres.js` and the Go `pgx` layer.
- **Scrypt KDF with lazy upgrade** — stored credentials use `scrypt$N$r$p$salt$hash` with transparent migration from legacy bare-SHA-256.
- **Constant-time comparisons everywhere** — `crypto/subtle.ConstantTimeCompare` (Go) and `timingSafeEqual` (Node) used for all credential and HMAC checks.
- **HMAC-signed, expiring state and grant tokens** — OAuth/SAML flow uses short-lived HMAC tokens (2–10 min TTL) to prevent replay without a server-side store.
- **AES-256-GCM for printer secrets at rest** — `PRINTER_SECRET_KEY` encrypts LAN access codes in the DB with a proper authenticated cipher.
- **Server-side sessions with token hashing** — `pf_session` cookie value is SHA-256 hashed before storage; the raw token is never persisted.
- **Default-deny authorization matrix** — unclassified API mutations default to admin-only.
- **G-code command allowlist** — the `gcode` command is filtered against a strict set of safe motion prefixes before being published to MQTT.
