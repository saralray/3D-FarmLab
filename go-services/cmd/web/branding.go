package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// branding.go ports the branding write path and the favicon image endpoint from
// server/app.js: PUT /api/settings/branding (with the SVG theme-analysis that
// keeps a `currentColor` adaptive copy of monochrome logos) and GET
// /api/settings/favicon (serves the stored favicon data URL as a raw image).

const (
	maxLogoDataURLBytes       = 700 * 1024
	maxBackgroundDataURLBytes = 4 * 1024 * 1024
	maxFaviconDataURLBytes    = 350 * 1024
	maxBrandingBodyBytes      = maxLogoDataURLBytes + maxBackgroundDataURLBytes + maxFaviconDataURLBytes + 16*1024
	maxSiteNameRunes          = 120
)

// Image data-URL validators (case-sensitive, mirroring the Node regexes which
// carry no /i flag).
var (
	reImageDataURL   = regexp.MustCompile(`^data:image/(png|jpeg|webp|gif|svg\+xml);base64,`)
	reFaviconDataURL = regexp.MustCompile(`^data:image/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,`)
	reFaviconParse   = regexp.MustCompile(`^data:(image/[^;]+);base64,(.*)$`)
)

// ── SVG sanitize / theme analysis (port of analyzeSvgForTheme & friends) ──────

var (
	reSvgXmlDecl     = regexp.MustCompile(`(?i)<\?xml[\s\S]*?\?>`)
	reSvgDoctype     = regexp.MustCompile(`(?i)<!DOCTYPE[\s\S]*?>`)
	reSvgScript      = regexp.MustCompile(`(?i)<script[\s\S]*?</script>`)
	reSvgForeign     = regexp.MustCompile(`(?i)<foreignObject[\s\S]*?</foreignObject>`)
	reSvgOnAttrDQ    = regexp.MustCompile(`(?i)\son\w+\s*=\s*"[^"]*"`)
	reSvgOnAttrSQ    = regexp.MustCompile(`(?i)\son\w+\s*=\s*'[^']*'`)
	reSvgBadHref     = regexp.MustCompile(`(?i)(?:xlink:href|href)\s*=\s*"(?:\s*javascript:|\s*https?:|\s*data:)[^"]*"`)
	reSvgOpenTag     = regexp.MustCompile(`(?i)<svg\b[^>]*>`)
	reSvgHasViewBox  = regexp.MustCompile(`(?i)viewBox\s*=`)
	reSvgWidth       = regexp.MustCompile(`(?i)(?:^|\s)width\s*=\s*["']?([\d.]+)`)
	reSvgHeight      = regexp.MustCompile(`(?i)(?:^|\s)height\s*=\s*["']?([\d.]+)`)
	reSvgStart       = regexp.MustCompile(`(?i)<svg\b`)
	reSvgWHAttr      = regexp.MustCompile(`(?i)\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[\d.]+)`)
	reSvgPresent     = regexp.MustCompile(`(?i)<svg[\s>]`)
	reSvgColorAttr   = regexp.MustCompile(`(?i)(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*([^"';>\s]+)`)
	reSvgHasFillDecl = regexp.MustCompile(`(?i)fill\s*[:=]`)
)

var svgColorKeywords = map[string]bool{
	"none": true, "transparent": true, "currentcolor": true, "inherit": true,
	"initial": true, "unset": true, "context-fill": true, "context-stroke": true,
}

func decodeSvgDataUrl(dataURL string) string {
	const prefix = "data:image/svg+xml;base64,"
	if !strings.HasPrefix(dataURL, prefix) {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(dataURL[len(prefix):])
	if err != nil {
		return ""
	}
	return string(b)
}

// sanitizeSvg strips the obvious active-content vectors before inlining
// admin-uploaded SVG markup.
func sanitizeSvg(svg string) string {
	svg = reSvgXmlDecl.ReplaceAllString(svg, "")
	svg = reSvgDoctype.ReplaceAllString(svg, "")
	svg = reSvgScript.ReplaceAllString(svg, "")
	svg = reSvgForeign.ReplaceAllString(svg, "")
	svg = reSvgOnAttrDQ.ReplaceAllString(svg, "")
	svg = reSvgOnAttrSQ.ReplaceAllString(svg, "")
	svg = reSvgBadHref.ReplaceAllString(svg, "")
	return strings.TrimSpace(svg)
}

func replaceFirst(re *regexp.Regexp, s, repl string) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return s
	}
	return s[:loc[0]] + repl + s[loc[1]:]
}

