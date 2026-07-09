package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"

	"printfarm/internal/secretcrypto"
	"printfarm/internal/telemetry"
)

type refreshResult struct {
	next   pmap
	failed bool
}

func desiredPoolSize(n int) int {
	d := pollConcurrency
	if d <= 0 {
		d = pollConcurrencyMax
		if v := maxInt(pollConcurrencyMin, n); v < d {
			d = v
		}
	}
	if d < 1 {
		d = 1
	}
	return d
}

// refreshAll runs computeNextPrinter for every printer on a bounded worker pool,
// preserving input order. Workers do network/MQTT I/O only — no DB access.
func refreshAll(printers []pmap) []refreshResult {
	results := make([]refreshResult, len(printers))
	if len(printers) == 0 {
		return results
	}
	sem := make(chan struct{}, desiredPoolSize(len(printers)))
	var wg sync.WaitGroup
	for i, printer := range printers {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, printer pmap) {
			defer wg.Done()
			defer func() { <-sem }()
			next, failed := computeNextPrinter(printer)
			results[i] = refreshResult{next: next, failed: failed}
		}(i, printer)
	}
	wg.Wait()
	return results
}

func run() {
	ctx := context.Background()
	cipher := secretcrypto.FromEnv()
	redisClient = telemetry.FromEnv()
	defer redisClient.Close()

	concurrencyDesc := "auto"
	if pollConcurrency != 0 {
		concurrencyDesc = "fixed"
	}
	redisDesc := "off"
	if redisClient.Enabled() {
		redisDesc = "on"
	}
	log.Printf("poller starting: shard %d/%d, interval %.1fs, concurrency %s (max %d), redis %s",
		shardIndex+1, shardCount, pollInterval.Seconds(), concurrencyDesc, pollConcurrencyMax, redisDesc)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	shuttingDown := false

	var conn *pgx.Conn
	schemaReady := false

	for !shuttingDown {
		cycleStart := time.Now()
		printersPolled, rowsWritten, refreshFailures := 0, 0, 0
		// Bytes to/from printers this cycle (HTTP, Bambu MQTT, Bambu FTP — see
		// netbytes.go). MQTT messages arrive on the client library's own
		// goroutines, so one landing right at the reset/snapshot boundary can
		// occasionally get attributed to the neighboring cycle; acceptable
		// given this whole feature is already approximate.
		resetCycleBytes()

		err := func() error {
			var err error
			if conn == nil || conn.IsClosed() {
				conn, err = connectDB(ctx)
				if err != nil {
					return err
				}
				schemaReady = false
			}
			if !schemaReady {
				if err = ensureSchema(ctx, conn); err != nil {
					return err
				}
				schemaReady = true
			}

			allPrinters, err := listPrinters(ctx, conn, cipher)
			if err != nil {
				return err
			}
			var printers []pmap
			activeIDs := map[string]bool{}
			for _, p := range allPrinters {
				id := mStr(p, "id")
				if ownsPrinter(id) {
					printers = append(printers, p)
					activeIDs[id] = true
				}
			}
			pruneBambuClients(activeIDs)
			pruneTracking(activeIDs)

			webhooks, err := listDiscordWebhooks(ctx, conn)
			if err != nil {
				return err
			}
			estimates, err := listSlicerEstimates(ctx, conn)
			if err != nil {
				return err
			}
			slotEstimates, err := listSlicerSlotEstimates(ctx, conn)
			if err != nil {
				return err
			}

			results := refreshAll(printers)
			now := nowSeconds()
			for i, printer := range printers {
				nextPrinter, failed := results[i].next, results[i].failed
				if failed {
					refreshFailures++
				}
				maybeRecordBambu3mfEstimate(ctx, conn, printer, nextPrinter, estimates, slotEstimates)
				applySlicerFilamentEstimate(nextPrinter, estimates)
				nextPrinter["totalPrintTime"] = accumulateTotalPrintTime(nextPrinter)
				if err := collectAnalyticsForTransition(ctx, conn, printer, nextPrinter); err != nil {
					return err
				}
				notifyForTransition(webhooks, printer, nextPrinter)

				// Filament reader (plan §3a): catalog any Bambu spool the AMS's
				// own RFID reader already identified over MQTT — read-only, no
				// publish (except auto-assignment for a known third-party
				// tag_uid match, which just queues a row for the existing
				// replay pipeline below to push). No-op for Snapmaker/generic
				// printers since their spool entries never carry trayUuid/tagUid.
				if bambuProfiles[mStr(nextPrinter, "profile")] {
					if err := matchOrCreateFilamentSpools(ctx, conn, mStr(printer, "id"), nextPrinter["spools"]); err != nil {
						log.Printf("filament tag matcher error for printer %s: %v", mStr(printer, "id"), err)
					}
					// Deferred-assignment replay, detection half (plan §4) —
					// actuation happens in the Node replay worker once
					// needs_trigger_at is set here.
					if err := detectBambuAssignmentTriggers(ctx, conn, mStr(printer, "id"), rawBambuTrays(printer)); err != nil {
						log.Printf("assignment trigger detection error for printer %s: %v", mStr(printer, "id"), err)
					}

					// Filament usage tracking: on a job transition, resolve the
					// print that just ended to the inventory spools that fed it
					// and decrement their weight_used (filament_consumption.go).
					// Transition-detection condition mirrors
					// collectAnalyticsForTransition's own (transitions.go) —
					// kept as a separate check rather than folded into that
					// function, to avoid touching working Discord-notification
					// logic for an unrelated feature.
					if previousJob := mMap(printer, "currentJob"); previousJob != nil && mStr(nextPrinter, "status") != "offline" {
						nextJob := mMap(nextPrinter, "currentJob")
						if nextJob == nil || mStr(nextJob, "filename") != mStr(previousJob, "filename") {
							outcome := "completed"
							rawState := mStr(nextPrinter, "rawPrintState")
							if rawState == "cancelled" || rawState == "failed" || mStr(nextPrinter, "status") == "error" {
								outcome = "failed"
							}
							pid := mStr(nextPrinter, "id")
							if err := applyFilamentConsumption(ctx, conn, pid, previousJob, outcome, nextPrinter["spools"], slotEstimates); err != nil {
								log.Printf("filament consumption error for printer %s: %v", pid, err)
							}
						}
					}
				}

				id := mStr(printer, "id")
				sig := persistSignature(nextPrinter)
				if shouldPersistPrinter(id, sig, now) {
					if err := upsertPrinter(ctx, conn, cipher, nextPrinter); err != nil {
						return err
					}
					lastPersistSig[id] = sig
					lastPGWrite[id] = now
					rowsWritten++
				}
				publishLiveTelemetry(id, nextPrinter)
			}

			printersPolled = len(printers)
			bytesOut, bytesIn := snapshotCycleBytes()
			return upsertPollerHealth(ctx, conn,
				float64(time.Since(cycleStart).Microseconds())/1000.0,
				printersPolled, rowsWritten, refreshFailures, bytesOut, bytesIn)
		}()

		if err != nil {
			log.Printf("printer poller error: %v", err)
			if conn != nil {
				_ = conn.Close(ctx)
			}
			conn = nil
			schemaReady = false
		}

		elapsed := time.Since(cycleStart)
		if printersPolled > 0 && elapsed > pollInterval {
			log.Printf("poller cycle overran: %.2fs > interval %.2fs for %d printers (%d refresh failures) — raise PRINTER_POLL_CONCURRENCY or add a shard",
				elapsed.Seconds(), pollInterval.Seconds(), printersPolled, refreshFailures)
		}

		wait := pollInterval - elapsed
		if wait < 0 {
			wait = 0
		}
		select {
		case <-stop:
			shuttingDown = true
		case <-time.After(wait):
		}
	}

	// Graceful shutdown: close Bambu MQTT connections and the DB cleanly.
	log.Printf("poller shutting down…")
	bambuClientsMu.Lock()
	for _, c := range bambuClients {
		c.close()
	}
	bambuClientsMu.Unlock()
	if conn != nil && !conn.IsClosed() {
		_ = conn.Close(ctx)
	}
	log.Printf("poller stopped.")
}
