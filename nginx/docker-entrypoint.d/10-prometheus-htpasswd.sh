#!/bin/sh
# Generates the auth config that gates /prometheus (see H-1 in
# default.conf.template). Runs automatically: official nginx images execute
# every executable script under /docker-entrypoint.d/ before nginx starts.
#
# Posture is FAIL-CLOSED — the default deploy must not serve Prometheus (its
# UI, /federate, and query API leak the whole farm's internal metrics) to the
# public internet:
#
#   PROMETHEUS_BASIC_AUTH_PASSWORD set        -> HTTP Basic Auth with that credential.
#   else PROMETHEUS_ALLOW_ANONYMOUS=true      -> no auth (explicit opt-out, e.g.
#                                                a LAN-only deploy where the network
#                                                boundary is already the trust boundary).
#   else (neither set)                        -> 403 for everyone (deny all).
#
# This script ALWAYS writes $AUTH_CONF (in every branch) — default.conf.template
# `include`s it, and a missing include crash-loops nginx.
set -eu

HTPASSWD_FILE=/etc/nginx/prometheus.htpasswd
AUTH_CONF=/etc/nginx/prometheus_auth.conf

if [ -n "${PROMETHEUS_BASIC_AUTH_PASSWORD:-}" ]; then
  user="${PROMETHEUS_BASIC_AUTH_USER:-admin}"
  # Feed the password on stdin, not as an argv element, so it isn't briefly
  # visible in the container's process list while the hash is generated.
  hash="$(printf '%s' "$PROMETHEUS_BASIC_AUTH_PASSWORD" | openssl passwd -apr1 -stdin)"
  printf '%s:%s\n' "$user" "$hash" > "$HTPASSWD_FILE"
  printf 'auth_basic "Prometheus";\nauth_basic_user_file %s;\n' "$HTPASSWD_FILE" > "$AUTH_CONF"
  echo "10-prometheus-htpasswd.sh: /prometheus exposed with Basic Auth (user: $user)"
elif [ "${PROMETHEUS_ALLOW_ANONYMOUS:-false}" = "true" ]; then
  printf 'auth_basic off;\n' > "$AUTH_CONF"
  echo "10-prometheus-htpasswd.sh: PROMETHEUS_ALLOW_ANONYMOUS=true — /prometheus exposed with NO auth"
else
  # Fail-closed: no credential and no explicit anonymous opt-out -> block it.
  printf 'auth_basic off;\ndeny all;\n' > "$AUTH_CONF"
  echo "10-prometheus-htpasswd.sh: /prometheus blocked (403) — set PROMETHEUS_BASIC_AUTH_PASSWORD to expose it, or PROMETHEUS_ALLOW_ANONYMOUS=true for a trusted LAN"
fi