func firstGroup(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// normalizeSvgSize drops the root width/height (so CSS controls the size, keeping
// aspect ratio via viewBox) and synthesizes a viewBox from width/height when
// missing. Operates on the first <svg ...> tag only, like the Node single-replace.
func normalizeSvgSize(svg string) string {
	loc := reSvgOpenTag.FindStringIndex(svg)
	if loc == nil {
		return svg
	}
	tag := svg[loc[0]:loc[1]]
	next := tag
	if !reSvgHasViewBox.MatchString(next) {
		width := firstGroup(reSvgWidth, next)
		height := firstGroup(reSvgHeight, next)
		if width != "" && height != "" {
			next = replaceFirst(reSvgStart, next, `<svg viewBox="0 0 `+width+` `+height+`"`)
		}
	}
	next = reSvgWHAttr.ReplaceAllString(next, "")
	return svg[:loc[0]] + next + svg[loc[1]:]
}

type svgThemeResult struct {
	svg      string
	adaptive bool
}

// analyzeSvgForTheme decides whether the SVG is a single-color mark that can be
// recolored to follow the theme; if so it swaps every visible color for
// currentColor. Returns the size-normalized markup either way.
func analyzeSvgForTheme(rawSvg string) svgThemeResult {
	svg := normalizeSvgSize(sanitizeSvg(rawSvg))
	if !reSvgPresent.MatchString(svg) {
		return svgThemeResult{svg: "", adaptive: false}
	}

	var originalValues []string
	normalizedColors := map[string]bool{}
	for _, m := range reSvgColorAttr.FindAllStringSubmatch(svg, -1) {
		raw := strings.TrimSpace(m[1])
		normalized := strings.ToLower(raw)
		if svgColorKeywords[normalized] || strings.HasPrefix(normalized, "url(") {
			continue
		}
		originalValues = append(originalValues, raw)
		normalizedColors[normalized] = true
	}

	// More than one distinct color → real multi-color logo; keep it untouched.
	if len(normalizedColors) > 1 {
		return svgThemeResult{svg: svg, adaptive: false}
	}

	themed := svg
	for _, value := range uniqueInOrder(originalValues) {
		re := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(value))
		themed = re.ReplaceAllString(themed, "currentColor")
	}
	// No explicit fill anywhere → pin the default black fill to currentColor.
	if len(originalValues) == 0 && !reSvgHasFillDecl.MatchString(themed) {
		themed = replaceFirst(reSvgStart, themed, `<svg fill="currentColor"`)
	}

	return svgThemeResult{svg: themed, adaptive: true}
}

