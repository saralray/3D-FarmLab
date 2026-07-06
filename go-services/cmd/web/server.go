package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// statusRecorder captures the response status code (and whether anything was
// written) for metrics and access logging.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// marshalJSON matches Node's JSON.stringify: no trailing newline and no HTML
// escaping of <, >, & (Go's encoding/json escapes those by default; Node does
// not), so byte-for-byte parity with the Node responses holds.
func marshalJSON(payload any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// sendEmpty mirrors sendEmpty in app.js: a no-body response (default 204).
func sendEmpty(w http.ResponseWriter, status int) {
	if status == 0 {
		status = http.StatusNoContent
	}
	w.WriteHeader(status)
}

func sendJSON(w http.ResponseWriter, status int, payload any, cacheControl string) {
	if cacheControl == "" {
		cacheControl = "no-store"
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	_, _ = w.Write(marshalJSON(payload))
}

// handleRequest is the top-level dispatch, mirroring server/app.js handleRequest.
func handleRequest(w http.ResponseWriter, req *http.Request) {
	setSecurityHeaders(req, w.Header())

	pathname := req.URL.Path
	route := classifyRoute(pathname)

	requestID := req.Header.Get("X-Request-Id")
	if requestID == "" {
		requestID = uuid.NewString()
	}
	if len(requestID) > 64 {
		requestID = requestID[:64]
	}
	w.Header().Set("X-Request-Id", requestID)

	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	startedAt := time.Now()
	recordRequestStart()
	defer func() {
		durationMs := float64(time.Since(startedAt).Microseconds()) / 1000.0
		recordRequestEnd(req.Method, rec.status, route, durationMs)
		logHTTP(req, rec.status, route, durationMs, requestID)
	}()

	switch pathname {
	case "/healthz":
		sendJSON(rec, http.StatusOK, map[string]any{"ok": true}, "no-store")
		return
	case "/readyz":
		readiness := checkReadiness(req.Context())
		status := http.StatusOK
		if !readiness.OK {
			status = http.StatusServiceUnavailable
		}
		sendJSON(rec, status, readiness, "no-store")
		return
	case "/metrics":
		rec.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		rec.Header().Set("Cache-Control", "no-store")
		rec.Write([]byte(renderMetrics()))
		return
	}

	// Friendly SSO deep-link: 302 to the canonical SAML start (outside /api, so the
	// frontend gate doesn't apply — mirrors Node's handleApi /launch case).
	if pathname == "/launch" && req.Method == http.MethodGet {
		sendRedirect(rec, "/api/auth/saml/start")
		return
	}

	// API surface (ported incrementally; returns false until a route matches).
	if handleAPI(rec, req) {
		return
	}

	// Printer hardware passthrough: control API, camera HTTP endpoint, and the
	// friendly /webcam/<id-or-name> stream URL.
	// C-1 FIX: require an authenticated session before forwarding to the printer
	// proxy. Without this gate any unauthenticated HTTP client that can reach
	// nginx can drive arbitrary Bambu / Moonraker commands on every printer.
	if strings.HasPrefix(pathname, proxyPrefix) || strings.HasPrefix(pathname, webcamPrefix) ||
		strings.HasPrefix(pathname, "/webcam/") {
		isControl := true
		if strings.HasPrefix(pathname, webcamPrefix) || strings.HasPrefix(pathname, "/webcam/") {
			isControl = false
		} else if req.Method == http.MethodGet || req.Method == http.MethodHead {
			// Allow non-control read queries (like objects/query?print_task_config)
			if !strings.Contains(pathname, "/gcode") && !strings.Contains(pathname, "/print/") && !strings.Contains(pathname, "/system/") {
				isControl = false
			}
		}
		if isControl {
			sess, _ := resolveSession(req.Context(), req)
			if sess == nil {
				sendJSON(rec, http.StatusUnauthorized, map[string]any{"error": "Authentication required."}, "")
				return
			}
		}
	}
	if handlePrinterProxy(rec, req, proxyPrefix, proxyTarget) {
		return
	}
	if handlePrinterProxy(rec, req, webcamPrefix, webcamTarget) {
		return
	}
	if handleWebcamStream(rec, req) {
		return
	}

	// Static SPA (and SPA fallback to index.html).
	serveStatic(rec, req)
}

type readinessResult struct {
	OK     bool              `json:"ok"`
	Status string            `json:"status"`
	Checks map[string]string `json:"checks"`
}

func checkReadiness(ctx context.Context) readinessResult {
	checks := map[string]string{}
	ok := true

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := dbPool.Ping(pingCtx); err != nil {
		checks["database"] = "error"
		ok = false
		logWarn("readiness: database check failed", map[string]any{"err": err.Error()})
	} else {
		checks["database"] = "ok"
	}

	if redisEnabled() {
		if redisPing(ctx) {
			checks["redis"] = "ok"
		} else {
			checks["redis"] = "degraded"
		}
	}

	status := "ready"
	if !ok {
		status = "unavailable"
	}
	return readinessResult{OK: ok, Status: status, Checks: checks}
}

// logHTTP samples access logs: every 4xx/5xx, plus all when LOG_HTTP=all.
func logHTTP(req *http.Request, status int, route string, durationMs float64, requestID string) {
	if logHTTPMode == "off" {
		return
	}
	fields := map[string]any{
		"method":     req.Method,
		"route":      route,
		"status":     status,
		"durationMs": int(durationMs + 0.5),
		"reqId":      requestID,
	}
	switch {
	case status >= 500:
		logError("http request", fields)
	case status >= 400:
		logWarn("http request", fields)
	case logHTTPMode == "all" && !quietRoutes[route]:
		logInfo("http request", fields)
	}
}
