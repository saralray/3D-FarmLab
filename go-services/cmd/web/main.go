package main

// Command web is the Go port of the Node web service (server/app.js +
// server/postgres.js + support modules). It serves the React SPA and the
// /api/* + /api/v1 surface. The port is phased (see WEB_PORT_PLAN.md); the Node
// service stays the live container until this reaches full parity.

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"printfarm/internal/db"
)

var dbPool *pgxpool.Pool

func main() {
	ctx := context.Background()

	pool, err := db.NewPool(ctx,
		time.Duration(maxIntVal(dbConnectTimeoutMs/1000, 1))*time.Second,
		dbStatementTimeout, dbIdleTxTimeout, dbPoolMax)
	if err != nil {
		logError("failed to create database pool", map[string]any{"err": err.Error()})
		os.Exit(1)
	}
	dbPool = pool
	defer pool.Close()

	initRedis()

	// Background Home-Assistant automation engine (mirrors startHaAutomationEngine).
	engineCtx, engineCancel := context.WithCancel(context.Background())
	defer engineCancel()
	startHaAutomationEngine(engineCtx)

	srv := &http.Server{
		Addr:    ":" + strconv.Itoa(webPort),
		Handler: http.HandlerFunc(handleRequest),
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		logInfo("web server listening", map[string]any{"port": webPort})
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logError("web server failed", map[string]any{"err": err.Error()})
			os.Exit(1)
		}
	}()

	<-stop
	logInfo("web server shutting down", nil)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	logInfo("web server stopped", nil)
}

func maxIntVal(a, b int) int {
	if a > b {
		return a
	}
	return b
}
