package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"

	"printfarm/internal/pwcrypto"
)

// dataapi.go ports handleDataApi* from server/app.js: the versioned, API-key-gated
// programmatic data API under /api/v1. It is entirely separate from the cookieless
// frontend /api/* surface — the key is the guard, so connection secrets are NOT
// redacted and a printfarm_manage key grants full read/write. Mutations are stamped
// into the audit log with source 'api'. Authentication reuses the slicer_api_keys
// store (X-Api-Key header or Authorization: Bearer <key>).

const dataAPIPrefix = "/api/v1/"

// dataAPIResources mirrors DATA_API_RESOURCES (order preserved for the discovery
// root response).
var dataAPIResources = []string{
	"printers", "queue", "analytics", "notifications", "slicer-keys",
	"audit-logs", "settings", "users", "admin-credential", "manager-requests",
	"maintenance",
}

// slicerKeyPermissions mirrors SLICER_KEY_PERMISSIONS (stable order).
var slicerKeyPermissions = []string{"slicer_upload", "printfarm_manage"}

// extractApiKey mirrors the Node helper: trimmed X-Api-Key, else a Bearer token.
func extractApiKey(req *http.Request) string {
	if k := strings.TrimSpace(req.Header.Get("X-Api-Key")); k != "" {
		return k
	}
	auth := req.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

func keyHasPermission(rec *slicerKeyRecord, perm string) bool {
	for _, p := range rec.Permissions {
		if p == perm {
			return true
		}
	}
	return false
}

// normalizeKeyPermissions keeps only recognized scopes, preserving a stable order.
func normalizeKeyPermissions(input []string) []string {
	out := []string{}
	for _, perm := range slicerKeyPermissions {
		for _, candidate := range input {
			if candidate == perm {
				out = append(out, perm)
				break
			}
		}
	}
	return out
}

// auditDataApi records a best-effort audit entry for a key-driven mutation; never
// blocks the response (detached, background context — the request context may be
// cancelled once the response is written).
func auditDataApi(req *http.Request, apiKey *slicerKeyRecord, action string, target *string, details any) {
	actorName := "api:" + apiKey.Name
	actorUser := apiKey.ID
	actorRole := "api"
	ip := getClientIP(req)
	go func() {
		_ = recordAuditLog(context.Background(), auditEntry{
			ActorName: &actorName, ActorUsername: &actorUser, ActorRole: &actorRole,
			Action: action, Target: target, Details: details, Source: "api", IP: ip,
		})
	}()
}

func strPtr(s string) *string { return &s }

func handleDataApi(ctx context.Context, w http.ResponseWriter, req *http.Request) bool {
	pathname := req.URL.Path
	if !strings.HasPrefix(pathname, dataAPIPrefix) {
		return false
	}

	key := extractApiKey(req)
	var apiKey *slicerKeyRecord
	if key != "" {
		rec, err := findSlicerApiKeyByHash(ctx, pwcrypto.Hash(key))
		if err != nil {
			internalError(w, "findSlicerApiKeyByHash", err)
			return true
		}
		apiKey = rec
	}
	if apiKey == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{
			"error": "A valid API key is required. Pass it as the X-Api-Key header or `Authorization: Bearer <key>`.",
		}, "")
		return true
	}
	// Best-effort usage stamp, like Node's touchSlicerApiKey(...).catch().
	id := apiKey.ID
	go func() { _ = touchSlicerApiKey(context.Background(), id) }()

	if !keyHasPermission(apiKey, "printfarm_manage") {
		sendJSON(w, http.StatusForbidden, map[string]any{
			"error": "This API key lacks the 'printfarm_manage' permission required for the /api/v1 data API.",
		}, "")
		return true
	}

	method := req.Method
	rawSegs := splitNonEmpty(pathname[len(dataAPIPrefix):])
	segments := make([]string, len(rawSegs))
	for i, s := range rawSegs {
		segments[i], _ = decodeURIComponent(s)
	}
	entity, segID, sub := "", "", ""
	if len(segments) > 0 {
		entity = segments[0]
	}
	if len(segments) > 1 {
		segID = segments[1]
	}
	if len(segments) > 2 {
		sub = segments[2]
	}

	// Discovery root: GET /api/v1/ lists the available resources.
	if entity == "" {
		sendJSON(w, http.StatusOK, ojson{{"version", "v1"}, {"resources", dataAPIResources}}, "")
		return true
	}

	dctx := dataAPICtx{ctx: ctx, apiKey: apiKey, method: method, id: segID, sub: sub}
	switch entity {
	case "printers":
		if len(segments) > 3 {
			dctx.action = segments[3]
		}
		return handleDataApiPrinters(w, req, dctx)
	case "queue":
		return handleDataApiQueue(w, req, dctx)
	case "analytics":
		return handleDataApiAnalytics(w, req, dctx)
	case "notifications":
		return handleDataApiNotifications(w, req, dctx)
	case "slicer-keys":
		return handleDataApiSlicerKeys(w, req, dctx)
	case "audit-logs":
		return handleDataApiAuditLogs(w, req, dctx)
	case "settings":
		return handleDataApiSettings(w, req, dctx)
	case "users":
		return handleDataApiUsers(w, req, dctx)
	case "admin-credential":
		return handleDataApiAdminCredential(w, req, dctx)
	case "manager-requests":
		return handleDataApiManagerRequests(w, req, dctx)
	case "maintenance":
		return handleDataApiMaintenance(w, req, dctx)
	default:
		sendJSON(w, http.StatusNotFound, ojson{
			{"error", "Unknown resource '" + entity + "'."}, {"resources", dataAPIResources},
		}, "")
		return true
	}
}

