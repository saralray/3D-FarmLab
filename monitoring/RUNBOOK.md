# Operations Runbook

Operational reference for running 3D-FarmLab in production (single org, 50–200
printers, 1,000+ users, Docker Compose). Pairs with the alert rules in
`monitoring/prometheus/alerts.yml` and the Grafana dashboard in
`monitoring/grafana-dashboard.json`.

## Health & readiness endpoints

| Endpoint | Purpose | Healthy | Notes |
|----------|---------|---------|-------|
| `GET /healthz` | Liveness | `200 {"ok":true}` | Cheap, **DB-independent** — a DB blip must not kill the container. This is the Docker `healthcheck`. |
| `GET /readyz` | Readiness | `200 {"ok":true,...}` | Checks the **database** (required → `503` when down) and **Redis** (optional → reported `degraded`, never fails readiness). Use for load-balancer routing. |
| `GET /metrics` | Web request metrics | Prometheus text | **Internal only** — nginx returns `404`; Prometheus scrapes `web:5173` directly. |
| `GET /nginx-health` | nginx liveness | `200 ok` | Served by nginx itself. |
| `GET /prometheus` | Prometheus UI/API | UI | On the public site — gate by network/auth if internet-facing. |

Quick check from the host:

```bash
curl -fsS localhost:8080/healthz
curl -fsS localhost:8080/readyz | jq          # 503 + checks.database=error when DB is down
docker compose exec web node -e "fetch('http://127.0.0.1:5173/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').length,'lines'))"
```

## Metrics map

- **Print-farm data** (`printfarm_*`): `exporter` service reads Postgres on each
  scrape — printer status/temps/progress, queue depth, analytics counters.
- **Poller health** (`printfarm_poller_*`): from the `poller_health` table, one
  series per `shard` — `last_run_timestamp_seconds` (liveness), `cycle_duration_seconds`,
  `printers_polled`, `rows_written`, `refresh_failures`, `shard_count`.
- **Web tier** (`printfarm_web_*`): in-process at `/metrics` — `http_requests_total{method,status,route}`,
  `http_request_duration_seconds` (histogram by route), `http_requests_in_flight`,
  `resident_memory_bytes`, `start_time_seconds`.

## Alert response

### PollerStalled (critical)
`poller_health` for a shard hasn't advanced in >60s. Printer telemetry is going stale.
1. `docker compose ps poller` / `docker compose logs --tail=100 poller`.
2. Look for a crash loop, DB connection errors, or a hung Bambu MQTT connection.
3. If sharded, confirm each `POLLER_SHARD_INDEX` replica is running.
4. Restart: `docker compose restart poller`. It drains gracefully on SIGTERM.

### PollerRefreshFailures (warning)
Sustained per-cycle refresh failures for 10m.
1. Distinguish "printers genuinely offline" (expected) from cycle errors in the logs.
2. If logs show `cycle overran`, raise `PRINTER_POLL_CONCURRENCY_MAX` or add a shard.
3. Check network reachability to the affected printers.

### ExporterScrapeFailing / ExporterDown (critical)
`printfarm_scrape_success == 0` (DB read failing) or the exporter is unreachable.
1. Check the `db` service first: `docker compose ps db`, `docker compose logs db`.
2. `docker compose logs exporter`. The exporter reports failure rather than crashing.
3. If the DB is healthy, restart the exporter: `docker compose restart exporter`.

### WebDown (critical)
Prometheus can't scrape `web:5173/metrics` for 1m.
1. `docker compose ps web` — running? crash-looping?
2. `docker compose logs --tail=200 web` for the startup error (missing `dist/`, bad `DATABASE_URL`).
3. After rebuilding **only** `web`, nginx can hold a stale IP (502s) — `docker compose restart nginx`.

### WebHighErrorRate (warning)
>5% of web requests are 5xx for 5m.
1. `curl localhost:8080/readyz` — is the database up?
2. Grep web logs for `unhandled request error` and the `reqId` to correlate.
3. Check Redis if enabled (errors are non-fatal but log `falling back`).

### WebHighLatencyP95 (warning)
p95 web latency >1s for 10m.
1. Check DB load (`pg_stat_activity`), slow queries, and lock waits.
2. Check pool exhaustion: compare `DATABASE_POOL_MAX` × web replicas vs Postgres `max_connections`.
3. Check `printfarm_web_http_requests_in_flight` for a pile-up.

## Common operations

**Logs.** Set `LOG_FORMAT=json` to emit structured logs for an aggregator;
`LOG_LEVEL=debug` for verbosity; `LOG_HTTP=all` to log every request (default
`sample` logs only 4xx/5xx). Every request carries an `X-Request-Id` echoed in
its access-log line (`reqId`) for correlation.

**Scaling the poller.** Run multiple `poller` services with the same
`POLLER_SHARD_COUNT` and distinct `POLLER_SHARD_INDEX` (0..N-1). Each owns a
disjoint `crc32(id) % count` subset — no double-polling.

**Database safety.** Pool size and query timeouts are env-tunable
(`DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`,
`DATABASE_IDLE_TX_TIMEOUT_MS`). Schema changes go through the versioned migration
framework in `server/postgres.js` (`schema_migrations` table).

**Redis is optional.** With `REDIS_URL` unset the stack runs on Postgres/in-memory.
A Redis outage degrades gracefully (one `falling back` warning, then auto-reconnect);
it never fails `/readyz`.

**Backups.** All durable state is in Postgres (`postgres_data` volume) — including
model files (`queue_jobs.file_content`). Back up that volume / run `pg_dump`.
Redis (`redis_data`) and Prometheus (`prometheus_data`) are caches/metrics and
are not source-of-truth.
