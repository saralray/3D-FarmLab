package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Bambu filament reader (plan §3a): auto-catalogs spools the AMS's own RFID
// reader already identified over MQTT into filament_spools, mirroring
// Bambuddy's spool_tag_matcher.py (create_spool_from_tray/get_spool_by_tag)
// and tag_normalization.py (normalize_tag_uid/normalize_tray_uuid). Read-only
// with respect to MQTT — no publish, just cataloging telemetry that already
// arrived on the poller's existing subscribe-only Bambu connection.

const (
	zeroTagUID   = "0000000000000000"
	zeroTrayUUID = "00000000000000000000000000000000"
)

// normalizeHex keeps only hex characters, uppercased — matches Bambuddy's
// tag_normalization.normalize_hex.
func normalizeHex(value string) string {
	var b strings.Builder
	for _, ch := range strings.TrimSpace(value) {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') {
			b.WriteRune(ch)
		}
	}
	return strings.ToUpper(b.String())
}

// normalizeTagUID mirrors normalize_tag_uid: VARCHAR(16), keep the
// least-significant bytes if longer.
func normalizeTagUID(value string) string {
	uid := normalizeHex(value)
	if len(uid) > 16 {
		uid = uid[len(uid)-16:]
	}
	return uid
}

// normalizeTrayUUID mirrors normalize_tray_uuid: VARCHAR(32), keep the
// canonical 32-char UUID when possible.
func normalizeTrayUUID(value string) string {
	uuid := normalizeHex(value)
	if len(uuid) >= 32 {
		uuid = uuid[:32]
	}
	return uuid
}

// isValidTag reports whether a tag_uid/tray_uuid pair contains a non-zero,
// non-empty value — mirrors spool_tag_matcher.is_valid_tag.
func isValidTag(tagUID, trayUUID string) bool {
	uid := normalizeTagUID(tagUID)
	uidValid := uid != "" && uid != zeroTagUID && uid != strings.Repeat("0", len(uid))
	return uidValid || isValidTrayUUID(trayUUID)
}

// isValidTrayUUID reports whether trayUUID is a genuinely decoded Bambu
// tray_uuid (as opposed to empty/zero — which is what the AMS reports when
// it detected *something* in the tray but couldn't decode Bambu-format data
// from it, e.g. a third-party NTAG tag). Split out from isValidTag because
// the auto-assignment path below must never fire for a genuine Bambu tag —
// the printer already has that one right from its own RFID read.
func isValidTrayUUID(trayUUID string) bool {
	uuid := normalizeTrayUUID(trayUUID)
	return uuid != "" && uuid != zeroTrayUUID && uuid != strings.Repeat("0", len(uuid))
}

// parseMaterialSubtype ports create_spool_from_tray's tray_sub_brands parse
// (spool_tag_matcher.py:60-70): "PLA Basic" -> material="PLA", subtype="Basic";
// a sub_brands string that doesn't start with the tray_type prefix (e.g.
// "PETG-HF") replaces material outright.
func parseMaterialSubtype(trayType, traySubBrands string) (material, subtype string) {
	material = trayType
	if material == "" {
		material = "PLA"
	}
	if traySubBrands == "" {
		return material, ""
	}
	if idx := strings.Index(traySubBrands, " "); idx >= 0 {
		prefix := traySubBrands[:idx]
		rest := traySubBrands[idx+1:]
		if strings.EqualFold(prefix, material) {
			return material, rest
		}
		return traySubBrands, ""
	}
	if !strings.EqualFold(traySubBrands, material) {
		return traySubBrands, ""
	}
	return material, ""
}

