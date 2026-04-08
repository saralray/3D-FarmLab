# Stemlab Print Farm

## Docker

Start the full stack:

```bash
docker compose up --build
```

Services:

- `web`: Vite app and Node API on `http://localhost:5173`
- `db`: Postgres on `localhost:5432`
- `poller`: Python background service that updates printer status in Postgres

Relevant environment variables:

- `DATABASE_URL`
- `PRINTER_POLL_INTERVAL_MS`
- `PRINTER_REQUEST_TIMEOUT_MS`