// uniqueInOrder dedups preserving first-seen order (JS `new Set(values)`).
func uniqueInOrder(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// ── PUT /api/settings/branding ────────────────────────────────────────────────

func handleBrandingPut(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	// Read with the branding-specific cap; a body over the limit is a 413 with the
	// same message Node's readBodyBounded throws (caught by its top handler).
	body, err := io.ReadAll(io.LimitReader(req.Body, maxBrandingBodyBytes+1))
	if err != nil {
		internalError(w, "read branding body", err)
		return
	}
	if len(body) > maxBrandingBodyBytes {
		sendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Request body is too large"}, "")
		return
	}
	m := map[string]any{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &m)
		if m == nil {
			m = map[string]any{}
		}
	}

	logoRaw, ok := m["logoDataUrl"].(string)
	if !ok {
		badRequest(w, "logoDataUrl must be a string")
		return
	}
	trimmed := strings.TrimSpace(logoRaw)
	if trimmed != "" && !reImageDataURL.MatchString(trimmed) {
		badRequest(w, "logoDataUrl must be an empty string or a base64 image data URL")
		return
	}
	if len(trimmed) > maxLogoDataURLBytes {
		sendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Logo image is too large (max ~512 KB)."}, "")
		return
	}

	if v, present := m["backgroundDataUrl"]; present {
		if _, isStr := v.(string); !isStr {
			badRequest(w, "backgroundDataUrl must be a string")
			return
		}
	}
	backgroundDataURL := strings.TrimSpace(stringOrEmpty(m["backgroundDataUrl"]))
	if backgroundDataURL != "" && !reImageDataURL.MatchString(backgroundDataURL) {
		badRequest(w, "backgroundDataUrl must be an empty string or a base64 image data URL")
		return
	}
	if len(backgroundDataURL) > maxBackgroundDataURLBytes {
		sendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Background image is too large (max ~3 MB)."}, "")
		return
	}

	logoScale := clampLogoScale(brandingScaleInput(m))

	if v, present := m["siteName"]; present {
		if _, isStr := v.(string); !isStr {
			badRequest(w, "siteName must be a string")
			return
		}
	}
	siteName := capRunes(strings.TrimSpace(stringOrEmpty(m["siteName"])), maxSiteNameRunes)

	logoSvg := ""
	logoAdaptive := false
	if strings.HasPrefix(trimmed, "data:image/svg+xml;base64,") {
		if raw := decodeSvgDataUrl(trimmed); raw != "" {
			analyzed := analyzeSvgForTheme(raw)
			logoSvg = analyzed.svg
			logoAdaptive = analyzed.adaptive
		}
	}

	if v, present := m["faviconDataUrl"]; present {
		if _, isStr := v.(string); !isStr {
			badRequest(w, "faviconDataUrl must be a string")
			return
		}
	}
	faviconDataURL := strings.TrimSpace(stringOrEmpty(m["faviconDataUrl"]))
	if faviconDataURL != "" && !reFaviconDataURL.MatchString(faviconDataURL) {
		badRequest(w, "faviconDataUrl must be an empty string or a base64 image data URL")
		return
	}
	if len(faviconDataURL) > maxFaviconDataURLBytes {
		sendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Favicon image is too large (max ~256 KB)."}, "")
		return
	}

	// Stored key order matches Node's object literal so the jsonb canonicalization
	// and any direct reads line up.
	value := ojson{
		{"siteName", siteName},
		{"logoDataUrl", trimmed},
		{"logoSvg", logoSvg},
		{"logoAdaptive", logoAdaptive},
		{"logoScale", logoScale},
		{"backgroundDataUrl", backgroundDataURL},
		{"faviconDataUrl", faviconDataURL},
	}
	if err := setAppSetting(ctx, "branding", value); err != nil {
		internalError(w, "setAppSetting branding", err)
		return
	}
	stored, err := getAppSetting(ctx, "branding")
	respondShaped(w, brandingShape(stored), err)
}

// brandingScaleInput mirrors `body?.logoScale ?? 1`: an absent or null logoScale
// becomes 1 (clampLogoScale then leaves it at 1).
func brandingScaleInput(m map[string]any) any {
	if v, ok := m["logoScale"]; ok && v != nil {
		return v
	}
	return float64(1)
}

// capRunes truncates to at most n runes (JS slice(0, n) is by UTF-16 unit; for
// BMP text these coincide).
func capRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ── GET /api/settings/favicon ─────────────────────────────────────────────────

func handleFaviconGet(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	stored, err := getAppSetting(ctx, "branding")
	if err != nil {
		internalError(w, "getAppSetting branding", err)
		return
	}
	faviconDataURL := storedString(decodeStored(stored), "faviconDataUrl")
	if faviconDataURL == "" {
		sendJSON(w, http.StatusNotFound, map[string]any{"error": "No custom favicon configured"}, "")
		return
	}
	mt := reFaviconParse.FindStringSubmatch(faviconDataURL)
	if mt == nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Stored favicon is malformed"}, "")
		return
	}
	imageBytes, derr := base64.StdEncoding.DecodeString(mt[2])
	if derr != nil {
		// Node's Buffer.from is lenient and would emit garbage rather than error;
		// a strict decode failure here still yields no usable image.
		imageBytes = []byte{}
	}
	w.Header().Set("Content-Type", mt[1])
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(imageBytes)
}
