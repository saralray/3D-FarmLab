package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// handleAPI is the entry point for the /api/*, /api/v1, and printer-proxy
// surface. It is being ported group by group (see WEB_PORT_PLAN.md). Each block
// returns true once it has handled the request; an unmatched path returns false
// so the request falls through to static serving. While the Node web service
// remains the live container, this Go server is run only for parity testing.
func handleAPI(w http.ResponseWriter, req *http.Request) bool {
	pathname := req.URL.Path
	if !strings.HasPrefix(pathname, "/api/") {
		return false
	}
	ctx := req.Context()

	// Key-gated /api/v1 data API authenticates itself (X-Api-Key / Bearer) and is
	// entirely separate from the cookie-session frontend surface — it runs before
	// the default-deny gate, mirroring handleApi → handleDataApi in app.js.
	if handleDataApi(ctx, w, req) {
		return true
	}

	// Build-id probe: public and before the gate, mirroring app.js handleApi.
	if pathname == "/api/version" && req.Method == http.MethodGet {
		sendJSON(w, http.StatusOK, map[string]any{"buildId": buildID()}, "no-store")
		return true
	}

	// Lazily resolve (and memoize) the session, mirroring Node's req._session
	// cache — public reads that never need it skip the DB lookup entirely.
	var (
		cachedSess  *sessionRow
		sessFetched bool
	)
	sessFn := func() *sessionRow {
		if !sessFetched {
			cachedSess, _ = resolveSession(ctx, req)
			sessFetched = true
		}
		return cachedSess
	}

	// Default-deny authorization gate (CSRF + role) for the cookie-authenticated
	// frontend surface. The key-gated /api/v1 API authenticates itself separately.
	if !authorizeFrontendApi(w, req, sessFn) {
		return true
	}

	if handleAuthRoutes(w, req, sessFn) {
		return true
	}

	if handleSSORoutes(w, req) {
		return true
	}

	// Auth hand-off completers: slicer operator grant, session-bound slicer token,
	// and the Google/Microsoft OAuth login dance.
	if handleOAuthRoutes(ctx, w, req, sessFn) {
		return true
	}

	if handleMutations(w, req, sessFn) {
		return true
	}

	// Manager access-request workflow + admin Discord-webhook / slicer-key CRUD.
	if handleManagerRoutes(ctx, w, req) {
		return true
	}
	if handleNotificationsRoutes(ctx, w, req) {
		return true
	}
	if handleSlicerKeysRoutes(ctx, w, req) {
		return true
	}

	// Public queue intake (multipart submit) and stored-model download.
	if handleQueueIntake(w, req) {
		return true
	}

	switch {
	// GET /api/printers — connection secrets only reach an operator/admin session;
	// anonymous/viewer/student callers always get the redacted list. (The
	// privileged path is wired once sessions land in Phase 3; until then every
	// request is treated as non-privileged, matching an anonymous caller.)
	case pathname == "/api/printers" && req.Method == http.MethodGet:
		// Connection secrets only reach an operator/admin session; everyone else
		// gets the always-redacted list (listPrintersRedacted forces redaction
		// regardless of viewer mode).
		data, err := listPrintersJSON(ctx, isPrivileged(sessFn()))
		respondStoreJSON(w, data, err, "")
		return true

	// Live-view camera health (all cameras), from the in-memory camera hub.
	case pathname == "/api/cameras/health" && req.Method == http.MethodGet:
		sendJSON(w, http.StatusOK, getAllCameraHealth(), "no-store")
		return true

	// Per-printer camera health — the running health() shape (with name) when a
	// stream exists, else the idle default (no name).
	case strings.HasPrefix(pathname, "/api/printers/") &&
		strings.HasSuffix(pathname, "/camera/health") && req.Method == http.MethodGet:
		id := decodePathSegment(pathname, "/api/printers/", "/camera/health")
		sendJSON(w, http.StatusOK, getCameraHealth(id), "no-store")
		return true

	// Per-printer maintenance summary. Must precede the generic /api/printers/:id
	// GET below so the longer path isn't swallowed by it.
	case strings.HasPrefix(pathname, "/api/printers/") &&
		strings.HasSuffix(pathname, "/maintenance") && req.Method == http.MethodGet:
		id := decodePathSegment(pathname, "/api/printers/", "/maintenance")
		summary, err := getPrinterMaintenance(ctx, id)
		if err != nil {
			respondShaped(w, nil, err)
			return true
		}
		if summary == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		sendJSON(w, http.StatusOK, summary, "no-store")
		return true

	// GET /api/printers/:id — redacted single read (privileged path lands in
	// Phase 3). Must come after the longer /camera/health suffix above.
	case strings.HasPrefix(pathname, "/api/printers/") && req.Method == http.MethodGet:
		id := decodePathSegment(pathname, "/api/printers/", "")
		data, err := getPrinterByIdJSON(ctx, id, isPrivileged(sessFn()))
		if err == nil && data == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		respondStoreJSON(w, data, err, "")
		return true

	case pathname == "/api/analytics/daily" && req.Method == http.MethodGet:
		data, err := listDailyAnalyticsJSON(ctx, 7)
		respondStoreJSON(w, data, err, "")
		return true

	case pathname == "/api/queue" && req.Method == http.MethodGet:
		data, err := listQueueDataJSON(ctx)
		respondStoreJSON(w, data, err, "")
		return true

	// Maintenance fleet-widget aggregates.
	case pathname == "/api/maintenance/summary" && req.Method == http.MethodGet:
		summary, err := getMaintenanceSummary(ctx)
		if err != nil {
			respondShaped(w, nil, err)
			return true
		}
		sendJSON(w, http.StatusOK, summary, "no-store")
		return true

	// In-app maintenance notifications (NotificationBell feed).
	case pathname == "/api/maintenance/notifications" && req.Method == http.MethodGet:
		unreadOnly := req.URL.Query().Get("unread") == "true"
		notes, err := listMaintenanceNotifications(ctx, unreadOnly, 100)
		if err != nil {
			respondShaped(w, nil, err)
			return true
		}
		sendJSON(w, http.StatusOK, notes, "no-store")
		return true

	// List maintenance tasks with optional printer / status / type filters.
	case pathname == "/api/maintenance" && req.Method == http.MethodGet:
		q := req.URL.Query()
		status := q.Get("status")
		if status == "" {
			status = "pending"
		}
		events, err := listMaintenanceEvents(ctx, q.Get("printer"), status, q.Get("type"), 500)
		if err != nil {
			respondShaped(w, nil, err)
			return true
		}
		sendJSON(w, http.StatusOK, events, "no-store")
		return true

	// Global default maintenance intervals (GET is a public read).
	case pathname == "/api/settings/maintenance-intervals" && req.Method == http.MethodGet:
		intervals, err := getMaintenanceDefaultIntervals(ctx)
		if err != nil {
			respondShaped(w, nil, err)
			return true
		}
		sendJSON(w, http.StatusOK, intervals, "")
		return true

	// Settings reads the SPA fetches on load. Writes (PUT) are gated/handled in a
	// later phase; only GET is ported here.
	case pathname == "/api/settings/branding" && req.Method == http.MethodGet:
		stored, err := getAppSetting(ctx, "branding")
		respondShaped(w, brandingShape(stored), err)
		return true

	// Serves the stored favicon data URL as a raw image (404 when none set) so the
	// PWA manifest can reference it by URL. Public read.
	case pathname == "/api/settings/favicon" && req.Method == http.MethodGet:
		handleFaviconGet(ctx, w, req)
		return true

	case pathname == "/api/settings/integrations" && req.Method == http.MethodGet:
		stored, err := getAppSetting(ctx, "integration_urls")
		respondShaped(w, integrationUrlsShape(stored), err)
		return true

	case pathname == "/api/settings/public-viewer" && req.Method == http.MethodGet:
		stored, err := getAppSetting(ctx, "public_viewer")
		respondShaped(w, publicViewerShape(stored), err)
		return true

	case pathname == "/api/settings/analytics-layout" && req.Method == http.MethodGet:
		stored, err := getAppSetting(ctx, "analytics_layout")
		respondShaped(w, layoutShape(stored), err)
		return true

	case strings.HasPrefix(pathname, "/api/settings/printer-card-layout/") && req.Method == http.MethodGet:
		profile := decodePathSegment(pathname, "/api/settings/printer-card-layout/", "")
		if !printerCardLayoutProfiles[profile] {
			sendJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown printer profile"}, "")
			return true
		}
		stored, err := getAppSetting(ctx, "printer_card_layout:"+profile)
		respondShaped(w, layoutShape(stored), err)
		return true
	}

	return false
}

