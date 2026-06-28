package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// mutations.go ports the operator/admin write handlers from server/app.js. The
// authorization gate (authorizeFrontendApi) has already enforced the role and
// CSRF checks before any of these run; here we only do per-route validation and
// the DB write, mirroring each Node handler's response shape.
//
// handleMutations is invoked from the route switch in api.go for the mutation
// paths; it returns true once it has handled the request.
func handleMutations(w http.ResponseWriter, req *http.Request, sessFn func() *sessionRow) bool {
	ctx := req.Context()
	p := req.URL.Path
	m := req.Method

	switch {
	case p == "/api/printers" && m == http.MethodPost:
		body, err := rawBody(req)
		if err != nil {
			badRequest(w, "Invalid form submission")
			return true
		}
		if err := upsertPrinter(ctx, body); err != nil {
			internalError(w, "upsertPrinter", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case strings.HasPrefix(p, "/api/printers/") && strings.HasSuffix(p, "/command") && m == http.MethodPost:
		handlePrinterCommand(ctx, w, req)
		return true

	case strings.HasPrefix(p, "/api/printers/") && m == http.MethodDelete:
		id := decodePathSegment(p, "/api/printers/", "")
		if err := deletePrinter(ctx, id); err != nil {
			internalError(w, "deletePrinter", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case p == "/api/queue/reset" && m == http.MethodPost:
		if err := resetQueueJobs(ctx); err != nil {
			internalError(w, "resetQueueJobs", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case strings.HasPrefix(p, "/api/queue/") && strings.HasSuffix(p, "/printed") && m == http.MethodPost:
		id := decodePathSegment(p, "/api/queue/", "/printed")
		if err := markQueueJobPrinted(ctx, id); err != nil {
			internalError(w, "markQueueJobPrinted", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case strings.HasPrefix(p, "/api/queue/") && m == http.MethodDelete:
		id := decodePathSegment(p, "/api/queue/", "")
		if err := deleteQueueJob(ctx, id); err != nil {
			internalError(w, "deleteQueueJob", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case p == "/api/analytics/daily/reset" && m == http.MethodPost:
		if err := resetDailyAnalytics(ctx); err != nil {
			internalError(w, "resetDailyAnalytics", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case strings.HasPrefix(p, "/api/maintenance/") && strings.HasSuffix(p, "/complete") && m == http.MethodPost:
		handleMaintenanceComplete(ctx, w, req)
		return true

	case p == "/api/maintenance/notifications/read" && m == http.MethodPost:
		var body struct {
			IDs []string `json:"ids"`
		}
		_ = readJSONBody(req, &body)
		if err := markMaintenanceNotificationsRead(ctx, body.IDs); err != nil {
			internalError(w, "markMaintenanceNotificationsRead", err)
			return true
		}
		sendEmpty(w, http.StatusNoContent)
		return true

	case p == "/api/settings/maintenance-intervals" && m == http.MethodPut:
		body, _ := rawBody(req)
		intervals, err := setMaintenanceDefaultIntervals(ctx, intervalsFromBody(body))
		if err != nil {
			internalError(w, "setMaintenanceDefaultIntervals", err)
			return true
		}
		sendJSON(w, http.StatusOK, intervals, "")
		return true

	case p == "/api/settings/branding" && m == http.MethodPut:
		handleBrandingPut(ctx, w, req)
		return true

	case p == "/api/settings/integrations" && m == http.MethodPut:
		handleIntegrationsPut(ctx, w, req)
		return true

	case p == "/api/settings/public-viewer" && m == http.MethodPut:
		handlePublicViewerPut(ctx, w, req)
		return true

	case p == "/api/settings/analytics-layout" && m == http.MethodPut:
		handleAnalyticsLayoutPut(ctx, w, req)
		return true

	case strings.HasPrefix(p, "/api/settings/printer-card-layout/") && m == http.MethodPut:
		handlePrinterCardLayoutPut(ctx, w, req)
		return true

	case p == "/api/audit-logs" && m == http.MethodGet:
		limit := atoiDefault(req.URL.Query().Get("limit"), 200)
		data, err := listAuditLogsJSON(ctx, limit)
		respondStoreJSON(w, data, err, "")
		return true

	case p == "/api/audit-logs" && m == http.MethodPost:
		handleAuditLogPost(ctx, w, req, sessFn)
		return true
	}

	return handleUserRoutes(w, req)
}

// ── maintenance/:id/complete ─────────────────────────────────────────────────

func handleMaintenanceComplete(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	id := decodePathSegment(req.URL.Path, "/api/maintenance/", "/complete")
	var body struct {
		Notes string `json:"notes"`
	}
	_ = readJSONBody(req, &body)
	var notes *string
	if n := strings.TrimSpace(body.Notes); n != "" {
		notes = &n
	}
	event, err := completeMaintenanceEvent(ctx, id, notes)
	if err != nil {
		internalError(w, "completeMaintenanceEvent", err)
		return
	}
	if event == nil {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "Pending maintenance task not found"}, "")
		return
	}
	sendJSON(w, http.StatusOK, event, "")
}

// ── settings PUT handlers ────────────────────────────────────────────────────

func handleIntegrationsPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	// Decode into a generic map so type checks match Node's typeof semantics
	// exactly (json.Unmarshal into a *string would allocate a non-nil zero value
	// on a type mismatch, defeating a nil check).
	m := decodeBodyMap(req)
	gs, ok1 := m["googleSheetQueueUrl"].(string)
	gf, ok2 := m["googleFormUrl"].(string)
	if !ok1 || !ok2 {
		badRequest(w, "googleSheetQueueUrl and googleFormUrl must be strings")
		return
	}
	value := map[string]any{
		"googleSheetQueueUrl": strings.TrimSpace(gs),
		"googleFormUrl":       strings.TrimSpace(gf),
	}
	if err := setAppSetting(ctx, "integration_urls", value); err != nil {
		internalError(w, "setAppSetting integrations", err)
		return
	}
	stored, err := getAppSetting(ctx, "integration_urls")
	respondShaped(w, integrationUrlsShape(stored), err)
}

func handlePublicViewerPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	m := decodeBodyMap(req)
	enabled, ok := m["enabled"].(bool)
	if !ok {
		badRequest(w, "enabled must be a boolean")
		return
	}
	if err := setAppSetting(ctx, "public_viewer", map[string]any{"enabled": enabled}); err != nil {
		internalError(w, "setAppSetting public_viewer", err)
		return
	}
	stored, err := getAppSetting(ctx, "public_viewer")
	respondShaped(w, publicViewerShape(stored), err)
}

func handleAnalyticsLayoutPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	var body struct {
		Layout []map[string]any `json:"layout"`
	}
	if err := readJSONBody(req, &body); err != nil || body.Layout == nil || !validGridLayout(body.Layout) {
		badRequest(w, "layout must be an array of {i,x,y,w,h} items")
		return
	}
	if err := setAppSetting(ctx, "analytics_layout", body.Layout); err != nil {
		internalError(w, "setAppSetting analytics_layout", err)
		return
	}
	sendEmpty(w, http.StatusNoContent)
}

func validGridLayout(items []map[string]any) bool {
	for _, it := range items {
		if _, ok := it["i"].(string); !ok {
			return false
		}
		for _, k := range []string{"x", "y", "w", "h"} {
			if _, ok := it[k].(float64); !ok {
				return false
			}
		}
	}
	return true
}

func handlePrinterCardLayoutPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	profile := decodePathSegment(req.URL.Path, "/api/settings/printer-card-layout/", "")
	if !printerCardLayoutProfiles[profile] {
		badRequest(w, "unknown printer profile")
		return
	}
	var body struct {
		Layout []json.RawMessage `json:"layout"`
	}
	if err := readJSONBody(req, &body); err != nil || body.Layout == nil || !allArrays(body.Layout) {
		badRequest(w, "layout must be an array of arrays")
		return
	}
	if err := setAppSetting(ctx, "printer_card_layout:"+profile, body.Layout); err != nil {
		internalError(w, "setAppSetting printer_card_layout", err)
		return
	}
	sendEmpty(w, http.StatusNoContent)
}

func allArrays(items []json.RawMessage) bool {
	for _, it := range items {
		t := strings.TrimSpace(string(it))
		if len(t) == 0 || t[0] != '[' {
			return false
		}
	}
	return true
}

// ── audit-logs POST ──────────────────────────────────────────────────────────

func handleAuditLogPost(ctx context.Context, w http.ResponseWriter, req *http.Request, sessFn func() *sessionRow) {
	var body struct {
		Action  string          `json:"action"`
		Target  *string         `json:"target"`
		Details json.RawMessage `json:"details"`
	}
	_ = readJSONBody(req, &body)
	if strings.TrimSpace(body.Action) == "" {
		badRequest(w, "action is required")
		return
	}
	sess := sessFn()
	entry := auditEntry{Action: body.Action, Target: body.Target, Source: "web", IP: getClientIP(req)}
	if sess != nil {
		entry.ActorName = &sess.Name
		entry.ActorUsername = &sess.Username
		entry.ActorRole = &sess.Role
	}
	if len(body.Details) > 0 && !isJSONNull(body.Details) {
		entry.Details = body.Details
	}
	if err := recordAuditLog(ctx, entry); err != nil {
		internalError(w, "recordAuditLog", err)
		return
	}
	sendEmpty(w, http.StatusCreated)
}

// ── shared helpers ───────────────────────────────────────────────────────────

// decodeBodyMap decodes the request body into a generic map so per-field type
// checks match Node's typeof semantics (a missing or wrong-typed field is absent
// / has the wrong Go dynamic type, rather than a non-nil zero pointer).
func decodeBodyMap(req *http.Request) map[string]any {
	var m map[string]any
	_ = readJSONBody(req, &m)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func rawBody(req *http.Request) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := readJSONBody(req, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// intervalsFromBody mirrors `Array.isArray(body) ? body : body?.intervals`.
func intervalsFromBody(body json.RawMessage) json.RawMessage {
	t := strings.TrimSpace(string(body))
	if len(t) > 0 && t[0] == '[' {
		return body
	}
	var wrap struct {
		Intervals json.RawMessage `json:"intervals"`
	}
	_ = json.Unmarshal(body, &wrap)
	return wrap.Intervals
}

func badRequest(w http.ResponseWriter, msg string) {
	sendJSON(w, http.StatusBadRequest, map[string]any{"error": msg}, "")
}

func internalError(w http.ResponseWriter, where string, err error) {
	logError(where+" failed", map[string]any{"err": err.Error()})
	sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
}

func atoiDefault(s string, def int) int {
	if v, ok := jsParseInt(s); ok {
		return v
	}
	return def
}
