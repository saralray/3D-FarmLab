package main

import "sync/atomic"

// Cycle-scoped byte counters for the poller's own traffic to/from printers
// (HTTP polling, Bambu MQTT, Bambu FTP). Reset at the start of each poll
// cycle in run() and snapshotted right before the cycle's poller_health
// upsert, so — like printersPolled/rowsWritten/refreshFailures — these
// reflect "this cycle" rather than an ever-growing total. refreshAll runs
// computeNextPrinter on a worker pool, so these are atomics rather than
// plain counters.
var (
	cycleBytesOut int64
	cycleBytesIn  int64
)

func resetCycleBytes() {
	atomic.StoreInt64(&cycleBytesOut, 0)
	atomic.StoreInt64(&cycleBytesIn, 0)
}

func addBytesOut(n int) {
	if n > 0 {
		atomic.AddInt64(&cycleBytesOut, int64(n))
	}
}

func addBytesIn(n int) {
	if n > 0 {
		atomic.AddInt64(&cycleBytesIn, int64(n))
	}
}

func snapshotCycleBytes() (out, in int64) {
	return atomic.LoadInt64(&cycleBytesOut), atomic.LoadInt64(&cycleBytesIn)
}
