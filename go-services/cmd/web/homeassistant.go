package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// homeassistant.go ports the Home-Assistant integration from server/app.js: the
// config GET/PUT, connection test, device (entity) list, the print-farm ⇄ HA
// automation-rule CRUD, and the background rule engine (evaluateHaRules). Rules
// are stored in app_settings and evaluated here — they are NOT native HA
// automations (those can't see our printers).

const (
	homeAssistantKey = "home_assistant"
	haRulesKey       = "ha_automation_rules"
)

var (
	haRuleDirections   = map[string]bool{"ha_to_printer": true, "printer_to_ha": true}
	haPrinterCommands  = map[string]bool{"pause": true, "resume": true, "cancel": true}
	haPrinterStatuses  = map[string]bool{"printing": true, "idle": true, "paused": true, "error": true, "offline": true}
	reHaScheme         = regexp.MustCompile(`(?i)^https?://`)
	reHaTrailingSlash  = regexp.MustCompile(`/+$`)
	reHaTrailingApi    = regexp.MustCompile(`/api$`)
	reHaActionService  = regexp.MustCompile(`(?i)^[a-z_]+\.[a-z0-9_]+$`)
	haEngineIntervalMs = haEngineInterval()
)

func haEngineInterval() int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("HA_AUTOMATION_INTERVAL_MS")))
	if err != nil || v == 0 {
		v = 15000
	}
	if v < 5000 {
		v = 5000
	}
	return v
}

// ── config ───────────────────────────────────────────────────────────────────

type haConfig struct {
	baseURL string
	token   string
	enabled bool
}

func normalizeHaBaseUrl(raw string) string {
	base := strings.TrimSpace(raw)
	if base == "" {
		return ""
	}
	base = reHaTrailingSlash.ReplaceAllString(base, "")
	base = reHaTrailingApi.ReplaceAllString(base, "")
	return base
}

func getHomeAssistantConfig(ctx context.Context) (haConfig, error) {
	raw, err := getAppSetting(ctx, homeAssistantKey)
	if err != nil {
		return haConfig{}, err
	}
	m := decodeStored(raw)
	enabled, _ := m["enabled"].(bool)
	return haConfig{
		baseURL: normalizeHaBaseUrl(storedString(m, "baseUrl")),
		token:   secretCipher.Decrypt(storedString(m, "token")),
		enabled: enabled,
	}, nil
}

// haResult is the { ok, status, data, error } envelope haFetch returns.
type haResult struct {
	ok     bool
	status int
	data   json.RawMessage
	errMsg string
}

func haFetch(ctx context.Context, config haConfig, apiPath, method string, body []byte) haResult {
	if config.baseURL == "" || config.token == "" {
		return haResult{ok: false, status: 0, errMsg: "Home Assistant is not configured."}
	}
	url := config.baseURL + "/api/" + strings.TrimLeft(apiPath, "/")
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, url, bodyReader)
	if err != nil {
		return haResult{ok: false, status: 0, errMsg: "Could not reach Home Assistant: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+config.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || reqCtx.Err() == context.DeadlineExceeded {
			return haResult{ok: false, status: 0, errMsg: "Home Assistant did not respond in time."}
		}
		return haResult{ok: false, status: 0, errMsg: "Could not reach Home Assistant: " + err.Error()}
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	var data json.RawMessage
	if len(text) > 0 {
		if json.Valid(text) {
			data = json.RawMessage(text)
		} else {
			// Non-JSON body → store the text as a JSON string (Node keeps it as the
			// raw string; only data.message is consulted, which won't exist).
			data, _ = json.Marshal(string(text))
		}
	} else {
		data = json.RawMessage("null")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return haResult{ok: false, status: resp.StatusCode, data: data, errMsg: haErrorDetail(data, resp.StatusCode)}
	}
	return haResult{ok: true, status: resp.StatusCode, data: data}
}

// haErrorDetail mirrors `data && typeof data==='object' && data.message ? ... : 'HTTP N'`.
func haErrorDetail(data json.RawMessage, status int) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(data, &obj) == nil {
		if msg, ok := obj["message"]; ok {
			var s string
			if json.Unmarshal(msg, &s) == nil && s != "" {
				return s
			}
		}
	}
	return "HTTP " + strconv.Itoa(status)
}

