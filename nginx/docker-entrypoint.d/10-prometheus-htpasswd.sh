#!/bin/sh
# Generates the auth config that gates /prometheus (see H-1 in
# default.conf.template). Runs automatically: official nginx images execute
# every executable script under /docker-entrypoint.d/ before nginx starts.
#
# PROMETHEUS_BASIC_AUTH_PASSWORD set -> /prometheus requires HTTP Basic Auth
# with that credential. Left unset -> /prometheus is served with no auth at
# all (opt-out; e.g. a LAN-only deploy where the network boundary is already
# the trust boundary).
set -eu

HTPASSWD_FILE=/etc/nginx/prometheus.htpasswd
AUTH_CONF=/etc/nginx/prometheus_auth.conf

if [ -n "${PROMETHEUS_BASIC_AUTH_PASSWORD:-}" ]; then
  user="${PROMETHEUS_BASIC_AUTH_USER:-admin}"
  hash="$(openssl passwd -apr1 "$PROMETHEUS_BASIC_AUTH_PASSWORD")"
  printf '%s:%s\n' "$user" "$hash" > "$HTPASSWD_FILE"
  printf 'auth_basic "Prometheus";\nauth_basic_user_file %s;\n' "$HTPASSWD_FILE" > "$AUTH_CONF"
  echo "10-prometheus-htpasswd.sh: /prometheus exposed with Basic Auth (user: $user)"
else
  printf 'auth_basic off;\n' > "$AUTH_CONF"
  echo "10-prometheus-htpasswd.sh: PROMETHEUS_BASIC_AUTH_PASSWORD not set — /prometheus exposed with no auth"
fi