// isPrivileged reports whether a resolved session is operator/admin.
func isPrivileged(sess *sessionRow) bool {
	return sess != nil && isPrivilegedRole(sess.Role)
}

func decodePathSegment(pathname, prefix, suffix string) string {
	s := pathname[len(prefix):]
	if suffix != "" {
		s = s[:len(s)-len(suffix)]
	}
	if dec, err := decodeURIComponent(s); err == nil {
		return dec
	}
	return s
}

// respondStoreJSON writes a raw json.RawMessage from the store, or a 500 on error.
func respondStoreJSON(w http.ResponseWriter, data json.RawMessage, err error, cacheControl string) {
	if err != nil {
		logError("store read failed", map[string]any{"err": err.Error()})
		sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
		return
	}
	// Re-serialize Postgres json output to match Node's JSON.parse→JSON.stringify
	// (compact, JS-normalized numbers, preserved key order).
	sendRawJSON(w, http.StatusOK, jsCompact(data), cacheControl)
}

// respondShaped writes a computed value as JSON, or a 500 on error.
func respondShaped(w http.ResponseWriter, value any, err error) {
	if err != nil {
		logError("settings read failed", map[string]any{"err": err.Error()})
		sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
		return
	}
	sendJSON(w, http.StatusOK, value, "")
}

// sendRawJSON writes already-encoded JSON bytes with the standard headers.
func sendRawJSON(w http.ResponseWriter, status int, data json.RawMessage, cacheControl string) {
	if cacheControl == "" {
		cacheControl = "no-store"
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	if len(data) == 0 {
		_, _ = w.Write([]byte("null"))
		return
	}
	_, _ = w.Write(data)
}

// cameraHealth mirrors the idle-default shape from getCameraHealth in
// server/bambuCamera.js. Ordered struct fields keep Node's key order; lastFrameAgeMs
// and lastError are JSON null. Until the camera hub is ported (Phase 7) there are
// no live streams, so every printer reports this idle default.
type cameraHealth struct {
	PrinterID      string  `json:"printerId"`
	Status         string  `json:"status"`
	Online         bool    `json:"online"`
	Viewers        int     `json:"viewers"`
	LastFrameAgeMs *int    `json:"lastFrameAgeMs"`
	Frames         int     `json:"frames"`
	Restarts       int     `json:"restarts"`
	UptimeMs       int     `json:"uptimeMs"`
	LastError      *string `json:"lastError"`
}

func idleCameraHealth(printerID string) cameraHealth {
	return cameraHealth{PrinterID: printerID, Status: "idle"}
}