// findFilamentSpoolByTag mirrors get_spool_by_tag's precedence: tray_uuid
// (Bambu Lab spools, more reliable) before tag_uid.
func findFilamentSpoolByTag(ctx context.Context, conn *pgx.Conn, tagUID, trayUUID string) (string, error) {
	var id string
	err := conn.QueryRow(ctx, `
		SELECT id FROM filament_spools
		WHERE (tray_uuid IS NOT NULL AND tray_uuid = $1)
		   OR (tag_uid IS NOT NULL AND tag_uid = $2)
		ORDER BY (tray_uuid = $1) DESC
		LIMIT 1`,
		nullIfEmpty(trayUUID), nullIfEmpty(tagUID),
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return id, err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// createFilamentSpoolFromTray mirrors create_spool_from_tray: auto-creates an
// inventory row from AMS tray data. Brand is hardcoded "Bambu Lab" — these are
// always genuine AMS-read tags (an unrecognized/third-party tag never reaches
// this code path, since the AMS itself couldn't read it).
func createFilamentSpoolFromTray(ctx context.Context, conn *pgx.Conn, spool pmap, tagUID, trayUUID string) error {
	material, subtype := parseMaterialSubtype(mStr(spool, "material"), mStr(spool, "traySubBrands"))

	rgba := strings.TrimPrefix(mStr(spool, "color"), "#")
	if rgba == "" {
		rgba = "808080FF"
	} else if len(rgba) == 6 {
		rgba += "FF"
	}

	labelWeight := mFloatDef(spool, "trayWeight", 0)
	nozzleMin := mInt(spool, "nozzleTempMin")
	nozzleMax := mInt(spool, "nozzleTempMax")

	var subtypeArg any
	if subtype != "" {
		subtypeArg = subtype
	}

	_, err := conn.Exec(ctx, `
		INSERT INTO filament_spools (
		  material, subtype, rgba, brand, label_weight, nozzle_temp_min,
		  nozzle_temp_max, tag_uid, tray_uuid, data_origin
		) VALUES ($1,$2,$3,'Bambu Lab',$4,$5,$6,$7,$8,'rfid_auto')`,
		material, subtypeArg, rgba, labelWeight, nullIfZero(nozzleMin), nullIfZero(nozzleMax),
		nullIfEmpty(normalizeTagUID(tagUID)), nullIfEmpty(normalizeTrayUUID(trayUUID)),
	)
	return err
}

func nullIfZero(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

// parseSlotID parses buildBambuSpools' slot id format ("ams<unit>-<tray>", or
// the literal "external") back into (ams_id, tray_id) — the addressing
// filament_station_assignments uses. "external" maps to ams_id=255/tray_id=254,
// the same convention bambuCommands.js's set_filament handler already uses.
func parseSlotID(slotID string) (amsID, trayID int, ok bool) {
	if slotID == "external" {
		return 255, 254, true
	}
	var unit, tray int
	n, err := fmt.Sscanf(slotID, "ams%d-%d", &unit, &tray)
	if err != nil || n != 2 {
		return 0, 0, false
	}
	return unit, tray, true
}

// ensureAutoAssignment auto-creates (or refreshes) a filament_station_assignments
// row for a known spool sitting in a printer's slot — the same shape a
// manual "Assign spool" (pending_config=true, empty fingerprint) would
// produce. Reuses the existing deferred-replay pipeline unchanged:
// assignments.go's detectBambuAssignmentTriggers sees the tray is already
// loaded on its next pass and sets needs_trigger_at, and the Node replay
// worker (server/app.js) pushes the ams_filament_setting MQTT override —
// exactly as if the operator had assigned it by hand. No-op if this slot is
// already assigned to the same spool (avoids re-triggering every poll cycle).
func ensureAutoAssignment(ctx context.Context, conn *pgx.Conn, printerID, slotID, spoolID string) error {
	amsID, trayID, ok := parseSlotID(slotID)
	if !ok {
		return nil
	}

	var existingSpoolID string
	err := conn.QueryRow(ctx, `
		SELECT spool_id FROM filament_station_assignments
		WHERE printer_id = $1 AND ams_id = $2 AND tray_id = $3`,
		printerID, amsID, trayID,
	).Scan(&existingSpoolID)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if existingSpoolID == spoolID {
		return nil // already assigned here, nothing to do
	}

	_, err = conn.Exec(ctx, `
		INSERT INTO filament_station_assignments (spool_id, printer_id, ams_id, tray_id, pending_config)
		VALUES ($1,$2,$3,$4,TRUE)
		ON CONFLICT (printer_id, ams_id, tray_id) DO UPDATE SET
		  spool_id = EXCLUDED.spool_id,
		  pending_config = TRUE,
		  fingerprint_color = NULL,
		  fingerprint_type = NULL,
		  needs_trigger_at = NULL`,
		spoolID, printerID, amsID, trayID,
	)
	return err
}

// matchOrCreateFilamentSpools scans a Bambu printer's live spool list (as
// built by buildBambuSpools, now carrying trayUuid/tagUid) and catalogs any
// tagged tray that isn't already in filament_spools. No-op for entries
// without a valid tag (untagged trays, and — since Snapmaker's
// buildSpoolsFromTaskConfig never sets trayUuid/tagUid — Snapmaker entries).
//
// A tag already known by tag_uid alone (no genuine decoded tray_uuid — i.e.
// a phone-written OpenSpool tag on a third-party spool, not a genuine Bambu
// tag) additionally gets auto-assigned to its current slot, so the printer
// picks up the right material/color over MQTT without a manual "Assign
// spool" step. NEEDS REAL-HARDWARE CONFIRMATION: this assumes the Bambu
// AMS's own reader reports *some* raw tag_uid for a tag it can't decode as
// Bambu format (an NTAG, not a MIFARE Classic chip) — if the AMS reports
// nothing at all for a non-Bambu tag type, this path simply never fires;
// it can't misfire since genuine Bambu tags (valid tray_uuid) are always
// excluded from it.
func matchOrCreateFilamentSpools(ctx context.Context, conn *pgx.Conn, printerID string, spoolsAny any) error {
	for _, entryAny := range asSlice(spoolsAny) {
		spool := asMap(entryAny)
		if spool == nil {
			continue
		}
		tagUID := mStr(spool, "tagUid")
		trayUUID := mStr(spool, "trayUuid")
		if !isValidTag(tagUID, trayUUID) {
			continue
		}

		existingID, err := findFilamentSpoolByTag(ctx, conn, normalizeTagUID(tagUID), normalizeTrayUUID(trayUUID))
		if err != nil {
			return err
		}

		if existingID == "" {
			if err := createFilamentSpoolFromTray(ctx, conn, spool, tagUID, trayUUID); err != nil {
				return err
			}
			continue
		}

		// Already cataloged. Only auto-assign for a third-party tag match
		// (tag_uid only, no genuine tray_uuid) — never for a genuine Bambu
		// tag, which the printer already displays correctly on its own.
		if !isValidTrayUUID(trayUUID) {
			if err := ensureAutoAssignment(ctx, conn, printerID, mStr(spool, "id"), existingID); err != nil {
				return err
			}
		}
	}
	return nil
}
