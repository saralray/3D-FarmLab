package main

import (
	"math"
	"strconv"
	"strings"
)

func itoa(i int) string { return strconv.Itoa(i) }

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// round2 mirrors JS Math.round(x*100)/100.
func round2(x float64) float64 {
	return math.Round(x*100) / 100
}

// matchLubric mirrors /lubric/i.test(s).
func matchLubric(s string) bool {
	return strings.Contains(strings.ToLower(s), "lubric")
}

// trimString mirrors String(value ?? ”).trim() for string-ish values.
func trimString(v any) string {
	switch s := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(s)
	default:
		return ""
	}
}
