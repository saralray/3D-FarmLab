#!/bin/sh
# Generates the access config that gates the public /mcp route (see
# default.conf.template). Runs automatically before nginx starts (official
# image behavior).
#
# The MCP server is a full read/write control surface over the farm and is
# meant to be reachable only over the internal compose network (other services
# hit mcp:8092 directly and bypass nginx entirely). It IS key-gated
# (printfarm_manage), but a single leaked key = remote farm takeover, so the
# public nginx route is FAIL-CLOSED by default:
#
#   MCP_HTTP_PUBLIC=true  -> /mcp reachable from the public site (still key-gated).
#   else (default)        -> 403 for everyone on the public route.
#
# Internal service-to-service access to mcp:8092 is unaffected either way.
# This script ALWAYS writes $ACCESS_CONF (both branches) — default.conf.template
# `include`s it, and a missing include crash-loops nginx.
set -eu

ACCESS_CONF=/etc/nginx/mcp_access.conf

if [ "${MCP_HTTP_PUBLIC:-false}" = "true" ]; then
  printf 'allow all;\n' > "$ACCESS_CONF"
  echo "15-mcp-access.sh: MCP_HTTP_PUBLIC=true — /mcp reachable on the public site (key-gated)"
else
  printf 'deny all;\n' > "$ACCESS_CONF"
  echo "15-mcp-access.sh: /mcp blocked (403) on the public site — internal only. Set MCP_HTTP_PUBLIC=true to expose it"
fi
