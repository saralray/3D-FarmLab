package main

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ── Runtime configuration, mirroring printer_status_poller.py's module globals ──

var (
	pollInterval   = durationFromMs("PRINTER_POLL_INTERVAL_MS", 2000, 1000)
	requestTimeout = durationFromMs("PRINTER_REQUEST_TIMEOUT_MS", 3000, 1000)
	offlineGrace   = time.Duration(envInt("PRINTER_OFFLINE_GRACE_SECONDS", 30, 0)) * time.Second
	// Force a write at most this stale even when telemetry is unchanged (0 = write every cycle).
	persistMaxInterval = durationFromMs("PRINTER_PERSIST_MAX_INTERVAL_MS", 30000, 0)

	pollConcurrency    = envInt("PRINTER_POLL_CONCURRENCY", 0, 0)
	pollConcurrencyMax = envIntMin("PRINTER_POLL_CONCURRENCY_MAX", 64, 1)
	pollConcurrencyMin = 8

	shardCount = envIntMin("POLLER_SHARD_COUNT", 1, 1)
	shardIndex = ((envInt("POLLER_SHARD_INDEX", 0, -1<<30) % shardCount) + shardCount) % shardCount

	dbConnectTimeout   = time.Duration(maxInt(envInt("DATABASE_CONNECT_TIMEOUT_MS", 5000, 0)/1000, 1)) * time.Second
	dbStatementTimeout = envInt("DATABASE_STATEMENT_TIMEOUT_MS", 30000, 0)
	dbIdleTxTimeout    = envInt("DATABASE_IDLE_TX_TIMEOUT_MS", 60000, 0)

	webSnapshotBaseURL = strings.TrimRight(envStr("WEB_SNAPSHOT_BASE_URL", "http://web:5173"), "/")
	bambuDoorDebug     = isTruthy(os.Getenv("BAMBU_DOOR_DEBUG"))
)

// Derived timing bounds.
var (
	bambuSnapshotTimeout    = maxDuration(requestTimeout, 10*time.Second)
	bambuReportFreshness    = maxDuration(pollInterval*4, 20*time.Second)
	bambuFtpTimeout         = maxDuration(requestTimeout, 8*time.Second)
	maxPrintTimeStep        = maxDuration(pollInterval*6, 120*time.Second)
	telemetryTTL            = maxInt(int(pollInterval.Seconds())*10, 60)
	bambuPushallMinInterval = 10 * time.Second
)

// Profile sets (frozensets in Python).
var (
	bambuProfiles           = set("bambulab_a1_mini", "bambulab_h2s", "bambulab_h2d", "bambulab_h2c")
	bambuRtspProfiles       = set("bambulab_h2s", "bambulab_h2d", "bambulab_h2c")
	bambuDualNozzleProfiles = set("bambulab_h2d", "bambulab_h2c")
	bambuDoorProfiles       = set("bambulab_h2s", "bambulab_h2d", "bambulab_h2c")
	bambuFtpBlockedProfiles = set("bambulab_h2s", "bambulab_h2d", "bambulab_h2c")
)

const (
	maxFrameBytes = 25 * 1024 * 1024

	bambuMqttPort     = 8883
	bambuMqttUsername = "bblp"
	bambuFtpPort      = 990
	bambuFtpUsername  = "bblp"

	snapmakerStatusPath = "/printer/objects/query?print_stats&extruder=temperature,target" +
		"&extruder1=temperature,target&extruder2=temperature,target" +
		"&extruder3=temperature,target&heater_bed=temperature,target" +
		"&virtual_sdcard=progress&fan=speed&toolhead=extruder"
)

var mjpegContentLengthRe = regexp.MustCompile(`(?i)content-length:\s*(\d+)`)

// gcode_state → dashboard status (BAMBU_STATE_MAP).
var bambuStateMap = map[string]string{
	"RUNNING": "printing",
	"PREPARE": "printing",
	"SLICING": "printing",
	"PAUSE":   "paused",
	"FINISH":  "idle",
	"IDLE":    "idle",
}

// ── env helpers ──────────────────────────────────────────────────────────────

func envStr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envInt(name string, def, min int) int {
	v := def
	if raw := os.Getenv(name); raw != "" {
		if parsed, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
			v = parsed
		}
	}
	if v < min {
		v = min
	}
	return v
}

// envIntMin is envInt with the floor doubling as the minimum returned value.
func envIntMin(name string, def, min int) int { return envInt(name, def, min) }

func durationFromMs(name string, defMs, minMs int) time.Duration {
	ms := envInt(name, defMs, minMs)
	return time.Duration(ms) * time.Millisecond
}

func isTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func set(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, item := range items {
		m[item] = true
	}
	return m
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
