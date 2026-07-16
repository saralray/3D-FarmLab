#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PrintFarm security smoke test — READ-ONLY, non-destructive.
#
# Verifies the deployment's security posture and (where applicable) the changes
# on the security-refactor branch. It ONLY issues GET/HEAD requests: no logins,
# no mutations, no brute force — so it never pollutes the audit log, trips a
# lockout, or changes state.
#
# Usage:
#   scripts/security-smoke.sh [BASE_URL] [API_KEY]
#   BASE_URL   default: https://printfarm.saral.work
#   API_KEY    optional: a /api/v1 key to exercise scope enforcement. Use a
#              LOW-privilege key (printfarm_read) — the script only does GETs.
#
# Examples:
#   scripts/security-smoke.sh
#   scripts/security-smoke.sh https://printfarm.saral.work
#   scripts/security-smoke.sh https://printfarm.saral.work "$READ_KEY"
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-https://printfarm.saral.work}"
BASE="${BASE%/}"
KEY="${2:-}"
CURL=(curl -sS --max-time 20)

pass=0; fail=0; info=0
ok()   { echo "  ✅ PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  ❌ FAIL  $*"; fail=$((fail+1)); }
note() { echo "  ℹ️  INFO  $*"; info=$((info+1)); }
hr()   { echo; echo "── $* ──────────────────────────────────────────────"; }

# status CODE PATH [METHOD]  -> echoes the HTTP status of a request
status() {
  local path="$1" method="${3:-GET}"; shift
  "${CURL[@]}" -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path"
}
hdr() { "${CURL[@]}" -D - -o /dev/null "$BASE${1:-/}"; }

echo "PrintFarm security smoke test → $BASE"
echo "(read-only; $( [ -n "$KEY" ] && echo 'with API key' || echo 'no API key' ))"

# ── 1. Reachability + TLS ────────────────────────────────────────────────────
hr "1. Reachability & TLS"
code=$(status / )
if [ "$code" = "000" ]; then bad "site unreachable (TLS/DNS/connection error)"; echo; echo "Aborting."; exit 1; fi
ok "site responds (HTTP $code) over TLS"

# ── 2. Security headers ──────────────────────────────────────────────────────
hr "2. Security headers on /"
H="$(hdr / | tr -d '\r')"
check_hdr() { echo "$H" | grep -iq "^$1:" && ok "$1 present" || bad "$1 MISSING"; }
check_hdr "content-security-policy"
check_hdr "x-content-type-options"
check_hdr "x-frame-options"
check_hdr "referrer-policy"
if echo "$H" | grep -iq "^strict-transport-security:"; then ok "strict-transport-security present (HTTPS)"; else note "HSTS not present (only emitted over https w/ X-Forwarded-Proto)"; fi
echo "$H" | grep -iq "frame-ancestors 'none'" && ok "CSP frame-ancestors 'none' (clickjacking control)" || note "CSP has no frame-ancestors 'none'"

# ── 3. Public endpoints (should work anonymously) ────────────────────────────
hr "3. Public reads"
[ "$(status /api/version)" = "200" ] && ok "/api/version 200" || bad "/api/version not 200"
c=$(status /api/printers); [ "$c" = "200" ] && ok "/api/printers 200 (public dashboard read)" || note "/api/printers = $c"
# Secrets must NOT appear in the public printer list.
body="$("${CURL[@]}" "$BASE/api/printers" 2>/dev/null)"
if echo "$body" | grep -Eiq '"(apiKeyHeader|ipAddress|serial)"[[:space:]]*:[[:space:]]*"[^"]+"'; then
  bad "/api/printers appears to leak a non-empty connection secret (apiKeyHeader/ipAddress/serial)"
else
  ok "/api/printers exposes no populated connection secrets"
fi

# ── 4. /api/v1 requires a key (401) ──────────────────────────────────────────
hr "4. Data API auth boundary (/api/v1)"
c=$(status /api/v1);          [ "$c" = "401" ] && ok "/api/v1 → 401 without key" || bad "/api/v1 = $c (expected 401)"
c=$(status /api/v1/printers); [ "$c" = "401" ] && ok "/api/v1/printers → 401 without key" || bad "/api/v1/printers = $c (expected 401)"
c=$(status /api/v1/users);    [ "$c" = "401" ] && ok "/api/v1/users → 401 without key" || bad "/api/v1/users = $c (expected 401)"

# ── 5. Internal-only surfaces must NOT be public ─────────────────────────────
hr "5. Internal-only surfaces"
c=$(status /metrics);   [ "$c" = "404" ] && ok "/metrics → 404 on public site" || note "/metrics = $c (expected 404; carries no secrets but should be internal)"
c=$(status /mcp);       { [ "$c" = "403" ] || [ "$c" = "404" ]; } && ok "/mcp → $c (not publicly usable)" || note "/mcp = $c (MCP_HTTP_PUBLIC?)"
c=$(status /prometheus/); case "$c" in
  401|403) ok "/prometheus → $c (auth required)";;
  200)     bad "/prometheus → 200 (UNAUTHENTICATED — set PROMETHEUS_BASIC_AUTH_PASSWORD, H-1)";;
  *)       note "/prometheus → $c";;
esac

# ── 6. Default-deny read gate (S-1) — detects if the branch is deployed ──────
hr "6. Default-deny read gate (S-1 — branch marker)"
c=$(status /api/filament-station/spools)
case "$c" in
  401) ok "/api/filament-station/spools → 401 (default-deny gate ACTIVE — branch deployed)";;
  200) note "/api/filament-station/spools → 200 (pre-branch behavior: fail-open reads; deploy the branch to fix S-1)";;
  *)   note "/api/filament-station/spools → $c";;
esac

# ── 7. Scoped-key enforcement (S-3) — only if a key is provided ──────────────
hr "7. Scoped API keys (S-3 — needs a printfarm_read key)"
if [ -z "$KEY" ]; then
  note "no API key supplied — skipping. Re-run with a printfarm_read key to test scope enforcement."
else
  kc() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -H "X-Api-Key: $KEY" "$BASE$1"; }
  c=$(kc /api/v1/printers); [ "$c" = "200" ] && ok "read key: GET /api/v1/printers 200" || bad "read key: /api/v1/printers = $c"
  c=$(kc /api/v1/users);    [ "$c" = "403" ] && ok "read key: GET /api/v1/users → 403 (scope enforced)" || note "read key: /api/v1/users = $c (403 expected for printfarm_read on the branch)"
  # Secret redaction: a non-manage key must not see connection secrets.
  b="$("${CURL[@]}" -H "X-Api-Key: $KEY" "$BASE/api/v1/printers" 2>/dev/null)"
  if echo "$b" | grep -Eiq '"(apiKeyHeader|ipAddress|serial)"[[:space:]]*:[[:space:]]*"[^"]+"'; then
    note "read key sees populated connection secrets — expected redacted on the branch (fine if this key is printfarm_manage)"
  else
    ok "read key: connection secrets redacted in /api/v1/printers"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
hr "Summary"
echo "  PASS=$pass  FAIL=$fail  INFO=$info"
[ "$fail" -eq 0 ]