// ── routes ───────────────────────────────────────────────────────────────────

func handleHomeAssistantRoutes(ctx context.Context, w http.ResponseWriter, req *http.Request) bool {
	p := req.URL.Path
	m := req.Method

	switch {
	case p == "/api/settings/home-assistant" && (m == http.MethodGet || m == http.MethodPut):
		if m == http.MethodGet {
			handleHaConfigGet(ctx, w, req)
		} else {
			handleHaConfigPut(ctx, w, req)
		}
		return true
	case p == "/api/settings/home-assistant/test" && m == http.MethodPost:
		handleHaTest(ctx, w, req)
		return true
	case p == "/api/settings/home-assistant/devices" && m == http.MethodGet:
		handleHaDevices(ctx, w, req)
		return true
	case p == "/api/settings/home-assistant/rules" && (m == http.MethodGet || m == http.MethodPost):
		handleHaRules(ctx, w, req)
		return true
	case strings.HasPrefix(p, "/api/settings/home-assistant/rules/"):
		handleHaRuleByID(ctx, w, req)
		return true
	}
	return false
}

func haConfigPayload(c haConfig) ojson {
	return ojson{{"baseUrl", c.baseURL}, {"enabled", c.enabled}, {"hasToken", len(c.token) > 0}}
}

func handleHaConfigGet(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	config, err := getHomeAssistantConfig(ctx)
	if err != nil {
		internalError(w, "getHomeAssistantConfig", err)
		return
	}
	sendJSON(w, http.StatusOK, haConfigPayload(config), "")
}

func handleHaConfigPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	bm := decodeBodyRawMap(req)
	baseURL := normalizeHaBaseUrl(rawAsString(bm["baseUrl"]))
	enabled := string(bm["enabled"]) == "true"
	if _, isStr := rawAsStringOK(bm["baseUrl"]); !isStr {
		badRequest(w, "baseUrl must be a string")
		return
	}
	if baseURL != "" && !reHaScheme.MatchString(baseURL) {
		badRequest(w, "baseUrl must start with http:// or https://")
		return
	}
	existing, err := getHomeAssistantConfig(ctx)
	if err != nil {
		internalError(w, "getHomeAssistantConfig", err)
		return
	}
	token := existing.token
	if t, ok := rawAsStringOK(bm["token"]); ok && strings.TrimSpace(t) != "" {
		token = strings.TrimSpace(t)
	}
	storedToken := ""
	if token != "" {
		storedToken = secretCipher.Encrypt(token)
	}
	if err := setAppSetting(ctx, homeAssistantKey, ojson{
		{"baseUrl", baseURL}, {"token", storedToken}, {"enabled", enabled},
	}); err != nil {
		internalError(w, "setAppSetting home_assistant", err)
		return
	}
	saved, err := getHomeAssistantConfig(ctx)
	if err != nil {
		internalError(w, "getHomeAssistantConfig", err)
		return
	}
	sendJSON(w, http.StatusOK, haConfigPayload(saved), "")
}

func handleHaTest(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	config, err := getHomeAssistantConfig(ctx)
	if err != nil {
		internalError(w, "getHomeAssistantConfig", err)
		return
	}
	if config.baseURL == "" || config.token == "" {
		sendJSON(w, http.StatusBadRequest, ojson{{"ok", false}, {"error", "Set the Home Assistant URL and token first."}}, "")
		return
	}
	result := haFetch(ctx, config, "/", http.MethodGet, nil)
	if result.ok {
		sendJSON(w, http.StatusOK, ojson{{"ok", true}, {"message", "Connected to Home Assistant."}}, "")
	} else {
		sendJSON(w, http.StatusOK, ojson{{"ok", false}, {"error", result.errMsg}}, "")
	}
}

type haEntity struct {
	EntityID     string `json:"entityId"`
	Domain       string `json:"domain"`
	FriendlyName string `json:"friendlyName"`
	State        string `json:"state"`
}

