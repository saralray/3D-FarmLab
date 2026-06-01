# Monitoring — Prometheus

This directory holds the **Prometheus** scrape configuration and Grafana
assets for the STEM Lab Print Farm. Prometheus scrapes the read-only
[`exporter`](../exporter/) service, stores the time series, and serves them to a
(separately run) Grafana.

```
exporter:9180/metrics  ──scrape every 15s──▶  prometheus:9090  ──datasource──▶  Grafana
  (reads PostgreSQL,                            (TSDB storage,                    (dashboards,
   printfarm_* metrics)                          PromQL, query UI)                run by you)
```

The `exporter` turns the `printers`, `analytics_daily`, and `queue_jobs` tables
into `printfarm_*` metrics on every scrape; Prometheus is what makes them
queryable over time and gives Grafana something to read. Neither is proxied
through nginx, so metrics never reach the public `:8080` site.

## What's in this directory

| Path | Purpose |
|------|---------|
| `prometheus/prometheus.yml` | Prometheus scrape config. Mounted read-only by Docker Compose; mirrored by the ConfigMap in `k8s/prometheus.yaml`. |
| `grafana/provisioning/datasources/prometheus.yml` | Grafana datasource definition (`Print Farm Prometheus`, uid `printfarm-prometheus`). Mount into Grafana to auto-create the datasource. |
| `grafana-dashboard.json` | Importable Grafana dashboard (`STEM Lab Print Farm`, uid `printfarm-overview`). |

## How the scrape config works

`prometheus/prometheus.yml` is intentionally small and is shared verbatim by both
Docker Compose and Kubernetes — `exporter` resolves on the Compose network and
in the `printfarm` namespace alike:

```yaml
global:
  scrape_interval: 15s      # how often each target is scraped
  scrape_timeout: 10s       # per-scrape timeout
  evaluation_interval: 15s

scrape_configs:
  - job_name: printfarm
    static_configs:
      - targets: ["exporter:9180"]   # the print-farm metrics
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]  # Prometheus scraping itself
```

If you change the exporter's port, update **both** `EXPORTER_PORT` and the
`printfarm` target above (and the `k8s/prometheus.yaml` ConfigMap).

## Running it

### Docker Compose

Prometheus and the exporter come up with the rest of the stack:

```bash
docker compose up --build
```

- Prometheus UI: <http://localhost:9090> (host port from `PROMETHEUS_PORT`)
- The `exporter` has **no** host port — it is only reachable inside the Compose
  network, which is exactly where Prometheus scrapes it from.
- The TSDB persists in the `prometheus_data` named volume.

Inspect just these services:

```bash
docker compose logs -f prometheus
docker compose logs -f exporter
curl -s http://localhost:9090/-/ready          # Prometheus readiness
docker compose exec exporter \
  python -c "import urllib.request as u; print(u.urlopen('http://localhost:9180/metrics').read()[:500])"
```

### Kubernetes

The manifests live in `k8s/` and are part of the normal apply:

```bash
kubectl apply -f k8s/                  # whole stack, or just the two below:
kubectl apply -f k8s/exporter.yaml -f k8s/prometheus.yaml
```

- `k8s/exporter.yaml` — exporter Deployment + ClusterIP Service on `:9180`.
- `k8s/prometheus.yaml` — Prometheus Deployment, a `prometheus-config` ConfigMap
  (mirrors `prometheus/prometheus.yml`), a 10Gi `prometheus-pvc`, and a
  **ClusterIP** Service on `:9090`. `Recreate` strategy is used because the
  ReadWriteOnce PVC can only attach to one pod at a time.

Both Services are ClusterIP (in-cluster only). To reach Prometheus from an
external Grafana, switch the `prometheus` Service to `NodePort`/`LoadBalancer`
or add a route in `k8s/ingress.yaml`.

```bash
kubectl -n printfarm get pods
kubectl -n printfarm logs -f deployment/prometheus
kubectl -n printfarm port-forward svc/prometheus 9090:9090   # local access
```

## Ports and environment

| Variable | Default | Effect |
|----------|---------|--------|
| `PROMETHEUS_PORT` | `9090` | Host port Prometheus is published on (Compose). An external Grafana uses `http://<host>:9090`. |
| `EXPORTER_PORT` | `9180` | Port the exporter listens on. Internal only — not published to the host. |
| `EXPORTER_DB_TIMEOUT_SECONDS` | `5` | Cap on how long one scrape waits to connect to PostgreSQL before giving up. |
| `DATABASE_URL` | — | PostgreSQL connection the exporter reads (read-only; it never writes or creates schema). |

Image: `prom/prometheus:v2.55.1`. TSDB retention is Prometheus's default
(15 days) — not overridden here. Bump it by adding
`--storage.tsdb.retention.time=...` to the Prometheus args if you need a longer
history.

## Checking that scraping works

Open the Prometheus UI and confirm the exporter target is healthy:

- **Status → Targets** — the `printfarm` job (`exporter:9180`) should be `UP`.
- **Graph** — run `printfarm_scrape_success`. `1` means the last scrape read the
  database; `0` means the exporter couldn't reach PostgreSQL (the exporter stays
  up and reports `0` rather than crashing — check `docker compose logs exporter`).

## Connecting Grafana

Grafana is **not** part of this stack — run your own and point it at this
Prometheus.

1. **Add the datasource.** Either configure it by hand (Prometheus,
   URL `http://prometheus:9090` if Grafana shares the network, otherwise
   `http://<host>:9090`), or mount the provisioning file so it's created on
   startup:

   ```bash
   # in your Grafana's docker run / compose:
   -v $(pwd)/monitoring/grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro
   ```

   Edit `url` in that file to whatever **your** Grafana can actually reach.

