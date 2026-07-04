package main

import (
	"context"
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
	uuid := normalizeTrayUUID(trayUUID)
	uidValid := uid != "" && uid != zeroTagUID && uid != strings.Repeat("0", len(uid))
	uuidValid := uuid != "" && uuid != zeroTrayUUID && uuid != strings.Repeat("0", len(uuid))
	return uidValid || uuidValid
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

// matchOrCreateFilamentSpools scans a Bambu printer's live spool list (as
// built by buildBambuSpools, now carrying trayUuid/tagUid) and catalogs any
// tagged tray that isn't already in filament_spools. No-op for entries
// without a valid tag (untagged trays, and — since Snapmaker's
// buildSpoolsFromTaskConfig never sets trayUuid/tagUid — Snapmaker entries).
func matchOrCreateFilamentSpools(ctx context.Context, conn *pgx.Conn, spoolsAny any) error {
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
		if existingID != "" {
			continue // already cataloged
		}
		if err := createFilamentSpoolFromTray(ctx, conn, spool, tagUID, trayUUID); err != nil {
			return err
		}
	}
	return nil
}