func handleHaDevices(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	config, err := getHomeAssistantConfig(ctx)
	if err != nil {
		internalError(w, "getHomeAssistantConfig", err)
		return
	}
	result := haFetch(ctx, config, "/states", http.MethodGet, nil)
	if !result.ok {
		sendJSON(w, http.StatusBadGateway, map[string]any{"error": result.errMsg}, "")
		return
	}
	var states []map[string]json.RawMessage
	_ = json.Unmarshal(result.data, &states)
	entities := make([]haEntity, 0, len(states))
	for _, st := range states {
		entityID := jsonStr(st["entity_id"])
		if entityID == "" {
			continue
		}
		domain := ""
		if i := strings.IndexByte(entityID, '.'); i >= 0 {
			domain = entityID[:i]
		}
		friendly := entityID
		if attrs := st["attributes"]; len(attrs) > 0 {
			var am map[string]json.RawMessage
			if json.Unmarshal(attrs, &am) == nil {
				if fn := jsonStr(am["friendly_name"]); fn != "" {
					friendly = fn
				}
			}
		}
		entities = append(entities, haEntity{EntityID: entityID, Domain: domain, FriendlyName: friendly, State: jsonStr(st["state"])})
	}
	sort.SliceStable(entities, func(i, j int) bool { return entities[i].EntityID < entities[j].EntityID })

	// groups: domain → entities. Node builds the object by iterating the sorted
	// entities and grouping under domain||'other', so the group keys land in
	// first-appearance order (NOT alphabetical — a no-dot entity's 'other' key sits
	// where that entity sorts). Preserve that order with an ordered object.
	groupKeys := make([]string, 0)
	groupSeen := map[string]bool{}
	groupOf := map[string][]haEntity{}
	for _, e := range entities {
		key := e.Domain
		if key == "" {
			key = "other"
		}
		if !groupSeen[key] {
			groupSeen[key] = true
			groupKeys = append(groupKeys, key)
		}
		groupOf[key] = append(groupOf[key], e)
	}
	groups := make(ojson, 0, len(groupKeys))
	for _, k := range groupKeys {
		groups = append(groups, ojField{k, groupOf[k]})
	}
	sendJSON(w, http.StatusOK, ojson{{"entities", entities}, {"groups", groups}}, "")
}

// ── rules CRUD ────────────────────────────────────────────────────────────────

func loadHaRules(ctx context.Context) (json.RawMessage, []json.RawMessage, error) {
	raw, err := getAppSetting(ctx, haRulesKey)
	if err != nil {
		return nil, nil, err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return json.RawMessage("[]"), nil, nil
	}
	var elems []json.RawMessage
	if json.Unmarshal(trimmed, &elems) != nil {
		return json.RawMessage("[]"), nil, nil
	}
	return json.RawMessage(trimmed), elems, nil
}

func handleHaRules(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	arr, elems, err := loadHaRules(ctx)
	if err != nil {
		internalError(w, "loadHaRules", err)
		return
	}

	if req.Method == http.MethodGet {
		out := marshalJSON(ojson{{"rules", arr}})
		sendRawJSON(w, http.StatusOK, jsCompact(out), "")
		return
	}

	// POST — create.
	rule, verr := normalizeHaRuleInput(rawBodyBytes(req))
	if verr != nil {
		badRequest(w, verr.Error())
		return
	}
	created := append(ojson{{"id", uuid.NewString()}, {"createdAt", *jsISO(nowPtr())}}, rule...)
	createdRaw := json.RawMessage(marshalJSON(created))
	next := append(elems, createdRaw)
	if err := setAppSetting(ctx, haRulesKey, next); err != nil {
		internalError(w, "setAppSetting ha_rules", err)
		return
	}
	sendRawJSON(w, http.StatusCreated, jsCompact(marshalJSON(created)), "")
}