2. **Import the dashboard.** Grafana → Dashboards → Import → upload
   `grafana-dashboard.json`, and select the Prometheus datasource when prompted
   (the dashboard templates its datasource as `${datasource}`).

## Metrics reference

All series are namespaced `printfarm_*`. Per-printer metrics carry `id` and
`name` labels. Connection secrets (IP, API key, serial) are **never** emitted.

### Per-printer (gauge)

| Metric | Labels | Meaning |
|--------|--------|---------|
| `printfarm_printer_info` | `id, name, model, profile, status` | Metadata series; value always `1`. |
| `printfarm_printer_up` | `id, name` | `1` unless the printer status is `offline`. |
| `printfarm_printer_nozzle_temperature_celsius` | `id, name` | Current nozzle temperature. |
| `printfarm_printer_bed_temperature_celsius` | `id, name` | Current bed temperature. |
| `printfarm_printer_progress_percent` | `id, name` | Current job progress, 0–100. |
| `printfarm_printer_total_print_time_hours` | `id, name` | Lifetime print-time counter for the printer, in hours. |
| `printfarm_printer_success_rate_percent` | `id, name` | Reported success rate, 0–100. |

### Farm-wide (gauge)

| Metric | Labels | Meaning |
|--------|--------|---------|
| `printfarm_printers_total` | — | Total printers. |
| `printfarm_printers_by_status` | `status` | Printer count per status. |
| `printfarm_printer_online` | — | Count of printers that are **not** offline (matches the UI "Online": `status != 'offline'`). |
| `printfarm_printer_offline` | — | Count of printers with status `offline`. |
| `printfarm_printer_printing` | — | Count of printers with status `printing`. |
| `printfarm_printer_pause` | — | Count of printers with status `paused`. |
| `printfarm_printer_error` | — | Count of printers with status `error`. |
| `printfarm_queue_jobs` | `state` (`queued`/`completed`) | Print-queue depth by state (3D-print form rows, soft-deleted excluded). |
| `printfarm_jobs_completed_today` | — | Completed jobs today. |
| `printfarm_jobs_failed_today` | — | Failed jobs today. |
| `printfarm_print_time_hours_today` | — | Print time today, hours. |
| `printfarm_filament_grams_today` | — | Filament used today, grams. |
| `printfarm_success_rate_percent` | — | Overall success rate — completed/(completed+failed)×100 (the Analytics page's Success Rate card). |
| `printfarm_success_rate_percent_today` | — | Success rate for today's jobs. |

### Cumulative (counter — exposed with the `_total` suffix)

| Metric | Meaning |
|--------|---------|
| `printfarm_jobs_completed_total` | Cumulative completed print jobs. |
| `printfarm_jobs_failed_total` | Cumulative failed print jobs. |
| `printfarm_print_time_hours_total` | Cumulative print time, hours. |
| `printfarm_filament_grams_total` | Cumulative filament used, grams. |

> The admin **Reset analytics** action TRUNCATEs `analytics_daily`, so these
> counters drop to `0`. Prometheus treats that as a normal counter reset, and
> `rate()`/`increase()` handle it correctly.

### Exporter self-metrics (gauge)

| Metric | Meaning |
|--------|---------|
| `printfarm_scrape_success` | `1` if the last scrape read the database, else `0`. |
| `printfarm_scrape_duration_seconds` | Time the exporter spent querying PostgreSQL for the scrape. |

## Example PromQL

```promql
# Printers currently online
sum(printfarm_printer_up)

# Print jobs completed per hour, last 24h
rate(printfarm_jobs_completed_total[1h]) * 3600

# Filament used in the last 7 days (grams)
increase(printfarm_filament_grams_total[7d])

# Printers running hot (>250 °C nozzle)
printfarm_printer_nozzle_temperature_celsius > 250

# Jobs waiting in the queue
printfarm_queue_jobs{state="queued"}

# Alert signal: exporter can't reach the database
printfarm_scrape_success == 0
```

## Security notes

- The **exporter is never proxied through nginx** and publishes no host port, so
  `printfarm_*` metrics are unreachable from the public `:8080` site. Only
  Prometheus exposes a host port (`PROMETHEUS_PORT`), and only in Compose.
- The exporter is strictly **read-only**: it never writes to or creates schema in
  PostgreSQL, and it reports a database error as `printfarm_scrape_success 0`
  instead of crashing.
- No connection secrets (printer IP, API key/access code, serial) are emitted as
  metrics or labels.
- In Kubernetes the Prometheus Service is ClusterIP by default; expose it
  deliberately (NodePort/LoadBalancer/ingress) only if an external Grafana needs
  it.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `printfarm` target `DOWN` in Status → Targets | Exporter not running or wrong port. Check `docker compose logs exporter`; confirm the target matches `EXPORTER_PORT`. |
| `printfarm_scrape_success` is `0` | Exporter can't reach PostgreSQL. Verify `DATABASE_URL` and that `db` is healthy; the exporter log prints the error. |
| Grafana panels say "No data" | Datasource URL not reachable from Grafana, or the dashboard's datasource variable points at the wrong source. Re-check the URL in the datasource provisioning file. |
| Metrics history gaps after an analytics reset | Expected — `Reset analytics` resets the cumulative counters; use `rate()`/`increase()` which tolerate counter resets. |
| Empty Prometheus after redeploy (k8s) | The `prometheus-pvc` must detach from the old pod first; the `Recreate` strategy handles this — make sure the PVC bound and the volume mounted. |
