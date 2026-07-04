package main

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Deferred-assignment replay, detection half (plan §4): watches
// filament_station_assignments rows for a printer and flags the ones whose
// slot just transitioned from empty to loaded (needs_trigger_at), or whose
// slot no longer matches what's assigned (deleted — auto-unlink, matching
// Bambuddy's on_ams_change, bambuddy/backend/app/main.py:1143-1320).
// Actuation (the MQTT override call once needs_trigger_at is set) lives in
// the Node replay worker in server/app.js — this side only detects.
//
// Bambu only for now: Snapmaker's equivalent needs the gcode fallback macro
// names verified against real firmware first (plan §3b/§8) — wiring
// detection for it ahead of that would just set needs_trigger_at with
// nothing safe to consume it.

type assignmentRow struct {
	id               string
	amsID, trayID    int
	fingerprintColor string
	fingerprintType  string
	pendingConfig    bool
}

func listAssignmentsForPrinter(ctx context.Context, conn *pgx.Conn, printerID string) ([]assignmentRow, error) {
	rows, err := conn.Query(ctx, `
		SELECT id, ams_id, tray_id, COALESCE(fingerprint_color, ''), COALESCE(fingerprint_type, ''), pending_config
		FROM filament_station_assignments WHERE printer_id = $1`, printerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []assignmentRow
	for rows.Next() {
		var a assignmentRow
		if err := rows.Scan(&a.id, &a.amsID, &a.trayID, &a.fingerprintColor, &a.fingerprintType, &a.pendingConfig); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func deleteAssignmentByID(ctx context.Context, conn *pgx.Conn, id string) error {
	_, err := conn.Exec(ctx, `DELETE FROM filament_station_assignments WHERE id = $1`, id)
	return err
}

func markAssignmentNeedsTrigger(ctx context.Context, conn *pgx.Conn, id, color, trayType string) error {
	_, err := conn.Exec(ctx, `
		UPDATE filament_station_assignments
		SET fingerprint_color = $2, fingerprint_type = $3, needs_trigger_at = NOW()
		WHERE id = $1`, id, color, trayType)
	return err
}

// bambuTrayLoaded mirrors the two-firmware-quirk guard documented in
// bambuddy/backend/app/main.py:1237-1247: state==11 is Bambu's explicit
// "filament fed to extruder" code, but some firmwares (A1 Mini BMCU,
// P1S Standard AMS) never emit it and always report state==3 — so a
// non-empty tray_type is also accepted as "loaded" as long as state isn't
// one of the firmware's explicit empty signals (9, 10).
func bambuTrayLoaded(state int, trayType string) bool {
	if state == 11 {
		return true
	}
	if state == 9 || state == 10 {
		return false
	}
	return trayType != ""
}

func trayColorHex(tray pmap) string {
	c := mStr(tray, "tray_color")
	if len(c) >= 6 {
		return strings.ToUpper(c[:6])
	}
	return ""
}

// detectBambuAssignmentTriggers is called once per Bambu printer per poll
// cycle. rawTrays comes from rawBambuTrays(printer) — the same cached MQTT
// report this cycle's fetchBambuStatus already read.
func detectBambuAssignmentTriggers(ctx context.Context, conn *pgx.Conn, printerID string, rawTrays map[string]pmap) error {
	if rawTrays == nil {
		return nil // no fresh report this cycle — don't act on stale/absent data
	}
	assignments, err := listAssignmentsForPrinter(ctx, conn, printerID)
	if err != nil {
		return err
	}

	for _, a := range assignments {
		tray, present := rawTrays[bambuTrayKey(a.amsID, a.trayID)]
		if !present {
			// Slot no longer reported by the AMS at all — stale, let the
			// operator re-assign rather than leave a dangling row.
			if err := deleteAssignmentByID(ctx, conn, a.id); err != nil {
				return err
			}
			continue
		}

		trayType := mStr(tray, "tray_type")
		trayColor := trayColorHex(tray)
		state := mInt(tray, "state")

		if a.pendingConfig && a.fingerprintType == "" {
			// Deferred assignment (slot was empty when assigned) — fire the
			// moment it transitions to loaded. Bambu RFID, 3rd-party spool
			// pushed manually, doesn't matter which; any load counts.
			if bambuTrayLoaded(state, trayType) {
				if err := markAssignmentNeedsTrigger(ctx, conn, a.id, trayColor, trayType); err != nil {
					return err
				}
			}
			continue
		}

		if a.fingerprintType != "" {
			colorChanged := trayColor != "" && !strings.EqualFold(trayColor, a.fingerprintColor)
			typeChanged := trayType != "" && !strings.EqualFold(trayType, a.fingerprintType)
			if colorChanged || typeChanged {
				// A different spool is now in this slot — auto-unlink so the
				// operator can re-assign, rather than silently keeping stale
				// config pointed at a slot that no longer has that spool.
				if err := deleteAssignmentByID(ctx, conn, a.id); err != nil {
					return err
				}
			}
			// Fingerprint still matches — same spool still in slot, nothing to do.
		}
	}
	return nil
}