func handleHaRuleByID(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	ruleID := decodePathSegment(req.URL.Path, "/api/settings/home-assistant/rules/", "")
	_, elems, err := loadHaRules(ctx)
	if err != nil {
		internalError(w, "loadHaRules", err)
		return
	}
	index := -1
	for i, e := range elems {
		if ruleFieldString(e, "id") == ruleID {
			index = i
			break
		}
	}
	if index == -1 {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "rule not found"}, "")
		return
	}

	switch req.Method {
	case http.MethodDelete:
		next := make([]json.RawMessage, 0, len(elems)-1)
		for i, e := range elems {
			if i != index {
				next = append(next, e)
			}
		}
		if err := setAppSetting(ctx, haRulesKey, next); err != nil {
			internalError(w, "setAppSetting ha_rules", err)
			return
		}
		sendEmpty(w, http.StatusNoContent)
	case http.MethodPut:
		existing, perr := parseOrderedObject(elems[index])
		if perr != nil {
			internalError(w, "parse rule", perr)
			return
		}
		body := rawBodyBytes(req)
		var override ojson
		if isBareEnabledToggle(body) {
			var bm map[string]json.RawMessage
			_ = json.Unmarshal(body, &bm)
			override = ojson{{"enabled", string(bm["enabled"]) == "true"}}
		} else {
			rule, verr := normalizeHaRuleInput(body)
			if verr != nil {
				badRequest(w, verr.Error())
				return
			}
			override = rule
		}
		merged := mergeOrdered(existing, override)
		mergedRaw := json.RawMessage(marshalJSON(merged))
		updated := make([]json.RawMessage, len(elems))
		copy(updated, elems)
		updated[index] = mergedRaw
		if err := setAppSetting(ctx, haRulesKey, updated); err != nil {
			internalError(w, "setAppSetting ha_rules", err)
			return
		}
		sendRawJSON(w, http.StatusOK, jsCompact(marshalJSON(merged)), "")
	default:
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."}, "")
	}
}

// isBareEnabledToggle mirrors `Object.keys(body).length === 1 && 'enabled' in body`.
func isBareEnabledToggle(body []byte) bool {
	var bm map[string]json.RawMessage
	if json.Unmarshal(body, &bm) != nil {
		return false
	}
	_, hasEnabled := bm["enabled"]
	return len(bm) == 1 && hasEnabled
}

// normalizeHaRuleInput validates a rule body and returns the ordered rule fields
// (without id/createdAt). Returns an error (message → 400) on invalid input.
func normalizeHaRuleInput(body []byte) (ojson, error) {
	// readJsonBody defaults an empty body to {}, so an empty POST falls through to
	// the direction check (not "a rule body is required"). A JSON object or array
	// is `typeof === 'object'` in JS and passes the guard; a null/number/string/
	// bool body is rejected here.
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	bm := map[string]json.RawMessage{}
	switch trimmed[0] {
	case '{':
		if json.Unmarshal(trimmed, &bm) != nil {
			return nil, errors.New("a rule body is required")
		}
	case '[':
		// array body: proceed with no fields (direction missing → direction error)
	default:
		return nil, errors.New("a rule body is required")
	}
	direction := rawAsString(bm["direction"]) // not trimmed, like String(body.direction||'')
	if !haRuleDirections[direction] {
		return nil, errors.New("direction must be ha_to_printer or printer_to_ha")
	}
	name := ruleTrimString(bm, "name")
	if name == "" {
		return nil, errors.New("name is required")
	}
	enabled := string(bm["enabled"]) != "false" // default on
	printerID := ruleTrimString(bm, "printerId")
	if printerID == "" {
		return nil, errors.New("printerId is required")
	}

	if direction == "ha_to_printer" {
		triggerEntity := ruleTrimString(bm, "triggerEntity")
		triggerState := ruleTrimString(bm, "triggerState")
		printerCommand := ruleTrimString(bm, "printerCommand")
		if triggerEntity == "" || triggerState == "" {
			return nil, errors.New("triggerEntity and triggerState are required")
		}
		if !haPrinterCommands[printerCommand] {
			return nil, errors.New("printerCommand must be pause, resume, or cancel")
		}
		return ojson{
			{"direction", direction}, {"name", name}, {"enabled", enabled},
			{"printerId", printerID}, {"triggerEntity", triggerEntity},
			{"triggerState", triggerState}, {"printerCommand", printerCommand},
		}, nil
	}

	// printer_to_ha
	printerStatus := ruleTrimString(bm, "printerStatus")
	actionService := ruleTrimString(bm, "actionService")
	actionEntity := ruleTrimString(bm, "actionEntity")
	if !haPrinterStatuses[printerStatus] {
		return nil, errors.New("printerStatus must be printing, idle, paused, error, or offline")
	}
	if !reHaActionService.MatchString(actionService) {
		return nil, errors.New("actionService must look like domain.service, e.g. switch.turn_off")
	}
	actionData := json.RawMessage("{}")
	if v, ok := bm["actionData"]; ok {
		s := string(v)
		if s != "null" && s != `""` {
			var asStr string
			if json.Unmarshal(v, &asStr) == nil {
				parsed := bytes.TrimSpace([]byte(asStr))
				if len(parsed) == 0 || !json.Valid(parsed) {
					return nil, errors.New("actionData must be valid JSON")
				}
				actionData = json.RawMessage(parsed)
			} else {
				actionData = v
			}
			if !isJSONObject(actionData) {
				return nil, errors.New("actionData must be a JSON object")
			}
		}
	}
	return ojson{
		{"direction", direction}, {"name", name}, {"enabled", enabled},
		{"printerId", printerID}, {"printerStatus", printerStatus},
		{"actionService", actionService}, {"actionEntity", actionEntity},
		{"actionData", actionData},
	}, nil
}

func isJSONObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

// ── ordered-object helpers ────────────────────────────────────────────────────

// parseOrderedObject decodes a JSON object preserving key order, each value as a
// raw message (so re-emit keeps the stored bytes/order).
func parseOrderedObject(raw []byte) (ojson, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("not an object")
	}
	var out ojson
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := kt.(string)
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, err
		}
		out = append(out, ojField{key, val})
	}
	return out, nil
}

// mergeOrdered mirrors `{...base, ...override}`: override values replace in place;
// override-only keys append in override order.
func mergeOrdered(base, override ojson) ojson {
	out := make(ojson, len(base))
	copy(out, base)
	idx := map[string]int{}
	for i, f := range out {
		idx[f.k] = i
	}
	for _, f := range override {
		if i, ok := idx[f.k]; ok {
			out[i].v = f.v
		} else {
			idx[f.k] = len(out)
			out = append(out, f)
		}
	}
	return out
}

// ── small raw-value helpers ───────────────────────────────────────────────────

func decodeBodyRawMap(req *http.Request) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	_ = readJSONBody(req, &m)
	if m == nil {
		return map[string]json.RawMessage{}
	}
	return m
}

func rawBodyBytes(req *http.Request) []byte {
	body, _ := io.ReadAll(io.LimitReader(req.Body, maxBodyBytes))
	return body
}

func rawAsString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func rawAsStringOK(raw json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, true
	}
	return "", false
}

// ruleTrimString mirrors `typeof x === 'string' ? x.trim() : ”`.
func ruleTrimString(bm map[string]json.RawMessage, key string) string {
	if s, ok := rawAsStringOK(bm[key]); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func ruleFieldString(raw json.RawMessage, key string) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	return jsonStr(m[key])
}

func jsonStr(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func nowPtr() *time.Time { t := time.Now(); return &t }

// ── background rule engine (evaluateHaRules) ──────────────────────────────────

var (
	haEngineMu                sync.Mutex
	haEngineRunning           bool
	haEngineLastPrinterStatus = map[string]string{}
	haEngineLastEntityState   = map[string]string{}
)

func startHaAutomationEngine(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(haEngineIntervalMs) * time.Millisecond)
	go func() {
		for {
			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				evaluateHaRules(ctx)
			}
		}
	}()
	logInfo("home assistant automation engine started", map[string]any{"intervalMs": haEngineIntervalMs})
}

