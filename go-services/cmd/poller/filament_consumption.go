package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// filament_consumption.go resolves a finished Bambu print's 3MF per-slot
// usage (or, failing that, its AMS remain%-delta) back to the inventory
// spools assigned to the trays that fed it, and decrements their
// weight_used. Mirrors Bambuddy's usage_tracker.py: on_print_start captures
// a PrintSession (here: baselineState, bambu.go), on_print_complete resolves
// slots to trays and applies the consumption (here: applyFilamentConsumption,
// called from run.go once a job transition is detected).

// normalizeColorHex lowercases and strips a leading "#", returning the first
// 6 hex chars (dropping any alpha channel) — "" if too short to be a color.
func normalizeColorHex(s string) string {
	s = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "#"))
	if len(s) < 6 {
		return ""
	}
	return s[:6]
}

// decodeMqttMapping decodes the printer's MQTT "mapping" field — an array
// indexed by slicer filament slot (0-based), snow-encoded as
// ams_hw_id*256+local_slot (65535 = unmapped) — into slicer slot_id (1-based)
// -> physical tray key ("ams<n>-<t>" / "external"). Port of Bambuddy's
// _decode_mqtt_mapping (usage_tracker.py:25-63), adapted to this poller's
// tray-key addressing instead of Bambuddy's integer global-tray-id scheme.
func decodeMqttMapping(mapping []any) map[int]string {
	if len(mapping) == 0 {
		return nil
	}
	result := map[int]string{}
	for i, v := range mapping {
		f, ok := asFloat(v)
		if !ok {
			continue
		}
		value := int(f)
		if value >= 65535 {
			continue // unmapped
		}
		amsHwID := value >> 8
		slot := value & 0xFF
		var key string
		switch {
		case amsHwID >= 0 && amsHwID <= 3:
			key = fmt.Sprintf("ams%d-%d", amsHwID, slot&0x03)
		case amsHwID >= 128 && amsHwID <= 135:
			key = fmt.Sprintf("ams%d-0", amsHwID) // AMS-HT: one slot per unit
		case amsHwID == 254 || amsHwID == 255:
			key = "external"
		default:
			continue
		}
		result[i+1] = key
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// matchSlotsByColor matches 3MF filament slots to AMS trays by color when no
// mapping field is available (older Bambu firmwares / A1 family). Port of
// Bambuddy's _match_slots_by_color (usage_tracker.py:120-201): strict and
// all-or-nothing — returns nil unless every slot has a valid color that
// matches exactly one not-yet-claimed tray, since a partial/ambiguous match
// is worse than falling through to the position-based default below.
func matchSlotsByColor(slots []filamentSlot, trayColor map[string]string) map[int]string {
	if len(slots) == 0 || len(trayColor) == 0 {
		return nil
	}
	colorToTrays := map[string][]string{}
	for trayKey, color := range trayColor {
		norm := normalizeColorHex(color)
		if norm == "" {
			continue
		}
		colorToTrays[norm] = append(colorToTrays[norm], trayKey)
	}
	if len(colorToTrays) == 0 {
		return nil
	}

	result := map[int]string{}
	used := map[string]bool{}
	for _, slot := range slots {
		norm := normalizeColorHex(slot.Color)
		if norm == "" {
			return nil
		}
		var available []string
		for _, t := range colorToTrays[norm] {
			if !used[t] {
				available = append(available, t)
			}
		}
		if len(available) != 1 {
			return nil // ambiguous (multiple trays share this color) or no match
		}
		result[slot.SlotID] = available[0]
		used[available[0]] = true
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// resolveSlotToTray maps each 3MF filament slot to a physical tray key,
// combining (in priority order) Bambuddy's mapping-field, color-match, and
// position-based strategies (usage_tracker.py:941-1032), plus the
// single-filament tray_now fallback. Unlike Bambuddy this does not fall back
// further to a raw "slot_id-1" global-id guess when nothing else resolves a
// slot — that fallback assumes an addressing scheme this poller doesn't use,
// so an unresolved slot is simply left out of the result (its usage is then
// picked up, if at all, by the AMS remain%-delta fallback in
// applyFilamentConsumption).
func resolveSlotToTray(slots []filamentSlot, snap *baselineState) map[int]string {
	if snap == nil || len(slots) == 0 {
		return nil
	}

	result := map[int]string{}
	if mapped := decodeMqttMapping(snap.mqttMapping); mapped != nil {
		for k, v := range mapped {
			result[k] = v
		}
	} else if matched := matchSlotsByColor(slots, snap.trayColor); matched != nil {
		for k, v := range matched {
			result[k] = v
		}
	}

	// Position-based default for slots still unresolved: sort loaded trays
	// (non-empty tray_type — an unloaded AMS slot is invisible to the
	// slicer, so slicer slot N is the Nth *loaded* tray, not physical
	// position N) and index directly by slot_id, matching Bambuddy's
	// available_trays[slot_id - 1] (usage_tracker.py:1265-1277).
	var loaded []string
	for key, t := range snap.trayType {
		if t != "" {
			loaded = append(loaded, key)
		}
	}
	sort.Slice(loaded, func(i, j int) bool {
		ai, ti, _ := parseSlotID(loaded[i])
		aj, tj, _ := parseSlotID(loaded[j])
		if ai != aj {
			return ai < aj
		}
		return ti < tj
	})
	for _, slot := range slots {
		if _, ok := result[slot.SlotID]; ok {
			continue
		}
		if slot.SlotID >= 1 && slot.SlotID <= len(loaded) {
			result[slot.SlotID] = loaded[slot.SlotID-1]
		}
	}

	// Single-filament fallback: a lone still-unresolved slot uses the tray
	// active when the print started (tray_now_at_start).
	if len(slots) == 1 && snap.activeTrayKey != "" {
		if _, ok := result[slots[0].SlotID]; !ok {
			result[slots[0].SlotID] = snap.activeTrayKey
		}
	}

	if len(result) == 0 {
		return nil
	}
	return result
}

// applyFilamentConsumption is the print-completion entry point, called from
// run.go once a Bambu printer's currentJob transitions away from
// previousJob. Consumes (pops) the print-start baseline captured in bambu.go
// — a second call for the same printer before another print starts is a
// no-op, matching Bambuddy's on_print_complete popping _active_sessions.
func applyFilamentConsumption(ctx context.Context, conn *pgx.Conn, printerID string, previousJob pmap, outcome string, currentSpools any, slotEstimates map[estimateKey][]filamentSlot) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("filament consumption panic (%s): %v", printerID, r)
			err = nil // never fail the poll cycle over a malformed 3MF/MQTT shape
		}
	}()

	snap := takeBambuPrintBaseline(printerID)
	if snap == nil {
		return nil
	}

	handled := map[string]bool{}
	filename := mStr(previousJob, "filename")

	if slots, ok := slotEstimates[estimateKey{printerID, filename}]; ok && len(slots) > 0 {
		scale := 1.0
		if outcome != "completed" {
			progress := mFloatDef(previousJob, "progress", 0)
			scale = maxF(0, minF(1, progress/100))
		}
		mapping := resolveSlotToTray(slots, snap)
		for _, slot := range slots {
			grams := round1(slot.UsedG * scale)
			if grams <= 0 {
				continue
			}
			trayKey := mapping[slot.SlotID]
			if trayKey == "" {
				continue
			}
			amsID, trayID, ok := parseSlotID(trayKey)
			if !ok {
				continue
			}
			spoolID, lookupErr := findAssignedSpoolID(ctx, conn, printerID, amsID, trayID)
			if lookupErr != nil {
				return lookupErr
			}
			if spoolID == "" {
				continue
			}
			if decErr := decrementSpoolWeight(ctx, conn, spoolID, grams); decErr != nil {
				return decErr
			}
			handled[trayKey] = true
			log.Printf("filament consumption (%s): spool %s +%.1fg via 3mf slot %d (%s)", printerID, spoolID, grams, slot.SlotID, trayKey)
		}
	}

	// AMS remain%-delta fallback for trays the 3MF path didn't cover (no
	// slicer estimate cached, mapping unresolved, etc.) — mirrors Bambuddy's
	// Path 2 (usage_tracker.py:517-682).
	current := spoolGrams(currentSpools)
	for trayKey, startGrams := range snap.grams {
		if handled[trayKey] {
			continue
		}
		nowGrams, ok := current[trayKey]
		if !ok {
			continue
		}
		delta := round1(startGrams - nowGrams)
		if delta <= 0 {
			continue
		}
		amsID, trayID, ok := parseSlotID(trayKey)
		if !ok {
			continue
		}
		spoolID, lookupErr := findAssignedSpoolID(ctx, conn, printerID, amsID, trayID)
		if lookupErr != nil {
			return lookupErr
		}
		if spoolID == "" {
			continue
		}
		if decErr := decrementSpoolWeight(ctx, conn, spoolID, delta); decErr != nil {
			return decErr
		}
		handled[trayKey] = true
		log.Printf("filament consumption (%s): spool %s +%.1fg via AMS delta fallback (%s)", printerID, spoolID, delta, trayKey)
	}

	return nil
}
