#!/bin/sh
# Generates the Basic Auth credential file that gates /prometheus (see H-1 in
# default.conf.template). Runs automatically: official nginx images execute
# every executable script under /docker-entrypoint.d/ before nginx starts.
#
# No PROMETHEUS_BASIC_AUTH_PASSWORD set -> writes an empty credential file, so
# every request 401s (still fully blocked, matching the pre-Basic-Auth H-1
# fix's default posture). Set the password to opt in to exposing /prometheus
# on the public site for an external Grafana.
set -eu

HTPASSWD_FILE=/etc/nginx/prometheus.htpasswd

if [ -n "${PROMETHEUS_BASIC_AUTH_PASSWORD:-}" ]; then
  user="${PROMETHEUS_BASIC_AUTH_USER:-admin}"
  hash="$(openssl passwd -apr1 "$PROMETHEUS_BASIC_AUTH_PASSWORD")"
  printf '%s:%s\n' "$user" "$hash" > "$HTPASSWD_FILE"
  echo "10-prometheus-htpasswd.sh: /prometheus exposed with Basic Auth (user: $user)"
else
  : > "$HTPASSWD_FILE"
  echo "10-prometheus-htpasswd.sh: PROMETHEUS_BASIC_AUTH_PASSWORD not set — /prometheus stays blocked (empty credential file)"
fi