func evaluateHaRules(ctx context.Context) {
	haEngineMu.Lock()
	if haEngineRunning {
		haEngineMu.Unlock()
		return
	}
	haEngineRunning = true
	haEngineMu.Unlock()
	defer func() {
		haEngineMu.Lock()
		haEngineRunning = false
		haEngineMu.Unlock()
	}()

	config, err := getHomeAssistantConfig(ctx)
	if err != nil || !config.enabled || config.baseURL == "" || config.token == "" {
		return
	}
	_, elems, err := loadHaRules(ctx)
	if err != nil {
		return
	}
	var printerToHa, haToPrinter []map[string]json.RawMessage
	for _, e := range elems {
		var rm map[string]json.RawMessage
		if json.Unmarshal(e, &rm) != nil {
			continue
		}
		// Node filters on `rule.enabled` (truthy) — keep only enabled === true.
		if string(rm["enabled"]) != "true" {
			continue
		}
		switch jsonStr(rm["direction"]) {
		case "printer_to_ha":
			printerToHa = append(printerToHa, rm)
		case "ha_to_printer":
			haToPrinter = append(haToPrinter, rm)
		}
	}

	if len(printerToHa) > 0 {
		statusByID := map[string]string{}
		for _, r := range printerToHa {
			pid := jsonStr(r["printerId"])
			if _, done := statusByID[pid]; done {
				continue
			}
			if st, ok := getPrinterStatusByID(ctx, pid); ok {
				if st == "" {
					st = "offline"
				}
				statusByID[pid] = st
			}
		}
		for _, r := range printerToHa {
			pid := jsonStr(r["printerId"])
			current, present := statusByID[pid]
			if !present {
				continue
			}
			key := "p:" + pid
			prev, hadPrev := haEngineLastPrinterStatus[key]
			haEngineLastPrinterStatus[key] = current
			if !hadPrev || prev == current || current != jsonStr(r["printerStatus"]) {
				continue
			}
			data := json.RawMessage("{}")
			if d, ok := r["actionData"]; ok {
				data = d
			}
			_ = callHaService(ctx, config, jsonStr(r["actionService"]), jsonStr(r["actionEntity"]), data)
		}
	}

	if len(haToPrinter) > 0 {
		result := haFetch(ctx, config, "/states", http.MethodGet, nil)
		if !result.ok {
			return
		}
		var states []map[string]json.RawMessage
		_ = json.Unmarshal(result.data, &states)
		stateByEntity := map[string]string{}
		for _, st := range states {
			if eid := jsonStr(st["entity_id"]); eid != "" {
				stateByEntity[eid] = jsonStr(st["state"])
			}
		}
		for _, r := range haToPrinter {
			entity := jsonStr(r["triggerEntity"])
			current, present := stateByEntity[entity]
			if !present {
				continue
			}
			key := "e:" + entity
			prev, hadPrev := haEngineLastEntityState[key]
			haEngineLastEntityState[key] = current
			if !hadPrev || prev == current || current != jsonStr(r["triggerState"]) {
				continue
			}
			printer, perr := getPrinterConn(ctx, jsonStr(r["printerId"]))
			if perr != nil || printer == nil {
				continue
			}
			_ = dispatchPrintControl(ctx, printer, jsonStr(r["printerCommand"]))
		}
	}
}

// callHaService calls an HA service (e.g. switch.turn_off) on an optional entity.
func callHaService(ctx context.Context, config haConfig, service, entity string, data json.RawMessage) error {
	dot := strings.IndexByte(service, '.')
	if dot <= 0 {
		return fmt.Errorf("invalid service %q", service)
	}
	domain := service[:dot]
	name := service[dot+1:]
	var payload map[string]any
	if isJSONObject(data) {
		_ = json.Unmarshal(data, &payload)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	if entity != "" {
		payload["entity_id"] = entity
	}
	body, _ := json.Marshal(payload)
	res := haFetch(ctx, config, "/services/"+domain+"/"+name, http.MethodPost, body)
	if !res.ok {
		return errors.New(res.errMsg)
	}
	return nil
}

// dispatchPrintControl sends pause/resume/cancel to a printer regardless of
// profile: Bambu over MQTT, everything else over its Moonraker HTTP API.
func dispatchPrintControl(ctx context.Context, printer *printerConn, command string) error {
	if !haPrinterCommands[command] {
		return fmt.Errorf("unsupported print command: %s", command)
	}
	if bambuProfiles[printer.Profile] {
		return sendBambuCommand(printer, command, map[string]any{})
	}
	base := reHaTrailingSlash.ReplaceAllString(printer.URL, "")
	if base == "" {
		return fmt.Errorf("printer %s has no URL for HTTP control", printer.ID)
	}
	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base+"/printer/print/"+command, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("printer responded HTTP %d", resp.StatusCode)
	}
	return nil
}

func getPrinterStatusByID(ctx context.Context, id string) (string, bool) {
	var status *string
	err := dbPool.QueryRow(ctx, `SELECT status FROM printers WHERE id = $1;`, id).Scan(&status)
	if err != nil {
		return "", false
	}
	return derefStr(status), true
}
