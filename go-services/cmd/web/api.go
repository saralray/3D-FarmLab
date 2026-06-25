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

	switch {
	// GET /api/printers — connection secrets only reach an operator/admin session;
	// anonymous/viewer/student callers always get the redacted list. (The
	// privileged path is wired once sessions land in Phase 3; until then every
	// request is treated as non-privileged, matching an anonymous caller.)
	case pathname == "/api/printers" && req.Method == http.MethodGet:
		var (
			data json.RawMessage
			err  error
		)
		if isPrivilegedRequest(req) {
			data, err = listPrintersJSON(ctx, true)
		} else {
			data, err = listPrintersJSON(ctx, false)
		}
		// listPrintersRedacted forces redaction regardless of viewer mode; the
		// false branch above already passes includeSensitive=false.
		respondStoreJSON(w, data, err, "")
		return true

	// Live-view camera health (all cameras). In-memory in Node; until the camera
	// hub is ported (Phase 7) there are no live streams, so this is an empty list.
	case pathname == "/api/cameras/health" && req.Method == http.MethodGet:
		sendRawJSON(w, http.StatusOK, json.RawMessage("[]"), "no-store")
		return true

	// Per-printer camera health — idle default until the hub is ported.
	case strings.HasPrefix(pathname, "/api/printers/") &&
		strings.HasSuffix(pathname, "/camera/health") && req.Method == http.MethodGet:
		id := decodePathSegment(pathname, "/api/printers/", "/camera/health")
		sendJSON(w, http.StatusOK, idleCameraHealth(id), "no-store")
		return true

	// GET /api/printers/:id — redacted single read (privileged path lands in
	// Phase 3). Must come after the longer /camera/health suffix above.
	case strings.HasPrefix(pathname, "/api/printers/") && req.Method == http.MethodGet:
		id := decodePathSegment(pathname, "/api/printers/", "")
		var (
			data json.RawMessage
			err  error
		)
		if isPrivilegedRequest(req) {
			data, err = getPrinterByIdJSON(ctx, id, true)
		} else {
			data, err = getPrinterByIdJSON(ctx, id, false)
		}
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

	// Settings reads the SPA fetches on load. Writes (PUT) are gated/handled in a
	// later phase; only GET is ported here.
	case pathname == "/api/settings/branding" && req.Method == http.MethodGet:
		stored, err := getAppSetting(ctx, "branding")
		respondShaped(w, brandingShape(stored), err)
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

// isPrivilegedRequest reports whether the caller is an operator/admin session.
// Sessions are not yet ported (Phase 3); until then every caller is treated as
// non-privileged, which matches an anonymous request to the Node server.
func isPrivilegedRequest(req *http.Request) bool {
	_ = req
	return false
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
