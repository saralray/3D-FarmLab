package main

import (
	"encoding/json"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// settings.go ports the read-side shaping helpers for the app_settings-backed
// settings endpoints (server/app.js getBranding / getIntegrationUrls /
// getPublicViewerSetting and the layout reads). Each takes the raw stored JSON
// value (or nil when the key is absent) and returns the same shape the Node
// handlers send.

// decodeStored unmarshals a stored app_settings value into a generic map.
// Returns an empty map when the value is null/absent or not an object, matching
// the Node `(await getAppSetting(KEY)) || {}` idiom.
func decodeStored(raw json.RawMessage) map[string]any {
	if isJSONNull(raw) {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func storedString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// brandingResponse / integrationUrlsResponse use ordered struct fields so the
// emitted key order matches Node's object literals (Go marshals map keys sorted).
type brandingResponse struct {
	SiteName          string  `json:"siteName"`
	LogoDataUrl       string  `json:"logoDataUrl"`
	LogoSvg           string  `json:"logoSvg"`
	LogoAdaptive      bool    `json:"logoAdaptive"`
	LogoScale         float64 `json:"logoScale"`
	BackgroundDataUrl string  `json:"backgroundDataUrl"`
	FaviconDataUrl    string  `json:"faviconDataUrl"`
}

type integrationUrlsResponse struct {
	GoogleSheetQueueUrl string `json:"googleSheetQueueUrl"`
	GoogleFormUrl       string `json:"googleFormUrl"`
}

// brandingShape mirrors getBranding in server/app.js.
func brandingShape(raw json.RawMessage) brandingResponse {
	m := decodeStored(raw)
	logoAdaptive := false
	if v, ok := m["logoAdaptive"].(bool); ok {
		logoAdaptive = v
	}
	return brandingResponse{
		SiteName:          storedString(m, "siteName"),
		LogoDataUrl:       storedString(m, "logoDataUrl"),
		LogoSvg:           storedString(m, "logoSvg"),
		LogoAdaptive:      logoAdaptive,
		LogoScale:         clampLogoScale(m["logoScale"]),
		BackgroundDataUrl: storedString(m, "backgroundDataUrl"),
		FaviconDataUrl:    storedString(m, "faviconDataUrl"),
	}
}

// clampLogoScale mirrors clampLogoScale: default 1, clamped to [0.5, 2], rounded
// to two decimals.
func clampLogoScale(v any) float64 {
	scale, ok := toFloat(v)
	if !ok {
		return 1
	}
	if math.IsNaN(scale) || math.IsInf(scale, 0) {
		return 1
	}
	scale = math.Round(scale*100) / 100
	if scale < 0.5 {
		scale = 0.5
	}
	if scale > 2 {
		scale = 2
	}
	return scale
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		// Node coerces with Number(string); a numeric string parses, others fail.
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil
	}
	return 0, false
}

// integrationUrlsShape mirrors getIntegrationUrls.
func integrationUrlsShape(raw json.RawMessage) integrationUrlsResponse {
	m := decodeStored(raw)
	return integrationUrlsResponse{
		GoogleSheetQueueUrl: storedString(m, "googleSheetQueueUrl"),
		GoogleFormUrl:       storedString(m, "googleFormUrl"),
	}
}

// publicViewerShape mirrors getPublicViewerSetting: enabled unless explicitly
// stored as false.
func publicViewerShape(raw json.RawMessage) map[string]any {
	m := decodeStored(raw)
	enabled := true
	if v, ok := m["enabled"].(bool); ok && !v {
		enabled = false
	}
	return map[string]any{"enabled": enabled}
}

// layoutShape mirrors the { layout: <stored> } responses; the stored value is
// passed through verbatim (or null when unset).
func layoutShape(raw json.RawMessage) map[string]any {
	if isJSONNull(raw) {
		return map[string]any{"layout": nil}
	}
	return map[string]any{"layout": raw}
}

// isValidIanaTimezone mirrors the Node helper of the same name (which probes
// Intl.DateTimeFormat); Go's equivalent probe is a location load.
func isValidIanaTimezone(timezone string) bool {
	_, err := time.LoadLocation(timezone)
	return err == nil
}

// decodeURIComponent mirrors JS decodeURIComponent for path segments. PathUnescape
// (unlike QueryUnescape) leaves '+' literal, matching decodeURIComponent.
func decodeURIComponent(s string) (string, error) {
	return url.PathUnescape(s)
}