// dataAPICtx carries the parsed route + the authenticated key through a handler.
type dataAPICtx struct {
	ctx    context.Context
	apiKey *slicerKeyRecord
	method string
	id     string
	sub    string
	action string
}

func dataApiMethodNotAllowed(w http.ResponseWriter) bool {
	sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed for this resource."}, "")
	return true
}

// sendStoreJSON emits a store RawMessage (already json_build_object-shaped) the way
// the frontend reads do: jsCompact-normalized bytes, default no-store.
func sendStoreJSON(w http.ResponseWriter, data json.RawMessage, err error) bool {
	if err != nil {
		internalError(w, "data api store read", err)
		return true
	}
	sendRawJSON(w, http.StatusOK, jsCompact(data), "no-store")
	return true
}

// ── printers ─────────────────────────────────────────────────────────────────

func handleDataApiPrinters(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			data, err := listPrintersJSON(ctx, true)
			return sendStoreJSON(w, data, err)
		case http.MethodPost:
			raw, _ := rawBody(req)
			pid := stringField(raw, "id")
			if strings.TrimSpace(pid) == "" {
				badRequest(w, "printer id is required")
				return true
			}
			if err := upsertPrinter(ctx, raw); err != nil {
				internalError(w, "upsertPrinter", err)
				return true
			}
			auditDataApi(req, d.apiKey, "printer.upsert", &pid, nil)
			data, err := getPrinterByIdJSON(ctx, pid, true)
			return sendStoreJSON(w, data, err)
		}
		return dataApiMethodNotAllowed(w)
	}

	// POST /printers/:id/command — proxy a Bambu MQTT command.
	if d.sub == "command" && d.method == http.MethodPost {
		printer, err := getPrinterConn(ctx, d.id)
		if err != nil {
			internalError(w, "getPrinterConn", err)
			return true
		}
		if printer == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		body := decodeBodyMap(req)
		command := commandDisplay(body, "command")
		if err := sendBambuCommand(printer, command, body); err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()}, "")
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"command", body["command"]}}))
		auditDataApi(req, d.apiKey, "printer.command", &d.id, details)
		sendEmpty(w, http.StatusNoContent)
		return true
	}

	// ALL /printers/:id/proxy/<path...> — raw HTTP passthrough to printer hardware.
	if d.sub == "proxy" {
		printer, err := getPrinterConn(ctx, d.id)
		if err != nil {
			internalError(w, "getPrinterConn", err)
			return true
		}
		if printer == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		const marker = "/proxy/"
		rawRest := req.URL.Path[strings.Index(req.URL.Path, marker)+len(marker):]
		segs := splitNonEmpty(rawRest)
		for i := range segs {
			segs[i], _ = decodeURIComponent(segs[i])
		}
		// Rewrite to the canonical proxy path (decoded segments; handlePrinterProxy
		// re-encodes once) and strip our own API credentials before relaying.
		req2 := req.Clone(ctx)
		req2.URL.Path = proxyPrefix + printer.ID + "/" + strings.Join(segs, "/")
		req2.Header.Del("X-Api-Key")
		req2.Header.Del("Authorization")
		if d.method != http.MethodGet && d.method != http.MethodHead {
			details := json.RawMessage(marshalJSON(ojson{
				{"method", d.method}, {"path", "/" + strings.Join(segs, "/")},
			}))
			auditDataApi(req, d.apiKey, "printer.proxy", &d.id, details)
		}
		return handlePrinterProxy(w, req2, proxyPrefix, proxyTarget)
	}

	// GET /printers/:id/camera/{snapshot,stream,health}.
	if d.sub == "camera" {
		if d.method != http.MethodGet {
			return dataApiMethodNotAllowed(w)
		}
		if d.action == "health" {
			sendJSON(w, http.StatusOK, getCameraHealth(d.id), "no-store")
			return true
		}
		if d.action != "snapshot" && d.action != "stream" {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Use /camera/snapshot, /camera/stream, or /camera/health."}, "")
			return true
		}
		printer, err := getPrinterConn(ctx, d.id)
		if err != nil {
			internalError(w, "getPrinterConn", err)
			return true
		}
		if printer == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		camPath := "snapshot.jpg"
		if d.action == "stream" && liveMjpegProfiles[printer.Profile] {
			camPath = "stream.mjpg"
		}
		req2 := req.Clone(ctx)
		req2.URL = &url.URL{Path: webcamPrefix + encodeURIComponent(printer.ID) + "/" + camPath}
		return handlePrinterProxy(w, req2, webcamPrefix, webcamTarget)
	}

	switch d.method {
	case http.MethodGet:
		data, err := getPrinterByIdJSON(ctx, d.id, true)
		if err != nil {
			internalError(w, "getPrinterByIdJSON", err)
			return true
		}
		if data == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		sendRawJSON(w, http.StatusOK, jsCompact(data), "no-store")
		return true
	case http.MethodDelete:
		if err := deletePrinter(ctx, d.id); err != nil {
			internalError(w, "deletePrinter", err)
			return true
		}
		auditDataApi(req, d.apiKey, "printer.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── queue ────────────────────────────────────────────────────────────────────

func handleDataApiQueue(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	q := req.URL.Query()

	if d.id == "export" {
		if d.method != http.MethodGet {
			return dataApiMethodNotAllowed(w)
		}
		includePrinted := q.Get("includePrinted") == "true"
		ids := parseIdList(q["ids"])
		jobs, err := exportQueueJobs(ctx, includePrinted, ids)
		if err != nil {
			internalError(w, "exportQueueJobs", err)
			return true
		}
		sendRawJSON(w, http.StatusOK, []byte(`{"jobs":`+string(jsCompact(jobs))+`}`), "no-store")
		return true
	}

	if d.id == "import" {
		if d.method != http.MethodPost {
			return dataApiMethodNotAllowed(w)
		}
		raw, _ := rawBody(req)
		jobs, ok := jobsFromBody(raw)
		if !ok {
			badRequest(w, "expected an array of jobs or { jobs: [...] }")
			return true
		}
		imported, err := importQueueJobs(ctx, jobs)
		if err != nil {
			internalError(w, "importQueueJobs", err)
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"count", imported}}))
		auditDataApi(req, d.apiKey, "queue.import", nil, details)
		sendJSON(w, http.StatusOK, ojson{{"imported", imported}}, "")
		return true
	}

	if d.id == "delete" {
		if d.method != http.MethodPost {
			return dataApiMethodNotAllowed(w)
		}
		raw, _ := rawBody(req)
		ids := parseIdList(idsFromBody(raw))
		if ids == nil {
			badRequest(w, "expected a non-empty array of ids or { ids: [...] }")
			return true
		}
		deleted, err := deleteQueueJobsBulk(ctx, ids)
		if err != nil {
			internalError(w, "deleteQueueJobs", err)
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"ids", ids}, {"deleted", deleted}}))
		auditDataApi(req, d.apiKey, "queue.delete", nil, details)
		sendJSON(w, http.StatusOK, ojson{{"deleted", deleted}}, "")
		return true
	}

	if d.id != "" && d.sub == "file" {
		switch d.method {
		case http.MethodGet:
			streamed, err := streamQueueJobFile(ctx, w, d.id, false)
			if err != nil {
				logError("streamQueueJobFile failed", map[string]any{"err": err.Error()})
				return true
			}
			if !streamed {
				sendJSON(w, http.StatusNotFound, map[string]any{"error": "File not found"}, "")
			}
			return true
		case http.MethodPut:
			content, err := io.ReadAll(io.LimitReader(req.Body, int64(queueUploadMaxBytes)+1))
			if err != nil {
				internalError(w, "read file body", err)
				return true
			}
			if len(content) > queueUploadMaxBytes {
				limitMb := queueUploadMaxBytes / (1024 * 1024)
				sendJSON(w, http.StatusRequestEntityTooLarge,
					map[string]any{"error": "File exceeds the " + itoa(limitMb) + " MB upload limit."}, "")
				return true
			}
			if len(content) == 0 {
				badRequest(w, "Empty request body; send the model file as the raw body.")
				return true
			}
			mime := req.Header.Get("Content-Type")
			if mime == "" {
				mime = "application/octet-stream"
			}
			updated, err := setQueueJobFile(ctx, d.id, content, mime)
			if err != nil {
				internalError(w, "setQueueJobFile", err)
				return true
			}
			if !updated {
				sendJSON(w, http.StatusNotFound, map[string]any{"error": "Queue job not found; import it before uploading its file."}, "")
				return true
			}
			details := json.RawMessage(marshalJSON(ojson{{"bytes", len(content)}}))
			auditDataApi(req, d.apiKey, "queue.file", &d.id, details)
			sendJSON(w, http.StatusOK, ojson{{"id", d.id}, {"fileSize", len(content)}}, "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}

	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			data, err := listQueueDataJSON(ctx)
			return sendStoreJSON(w, data, err)
		case http.MethodPost:
			raw, _ := rawBody(req)
			jobs, ok := jobsFromBody(raw)
			if !ok {
				badRequest(w, "expected an array of jobs or { jobs: [...] }")
				return true
			}
			added, err := upsertQueueJobs(ctx, jobs)
			if err != nil {
				internalError(w, "upsertQueueJobs", err)
				return true
			}
			details := json.RawMessage(marshalJSON(ojson{{"count", jsonArrayLen(jobs)}}))
			auditDataApi(req, d.apiKey, "queue.upsert", nil, details)
			sendRawJSON(w, http.StatusOK, []byte(`{"added":`+string(jsCompact(added))+`}`), "no-store")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}

	if d.id == "reset" && d.method == http.MethodPost {
		if err := resetQueueJobs(ctx); err != nil {
			internalError(w, "resetQueueJobs", err)
			return true
		}
		auditDataApi(req, d.apiKey, "queue.reset", nil, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	if d.sub == "printed" && d.method == http.MethodPost {
		if err := markQueueJobPrinted(ctx, d.id); err != nil {
			internalError(w, "markQueueJobPrinted", err)
			return true
		}
		auditDataApi(req, d.apiKey, "queue.printed", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	if d.method == http.MethodDelete {
		if err := deleteQueueJob(ctx, d.id); err != nil {
			internalError(w, "deleteQueueJob", err)
			return true
		}
		auditDataApi(req, d.apiKey, "queue.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── analytics ────────────────────────────────────────────────────────────────

func handleDataApiAnalytics(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		if d.method == http.MethodGet {
			days := 7
			if v, ok := jsParseInt(req.URL.Query().Get("days")); ok {
				days = v
			}
			data, err := listDailyAnalyticsJSON(ctx, days)
			return sendStoreJSON(w, data, err)
		}
		return dataApiMethodNotAllowed(w)
	}
	if d.id == "reset" && d.method == http.MethodPost {
		if err := resetDailyAnalytics(ctx); err != nil {
			internalError(w, "resetDailyAnalytics", err)
			return true
		}
		auditDataApi(req, d.apiKey, "analytics.reset", nil, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── maintenance ──────────────────────────────────────────────────────────────

func handleDataApiMaintenance(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		if d.method == http.MethodGet {
			q := req.URL.Query()
			events, err := listMaintenanceEvents(ctx, q.Get("printer"), q.Get("status"), q.Get("type"), 500)
			if err != nil {
				internalError(w, "listMaintenanceEvents", err)
				return true
			}
			sendJSON(w, http.StatusOK, events, "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}
	if d.id == "summary" && d.method == http.MethodGet {
		summary, err := getMaintenanceSummary(ctx)
		if err != nil {
			internalError(w, "getMaintenanceSummary", err)
			return true
		}
		sendJSON(w, http.StatusOK, summary, "")
		return true
	}
	if d.id == "printer" && d.sub != "" && d.method == http.MethodGet {
		summary, err := getPrinterMaintenance(ctx, d.sub)
		if err != nil {
			internalError(w, "getPrinterMaintenance", err)
			return true
		}
		if summary == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Printer not found"}, "")
			return true
		}
		sendJSON(w, http.StatusOK, summary, "")
		return true
	}
	if d.sub == "complete" && d.method == http.MethodPost {
		body := decodeBodyMap(req)
		var notes *string
		if n, ok := body["notes"].(string); ok {
			if t := strings.TrimSpace(n); t != "" {
				notes = &t
			}
		}
		event, err := completeMaintenanceEvent(ctx, d.id, notes)
		if err != nil {
			internalError(w, "completeMaintenanceEvent", err)
			return true
		}
		if event == nil {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "Pending maintenance task not found"}, "")
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"notes", notes}}))
		auditDataApi(req, d.apiKey, "maintenance.complete", &d.id, details)
		sendJSON(w, http.StatusOK, event, "")
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── notifications ────────────────────────────────────────────────────────────

func handleDataApiNotifications(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			data, err := listDiscordWebhooksJSON(ctx)
			return sendStoreJSON(w, data, err)
		case http.MethodPost:
			raw, _ := rawBody(req)
			id := stringField(raw, "id")
			if id == "" {
				id = uuid.NewString()
			}
			webhook := mergeID(raw, id)
			if err := createDiscordWebhook(ctx, webhook); err != nil {
				internalError(w, "createDiscordWebhook", err)
				return true
			}
			auditDataApi(req, d.apiKey, "notification.upsert", &id, nil)
			sendJSON(w, http.StatusCreated, ojson{{"id", id}}, "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}
	if d.method == http.MethodDelete {
		if err := deleteDiscordWebhook(ctx, d.id); err != nil {
			internalError(w, "deleteDiscordWebhook", err)
			return true
		}
		auditDataApi(req, d.apiKey, "notification.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── slicer-keys ──────────────────────────────────────────────────────────────

func handleDataApiSlicerKeys(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			data, err := listSlicerApiKeysJSON(ctx)
			return sendStoreJSON(w, data, err)
		case http.MethodPost:
			body := decodeBodyMap(req)
			name, _ := body["name"].(string)
			if strings.TrimSpace(name) == "" {
				badRequest(w, "name is required")
				return true
			}
			scopes := normalizeKeyPermissions(stringSlice(body["permissions"]))
			if len(scopes) == 0 {
				badRequest(w, "permissions must include at least one of: "+strings.Join(slicerKeyPermissions, ", "))
				return true
			}
			key, err := randomBase64URL(24)
			if err != nil {
				internalError(w, "randomBase64URL", err)
				return true
			}
			newID := uuid.NewString()
			trimmed := strings.TrimSpace(name)
			if err := createSlicerApiKey(ctx, newID, trimmed, pwcrypto.Hash(key), key[:8], scopes, nil); err != nil {
				internalError(w, "createSlicerApiKey", err)
				return true
			}
			details := json.RawMessage(marshalJSON(ojson{{"name", trimmed}, {"permissions", scopes}}))
			auditDataApi(req, d.apiKey, "slicer-key.create", &newID, details)
			sendJSON(w, http.StatusCreated, ojson{
				{"id", newID}, {"name", trimmed}, {"key", key}, {"permissions", scopes},
			}, "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}
	if d.method == http.MethodDelete {
		if err := deleteSlicerApiKey(ctx, d.id); err != nil {
			internalError(w, "deleteSlicerApiKey", err)
			return true
		}
		auditDataApi(req, d.apiKey, "slicer-key.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── audit-logs ───────────────────────────────────────────────────────────────

func handleDataApiAuditLogs(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.method == http.MethodGet {
		limit := atoiDefault(req.URL.Query().Get("limit"), 200)
		data, err := listAuditLogsJSON(ctx, limit)
		return sendStoreJSON(w, data, err)
	}
	if d.method == http.MethodPost {
		body := decodeBodyMap(req)
		action, _ := body["action"].(string)
		if strings.TrimSpace(action) == "" {
			badRequest(w, "action is required")
			return true
		}
		var target *string
		if t, ok := body["target"].(string); ok {
			target = &t
		}
		actorName := "api:" + d.apiKey.Name
		actorUser := d.apiKey.ID
		actorRole := "api"
		// Awaited (not detached) — Node `await recordAuditLog(...)` before 201.
		if err := recordAuditLog(ctx, auditEntry{
			ActorName: &actorName, ActorUsername: &actorUser, ActorRole: &actorRole,
			Action: action, Target: target, Details: body["details"], Source: "api", IP: getClientIP(req),
		}); err != nil {
			internalError(w, "recordAuditLog", err)
			return true
		}
		sendEmpty(w, http.StatusCreated)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── settings ─────────────────────────────────────────────────────────────────

func handleDataApiSettings(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		badRequest(w, "a settings key is required: /api/v1/settings/<key>")
		return true
	}
	if d.method == http.MethodGet {
		stored, err := getAppSetting(ctx, d.id)
		if err != nil {
			internalError(w, "getAppSetting", err)
			return true
		}
		sendRawJSON(w, http.StatusOK,
			[]byte(`{"key":`+string(marshalJSON(d.id))+`,"value":`+string(jsCompactOrNull(stored))+`}`), "no-store")
		return true
	}
	if d.method == http.MethodPut || d.method == http.MethodPost {
		raw, _ := rawBody(req)
		if len(strings.TrimSpace(string(raw))) == 0 {
			raw = json.RawMessage("{}")
		}
		// Node parses the whole body (JSON.parse) before storing, so numbers are
		// JS-normalized (1.50 → 1.5) at rest. jsCompact reproduces that before the
		// jsonb write so stored state matches byte-for-byte.
		value := jsCompactOrNull(settingsValue(raw))
		if err := setAppSetting(ctx, d.id, value); err != nil {
			internalError(w, "setAppSetting", err)
			return true
		}
		auditDataApi(req, d.apiKey, "setting.update", &d.id, nil)
		sendRawJSON(w, http.StatusOK,
			[]byte(`{"key":`+string(marshalJSON(d.id))+`,"value":`+string(value)+`}`), "no-store")
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// settingsValue mirrors `body && typeof body === 'object' && 'value' in body ?
// body.value : body`: an object carrying a "value" key unwraps to that value,
// otherwise the whole body is the value.
func settingsValue(raw json.RawMessage) json.RawMessage {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		if v, ok := obj["value"]; ok {
			return v
		}
	}
	return raw
}

// ── users ────────────────────────────────────────────────────────────────────

// staffUserHash mirrors staffUserWithHash: the sanitized user plus the stored
// passwordHash (or null). Only for the key-gated surface.
type staffUserHash struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Username     string  `json:"username"`
	Role         string  `json:"role"`
	PasswordHash *string `json:"passwordHash"`
}

func staffUserWithHash(u staffUser) staffUserHash {
	out := staffUserHash{ID: u.ID, Name: u.Name, Username: u.Username, Role: u.Role}
	if u.PasswordHash != "" {
		out.PasswordHash = &u.PasswordHash
	}
	return out
}

func isStorablePasswordHash(v string) bool {
	return pwcrypto.IsSha256Hex(v) || pwcrypto.IsScryptHash(v)
}

func handleDataApiUsers(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			users, err := readStaffUsers(ctx)
			if err != nil {
				internalError(w, "readStaffUsers", err)
				return true
			}
			out := make([]staffUserHash, 0, len(users))
			for _, u := range users {
				out = append(out, staffUserWithHash(u))
			}
			sendJSON(w, http.StatusOK, out, "")
			return true
		case http.MethodPost:
			body := decodeBodyMap(req)
			name := strings.TrimSpace(stringFromAny(body["name"]))
			username := strings.ToLower(strings.TrimSpace(stringFromAny(body["username"])))
			role, _ := body["role"].(string)
			passwordHash, _ := body["passwordHash"].(string)
			if name == "" || username == "" {
				badRequest(w, "Name and username are required.")
				return true
			}
			if !userRoles[role] {
				badRequest(w, "role must be admin, operator, or viewer")
				return true
			}
			if !isStorablePasswordHash(passwordHash) {
				badRequest(w, "passwordHash must be a sha256 hex string")
				return true
			}
			if username == reservedUsername {
				sendJSON(w, http.StatusConflict, map[string]any{"error": "That username is reserved."}, "")
				return true
			}
			users, err := readStaffUsers(ctx)
			if err != nil {
				internalError(w, "readStaffUsers", err)
				return true
			}
			for _, u := range users {
				if u.Username == username {
					sendJSON(w, http.StatusConflict, map[string]any{"error": "That username is already in use."}, "")
					return true
				}
			}
			stored, ok, err := pwcrypto.ToStored(passwordHash)
			if err != nil || !ok {
				internalError(w, "toStoredPasswordHash", err)
				return true
			}
			newUser := staffUser{ID: uuid.NewString(), Name: name, Username: username, Role: role, PasswordHash: stored}
			if err := writeStaffUsers(ctx, append(users, newUser)); err != nil {
				internalError(w, "writeStaffUsers", err)
				return true
			}
			details := json.RawMessage(marshalJSON(ojson{{"username", username}, {"role", role}}))
			auditDataApi(req, d.apiKey, "user.create", &newUser.ID, details)
			sendJSON(w, http.StatusCreated, staffUserWithHash(newUser), "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}

	if d.id == "verify" && d.method == http.MethodPost {
		body := decodeBodyMap(req)
		username := strings.ToLower(strings.TrimSpace(stringFromAny(body["username"])))
		passwordHash, _ := body["passwordHash"].(string)
		users, err := readStaffUsers(ctx)
		if err != nil {
			internalError(w, "readStaffUsers", err)
			return true
		}
		var found *staffUser
		if pwcrypto.IsSha256Hex(passwordHash) {
			found = findUserByCredential(users, username, passwordHash)
		}
		if found == nil {
			sendJSON(w, http.StatusUnauthorized, ojson{{"valid", false}}, "")
			return true
		}
		sendJSON(w, http.StatusOK, ojson{{"valid", true}, {"user", sanitizeStaffUser(*found)}}, "")
		return true
	}

	if d.sub == "password" && d.method == http.MethodPut {
		body := decodeBodyMap(req)
		passwordHash, _ := body["passwordHash"].(string)
		if !isStorablePasswordHash(passwordHash) {
			badRequest(w, "passwordHash must be a sha256 hex string")
			return true
		}
		users, err := readStaffUsers(ctx)
		if err != nil {
			internalError(w, "readStaffUsers", err)
			return true
		}
		idx := indexOfUser(users, d.id)
		if idx == -1 {
			notFound(w, "user not found")
			return true
		}
		stored, ok, err := pwcrypto.ToStored(passwordHash)
		if err != nil || !ok {
			internalError(w, "toStoredPasswordHash", err)
			return true
		}
		users[idx].PasswordHash = stored
		if err := writeStaffUsers(ctx, users); err != nil {
			internalError(w, "writeStaffUsers", err)
			return true
		}
		auditDataApi(req, d.apiKey, "user.password", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}

	if d.sub == "role" && d.method == http.MethodPut {
		body := decodeBodyMap(req)
		role, _ := body["role"].(string)
		if !userRoles[role] {
			badRequest(w, "role must be admin, operator, or viewer")
			return true
		}
		users, err := readStaffUsers(ctx)
		if err != nil {
			internalError(w, "readStaffUsers", err)
			return true
		}
		idx := indexOfUser(users, d.id)
		if idx == -1 {
			notFound(w, "user not found")
			return true
		}
		users[idx].Role = role
		if err := writeStaffUsers(ctx, users); err != nil {
			internalError(w, "writeStaffUsers", err)
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"role", role}}))
		auditDataApi(req, d.apiKey, "user.role", &d.id, details)
		sendJSON(w, http.StatusOK, staffUserWithHash(users[idx]), "")
		return true
	}

	if d.sub == "" && d.method == http.MethodDelete {
		users, err := readStaffUsers(ctx)
		if err != nil {
			internalError(w, "readStaffUsers", err)
			return true
		}
		if indexOfUser(users, d.id) == -1 {
			notFound(w, "user not found")
			return true
		}
		next := make([]staffUser, 0, len(users))
		for _, u := range users {
			if u.ID != d.id {
				next = append(next, u)
			}
		}
		if err := writeStaffUsers(ctx, next); err != nil {
			internalError(w, "writeStaffUsers", err)
			return true
		}
		auditDataApi(req, d.apiKey, "user.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}

	return dataApiMethodNotAllowed(w)
}

// ── admin-credential ─────────────────────────────────────────────────────────

func handleDataApiAdminCredential(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	storedHash := adminStoredHash(ctx)

	if d.id == "verify" && d.method == http.MethodPost {
		body := decodeBodyMap(req)
		passwordHash, _ := body["passwordHash"].(string)
		valid := storedHash != "" && pwcrypto.Verify(storedHash, passwordHash)
		status := http.StatusUnauthorized
		if valid {
			status = http.StatusOK
		}
		sendJSON(w, status, ojson{{"valid", valid}}, "")
		return true
	}
	if d.id != "" {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "Use /admin-credential or /admin-credential/verify."}, "")
		return true
	}

	if d.method == http.MethodGet {
		sendJSON(w, http.StatusOK, ojson{{"configured", storedHash != ""}}, "")
		return true
	}
	if d.method == http.MethodPut {
		body := decodeBodyMap(req)
		passwordHash, _ := body["passwordHash"].(string)
		if !isStorablePasswordHash(passwordHash) {
			badRequest(w, "passwordHash must be a sha256 hex string")
			return true
		}
		stored, ok, err := pwcrypto.ToStored(passwordHash)
		if err != nil || !ok {
			internalError(w, "toStoredPasswordHash", err)
			return true
		}
		if err := setAppSetting(ctx, adminCredentialKey, map[string]any{"passwordHash": stored}); err != nil {
			internalError(w, "setAppSetting admin_credential", err)
			return true
		}
		auditDataApi(req, d.apiKey, "admin-credential.set", nil, nil)
		status := http.StatusCreated
		if storedHash != "" {
			status = http.StatusOK
		}
		sendEmpty(w, status)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── manager-requests ─────────────────────────────────────────────────────────

func handleDataApiManagerRequests(w http.ResponseWriter, req *http.Request, d dataAPICtx) bool {
	ctx := d.ctx
	if d.id == "" {
		switch d.method {
		case http.MethodGet:
			data, err := listManagerRequestsJSON(ctx)
			return sendStoreJSON(w, data, err)
		case http.MethodPost:
			body := decodeBodyMap(req)
			name, _ := body["name"].(string)
			if strings.TrimSpace(name) == "" {
				badRequest(w, "name is required")
				return true
			}
			newID := uuid.NewString()
			trimmed := strings.TrimSpace(name)
			var desc *string
			if ds, ok := body["description"].(string); ok {
				if t := strings.TrimSpace(ds); t != "" {
					desc = &t
				}
			}
			if err := createManagerRequest(ctx, newID, trimmed, desc); err != nil {
				internalError(w, "createManagerRequest", err)
				return true
			}
			details := json.RawMessage(marshalJSON(ojson{{"name", trimmed}}))
			auditDataApi(req, d.apiKey, "manager-request.create", &newID, details)
			sendJSON(w, http.StatusCreated, ojson{{"id", newID}}, "")
			return true
		}
		return dataApiMethodNotAllowed(w)
	}

	mgr, err := getManagerRequest(ctx, d.id)
	if err != nil {
		internalError(w, "getManagerRequest", err)
		return true
	}
	if mgr == nil {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "Request not found"}, "")
		return true
	}

	if d.sub == "approve" && d.method == http.MethodPost {
		if mgr.Status != "pending" {
			badRequest(w, "Request is not pending")
			return true
		}
		key, err := randomBase64URL(24)
		if err != nil {
			internalError(w, "randomBase64URL", err)
			return true
		}
		keyID := uuid.NewString()
		if err := createSlicerApiKey(ctx, keyID, "Manager: "+mgr.Name, pwcrypto.Hash(key), key[:8],
			[]string{"printfarm_manage"}, nil); err != nil {
			internalError(w, "createSlicerApiKey", err)
			return true
		}
		if err := approveManagerRequest(ctx, d.id, keyID, key); err != nil {
			internalError(w, "approveManagerRequest", err)
			return true
		}
		details := json.RawMessage(marshalJSON(ojson{{"apiKeyId", keyID}}))
		auditDataApi(req, d.apiKey, "manager-request.approve", &d.id, details)
		sendJSON(w, http.StatusOK, ojson{{"ok", true}, {"apiKeyId", keyID}, {"key", key}}, "")
		return true
	}

	if d.sub == "deny" && d.method == http.MethodPost {
		if mgr.Status != "pending" {
			badRequest(w, "Request is not pending")
			return true
		}
		if err := denyManagerRequest(ctx, d.id); err != nil {
			internalError(w, "denyManagerRequest", err)
			return true
		}
		auditDataApi(req, d.apiKey, "manager-request.deny", &d.id, nil)
		sendJSON(w, http.StatusOK, ojson{{"ok", true}}, "")
		return true
	}

	if d.sub != "" {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "Use /manager-requests/:id, /:id/approve, or /:id/deny."}, "")
		return true
	}

	if d.method == http.MethodGet {
		sendJSON(w, http.StatusOK, mgr.asOrderedJSON(), "")
		return true
	}
	if d.method == http.MethodDelete {
		if mgr.APIKeyID != nil {
			if err := deleteSlicerApiKey(ctx, *mgr.APIKeyID); err != nil {
				internalError(w, "deleteSlicerApiKey", err)
				return true
			}
		}
		if err := deleteManagerRequest(ctx, d.id); err != nil {
			internalError(w, "deleteManagerRequest", err)
			return true
		}
		auditDataApi(req, d.apiKey, "manager-request.delete", &d.id, nil)
		sendEmpty(w, http.StatusNoContent)
		return true
	}
	return dataApiMethodNotAllowed(w)
}

// ── body / value helpers ─────────────────────────────────────────────────────

// parseIdList mirrors the Node helper: flatten array/single input, keep strings,
// split each on commas, trim, de-dup, preserve order; nil when empty.
func parseIdList(input any) []string {
	if input == nil {
		return nil
	}
	var raw []any
	switch v := input.(type) {
	case []any:
		raw = v
	case []string:
		for _, s := range v {
			raw = append(raw, s)
		}
	default:
		raw = []any{input}
	}
	seen := map[string]bool{}
	var ids []string
	for _, entry := range raw {
		s, ok := entry.(string)
		if !ok {
			continue
		}
		for _, part := range strings.Split(s, ",") {
			t := strings.TrimSpace(part)
			if t != "" && !seen[t] {
				seen[t] = true
				ids = append(ids, t)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return ids
}

// jobsFromBody mirrors `Array.isArray(body) ? body : Array.isArray(body?.jobs) ?
// body.jobs : null`: returns the jobs array (verbatim bytes) and ok=false when
// neither form is present.
func jobsFromBody(raw json.RawMessage) (json.RawMessage, bool) {
	if isJSONArray(raw) {
		return raw, true
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		if jobs, ok := obj["jobs"]; ok && isJSONArray(jobs) {
			return jobs, true
		}
	}
	return nil, false
}

// idsFromBody mirrors `Array.isArray(body) ? body : body?.ids` for the bulk-delete
// route, returning the raw value parseIdList should flatten.
func idsFromBody(raw json.RawMessage) any {
	var arr []any
	if json.Unmarshal(raw, &arr) == nil {
		return arr
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		return obj["ids"]
	}
	return nil
}

func isJSONArray(raw json.RawMessage) bool {
	t := strings.TrimSpace(string(raw))
	return len(t) > 0 && t[0] == '['
}

func jsonArrayLen(raw json.RawMessage) int {
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) != nil {
		return 0
	}
	return len(arr)
}

// stringField returns body[key] when it is a JSON string, else "".
func stringField(raw json.RawMessage, key string) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	v, ok := obj[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return ""
	}
	return s
}

// mergeID sets/overrides the "id" field of a JSON object body, returning the
// re-encoded object (mirrors `{ id, ...body }` where body.id wins when present —
// here id is already resolved to that precedence by the caller).
func mergeID(raw json.RawMessage, id string) json.RawMessage {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		obj = map[string]json.RawMessage{}
	}
	obj["id"] = json.RawMessage(marshalJSON(id))
	return json.RawMessage(marshalJSON(obj))
}

func stringFromAny(v any) string {
	s, _ := v.(string)
	return s
}

// stringSlice coerces a decoded JSON array of strings (any other shape → empty).
func stringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// jsCompactOrNull compacts a value like JSON.parse→JSON.stringify, emitting
// "null" for an absent/empty value (matching JSON.stringify(undefined→null)).
func jsCompactOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return jsCompact(raw)
}
