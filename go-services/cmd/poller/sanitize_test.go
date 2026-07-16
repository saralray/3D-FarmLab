package main

import (
	"math"
	"strings"
	"testing"
)

func TestSanitizeTemperaturesClampGarbage(t *testing.T) {
	p := pmap{
		"temperature": pmap{
			"nozzle":  math.NaN(),
			"bed":     math.Inf(1),
			"chamber": 1.0e18,
		},
	}
	sanitizePrinterTelemetry(p)
	temp := p["temperature"].(pmap)
	if temp["nozzle"].(float64) != 0 {
		t.Errorf("NaN nozzle => %v, want 0", temp["nozzle"])
	}
	if temp["bed"].(float64) != 0 {
		t.Errorf("+Inf bed => %v, want 0", temp["bed"])
	}
	if temp["chamber"].(float64) != tempMaxC {
		t.Errorf("1e18 chamber => %v, want %v", temp["chamber"], tempMaxC)
	}
}

func TestSanitizeTemperaturesKeepLegitimate(t *testing.T) {
	// A real high-temp setup must pass through untouched.
	p := pmap{"temperature": pmap{"nozzle": 285.4, "bed": 110.0, "chamber": 60.0}}
	sanitizePrinterTelemetry(p)
	temp := p["temperature"].(pmap)
	if temp["nozzle"].(float64) != 285.4 || temp["bed"].(float64) != 110.0 || temp["chamber"].(float64) != 60.0 {
		t.Errorf("legitimate temps altered: %v", temp)
	}
}

func TestSanitizeProgressClamp(t *testing.T) {
	for _, tc := range []struct{ in, want float64 }{
		{-5, 0}, {0, 0}, {50, 50}, {100, 100}, {1e9, 100},
	} {
		p := pmap{"progress": tc.in}
		sanitizePrinterTelemetry(p)
		if got := p["progress"].(float64); got != tc.want {
			t.Errorf("progress %v => %v, want %v", tc.in, got, tc.want)
		}
	}
	p := pmap{"progress": math.NaN()}
	sanitizePrinterTelemetry(p)
	if p["progress"].(float64) != 0 {
		t.Errorf("NaN progress => %v, want 0", p["progress"])
	}
}

func TestSanitizeTargetsNilAndClamp(t *testing.T) {
	p := pmap{"bedTarget": 1.0e12, "chamberTarget": math.Inf(-1)}
	sanitizePrinterTelemetry(p)
	if p["bedTarget"].(float64) != tempMaxC {
		t.Errorf("huge bedTarget => %v, want %v", p["bedTarget"], tempMaxC)
	}
	if p["chamberTarget"] != nil {
		t.Errorf("-Inf chamberTarget => %v, want nil", p["chamberTarget"])
	}
	// Absent target stays absent (no spurious 0 written).
	p2 := pmap{}
	sanitizePrinterTelemetry(p2)
	if _, present := p2["bedTarget"]; present {
		t.Errorf("absent bedTarget should stay absent")
	}
}

func TestSanitizeErrorMessageTruncated(t *testing.T) {
	long := strings.Repeat("A", maxErrLen+500)
	p := pmap{"errorMessage": long}
	sanitizePrinterTelemetry(p)
	if got := p["errorMessage"].(string); len(got) != maxErrLen {
		t.Errorf("errorMessage len %d, want %d", len(got), maxErrLen)
	}
}

func TestSanitizeErrorMessageMultibyteSafe(t *testing.T) {
	// Truncation must not split a multi-byte rune.
	long := strings.Repeat("é", maxErrLen+50) // 2 bytes each
	p := pmap{"errorMessage": long}
	sanitizePrinterTelemetry(p)
	got := p["errorMessage"].(string)
	if !isValidUTF8(got) {
		t.Errorf("truncation split a rune: invalid UTF-8")
	}
}

func TestSanitizeJobMap(t *testing.T) {
	p := pmap{"currentJob": pmap{
		"name":         strings.Repeat("x", maxJobStrLen+100),
		"progress":     1e9,
		"filamentUsed": math.Inf(1),
		"printTime":    -42.0,
		"status":       "printing",
	}}
	sanitizePrinterTelemetry(p)
	job := p["currentJob"].(pmap)
	if l := len([]rune(job["name"].(string))); l != maxJobStrLen {
		t.Errorf("job name runes %d, want %d", l, maxJobStrLen)
	}
	if job["progress"].(float64) != 100 {
		t.Errorf("job progress => %v, want 100", job["progress"])
	}
	if job["filamentUsed"].(float64) != 0 {
		t.Errorf("Inf filamentUsed => %v, want 0", job["filamentUsed"])
	}
	if job["printTime"].(float64) != -jobNumCap && job["printTime"].(float64) != -42.0 {
		// -42 is within [-cap,cap], so it should be preserved.
		t.Errorf("printTime -42 => %v, want -42", job["printTime"])
	}
	if job["status"].(string) != "printing" {
		t.Errorf("short status altered: %v", job["status"])
	}
}

func TestSanitizeNozzleArrays(t *testing.T) {
	p := pmap{"nozzleTemperatures": []any{250.0, math.NaN(), 1e18}}
	sanitizePrinterTelemetry(p)
	arr := p["nozzleTemperatures"].([]any)
	if arr[0].(float64) != 250.0 || arr[1].(float64) != 0 || arr[2].(float64) != tempMaxC {
		t.Errorf("nozzle array not sanitized: %v", arr)
	}
}

func TestSanitizeNilSafe(t *testing.T) {
	sanitizePrinterTelemetry(nil) // must not panic
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}
