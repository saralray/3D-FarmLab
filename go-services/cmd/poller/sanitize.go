package main

import (
	"math"
	"unicode/utf8"
)

// Printers are UNTRUSTED devices (S-5 / audit MP-2). Their telemetry arrives over
// LAN protocols the farm does not control — a spoofed, malfunctioning, or
// firmware-tampered printer can report NaN/Inf/absurd temperatures, out-of-range
// progress, or unbounded free-text that would then pollute the dashboard, skew
// analytics counters, and be forwarded verbatim into Discord notifications.
//
// sanitizePrinterTelemetry is the single chokepoint (called at the top of
// upsertPrinter, which every printer profile funnels through) that clamps the
// device-derived fields to sane physical bounds and bounds free-text length
// BEFORE anything is persisted. Bounds are deliberately generous — the goal is
// to reject garbage (NaN, 1e18, negative-absurd, megabyte strings), not to
// enforce operational policy, so no legitimate printer is affected. It mutates
// the map in place (the assembled state map is single-use per cycle).
const (
	tempMinC     = -50.0    // below any real ambient; rejects absurd-negative sensor spoofing
	tempMaxC     = 1500.0   // far above any nozzle; rejects absurd-positive spoofing
	progressMin  = 0.0
	progressMax  = 100.0
	maxErrLen    = 500      // error_message → Discord + UI
	maxJobStrLen = 256      // job/file names → Discord + UI
	jobNumCap    = 1.0e9    // generic finite cap for currentJob numerics (grams, minutes, …)
)

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// finiteOr returns v clamped to [lo,hi] when v is a finite number, else def.
func finiteOr(v any, lo, hi, def float64) float64 {
	f, ok := asFloat(v)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return def
	}
	return clampFloat(f, lo, hi)
}

// truncateRunes bounds a string to max UTF-8 runes without splitting a rune.
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

func sanitizeTemp(v any) float64 { return finiteOr(v, tempMinC, tempMaxC, 0) }

// sanitizeNumericSlice clamps every numeric element of a []any temperature list
// to the sane temperature range, dropping NaN/Inf to 0; non-numeric elements are
// left untouched (they'll serialize as-is but aren't device-controlled numerics).
func sanitizeNumericSlice(v any) {
	s, ok := v.([]any)
	if !ok {
		return
	}
	for i, el := range s {
		if _, isNum := asFloat(el); isNum {
			s[i] = sanitizeTemp(el)
		}
	}
}

// sanitizeJobMap bounds the free-text and numeric fields of a currentJob map.
// It is key-agnostic (works for every profile's job shape): strings are length-
// bounded, a "progress" field is clamped to [0,100], and any other numeric is
// made finite and capped to a large sane magnitude.
func sanitizeJobMap(v any) {
	m, ok := v.(pmap)
	if !ok {
		return
	}
	for k, val := range m {
		switch tv := val.(type) {
		case string:
			m[k] = truncateRunes(tv, maxJobStrLen)
		default:
			if _, isNum := asFloat(val); isNum {
				if k == "progress" {
					m[k] = finiteOr(val, progressMin, progressMax, 0)
				} else {
					m[k] = finiteOr(val, -jobNumCap, jobNumCap, 0)
				}
			}
		}
	}
}

func sanitizePrinterTelemetry(p pmap) {
	if p == nil {
		return
	}
	// Measured temperatures.
	if temp := mMap(p, "temperature"); temp != nil {
		temp["nozzle"] = sanitizeTemp(temp["nozzle"])
		temp["bed"] = sanitizeTemp(temp["bed"])
		temp["chamber"] = sanitizeTemp(temp["chamber"])
	}
	// Target temperatures are passed raw to SQL; keep nil (no target) as nil but
	// clamp any numeric and drop non-finite garbage to nil.
	for _, key := range []string{"bedTarget", "chamberTarget"} {
		if val, present := p[key]; present && val != nil {
			if f, ok := asFloat(val); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
				p[key] = clampFloat(f, 0, tempMaxC)
			} else {
				p[key] = nil
			}
		}
	}
	// Per-nozzle temperature arrays (jsonb).
	sanitizeNumericSlice(p["nozzleTemperatures"])
	sanitizeNumericSlice(p["nozzleTargets"])
	// Overall progress.
	if _, present := p["progress"]; present {
		p["progress"] = finiteOr(p["progress"], progressMin, progressMax, 0)
	}
	// Free-text error message (forwarded to Discord/UI).
	if s, ok := p["errorMessage"].(string); ok {
		p["errorMessage"] = truncateRunes(s, maxErrLen)
	}
	// Current job free-text + numerics.
	sanitizeJobMap(p["currentJob"])
}
