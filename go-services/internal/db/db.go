// Package db holds the small Postgres helpers shared by the Go print-farm
// services (exporter, poller). It mirrors the connection conventions used by the
// Python/Node services: a DATABASE_URL DSN, a bounded connect timeout, and a
// server-side statement_timeout so a slow/locked query fails fast instead of
// hanging the caller.
package db

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// URL returns the configured DATABASE_URL or an error when it is unset, matching
// the Python services which refuse to run without it.
func URL() (string, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return "", fmt.Errorf("DATABASE_URL is not configured")
	}
	return url, nil
}

// EnvInt reads an integer environment variable, returning def when unset or
// unparseable. The result is clamped to be >= min.
func EnvInt(name string, def, min int) int {
	v := def
	if raw := os.Getenv(name); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			v = parsed
		}
	}
	if v < min {
		v = min
	}
	return v
}

// Connect opens a single fresh connection with the given connect timeout and a
// server-side statement_timeout (milliseconds; 0 disables). Callers close it.
func Connect(ctx context.Context, connectTimeout time.Duration, statementTimeoutMs int) (*pgx.Conn, error) {
	url, err := URL()
	if err != nil {
		return nil, err
	}

	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnectTimeout = connectTimeout
	if statementTimeoutMs > 0 {
		// Applied as a session GUC at connect time, equivalent to the Python
		// exporter's `options=-c statement_timeout=...`.
		cfg.RuntimeParams["statement_timeout"] = strconv.Itoa(statementTimeoutMs)
	}

	return pgx.ConnectConfig(ctx, cfg)
}
