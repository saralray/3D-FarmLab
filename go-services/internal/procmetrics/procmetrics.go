// Package procmetrics adds the standard Prometheus process_* metrics (resident
// memory, virtual memory, CPU, open fds, start time) to a metrics.Writer by
// reading Linux /proc. The Python exporter got these for free from
// prometheus_client's default collector; reproducing them keeps the Go exporter
// a drop-in replacement. The Python-specific python_* metrics are intentionally
// not reproduced.
package procmetrics

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"printfarm/internal/metrics"
)

// clockTicks is sysconf(_SC_CLK_TCK); 100 on every mainstream Linux build, which
// is what the prometheus client libraries also assume.
const clockTicks = 100.0

// pageSize is the memory page size; 4096 on the Linux targets we run in Docker.
const pageSize = 4096.0

// startTime is the process start in unix epoch seconds, captured at import time
// — equivalent to prometheus's process_start_time_seconds.
var startTime = float64(time.Now().UnixNano()) / 1e9

// Add appends the process_* metrics to w. Any read failure is silently skipped
// for that metric, never failing the scrape.
func Add(w *metrics.Writer) {
	w.Gauge("process_start_time_seconds",
		"Start time of the process since unix epoch in seconds.", startTime, nil, nil)

	if rss, vsz, ok := memory(); ok {
		w.Gauge("process_resident_memory_bytes", "Resident memory size in bytes.", rss, nil, nil)
		w.Gauge("process_virtual_memory_bytes", "Virtual memory size in bytes.", vsz, nil, nil)
	}
	if cpu, ok := cpuSeconds(); ok {
		w.Counter("process_cpu_seconds", "Total user and system CPU time spent in seconds.", cpu)
	}
	if fds, ok := openFDs(); ok {
		w.Gauge("process_open_fds", "Number of open file descriptors.", fds, nil, nil)
	}
	if max, ok := maxFDs(); ok {
		w.Gauge("process_max_fds", "Maximum number of open file descriptors.", max, nil, nil)
	}
}

func maxFDs() (float64, bool) {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return 0, false
	}
	return float64(rl.Cur), true
}

func memory() (rss, vsz float64, ok bool) {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, 0, false
	}
	size, err1 := strconv.ParseFloat(fields[0], 64)
	res, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return res * pageSize, size * pageSize, true
}

func cpuSeconds() (float64, bool) {
	data, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0, false
	}
	// comm (field 2) is parenthesised and may contain spaces; everything after
	// the last ')' is space-separated and starts at field 3 (state).
	s := string(data)
	close := strings.LastIndexByte(s, ')')
	if close < 0 || close+2 >= len(s) {
		return 0, false
	}
	fields := strings.Fields(s[close+2:])
	// utime is field 14 → index 11 here; stime is field 15 → index 12.
	if len(fields) < 13 {
		return 0, false
	}
	utime, err1 := strconv.ParseFloat(fields[11], 64)
	stime, err2 := strconv.ParseFloat(fields[12], 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return (utime + stime) / clockTicks, true
}

func openFDs() (float64, bool) {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0, false
	}
	return float64(len(entries)), true
}
