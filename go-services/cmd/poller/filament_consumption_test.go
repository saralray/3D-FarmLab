package main

import (
	"reflect"
	"testing"
)

func TestDecodeMqttMapping(t *testing.T) {
	// slot1 -> AMS0 tray0 (0*256+0=0), slot2 -> AMS0 tray2 (0*256+2=2),
	// slot3 -> unmapped (65535), slot4 -> external (254*256+0).
	mapping := []any{float64(0), float64(2), float64(65535), float64(254*256 + 0)}
	got := decodeMqttMapping(mapping)
	want := map[int]string{1: "ams0-0", 2: "ams0-2", 4: "external"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decodeMqttMapping = %v, want %v", got, want)
	}
}

func TestDecodeMqttMapping_AllUnmapped(t *testing.T) {
	if got := decodeMqttMapping([]any{float64(65535), float64(65535)}); got != nil {
		t.Fatalf("expected nil when every entry is unmapped, got %v", got)
	}
}

func TestDecodeMqttMapping_Empty(t *testing.T) {
	if got := decodeMqttMapping(nil); got != nil {
		t.Fatalf("expected nil for empty mapping, got %v", got)
	}
}

func TestMatchSlotsByColor_UnambiguousMatch(t *testing.T) {
	slots := []filamentSlot{
		{SlotID: 1, UsedG: 10, Color: "#FF0000"},
		{SlotID: 2, UsedG: 5, Color: "#00FF00FF"}, // alpha suffix should be stripped
	}
	trayColor := map[string]string{
		"ams0-0": "#ff0000",
		"ams0-1": "#00ff00",
	}
	got := matchSlotsByColor(slots, trayColor)
	want := map[int]string{1: "ams0-0", 2: "ams0-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("matchSlotsByColor = %v, want %v", got, want)
	}
}

func TestMatchSlotsByColor_AmbiguousReturnsNil(t *testing.T) {
	slots := []filamentSlot{{SlotID: 1, UsedG: 10, Color: "#FF0000"}}
	trayColor := map[string]string{
		"ams0-0": "#ff0000",
		"ams0-1": "#ff0000", // two trays share this color — can't disambiguate
	}
	if got := matchSlotsByColor(slots, trayColor); got != nil {
		t.Fatalf("expected nil on ambiguous color match, got %v", got)
	}
}

func TestMatchSlotsByColor_MissingColorReturnsNilForWholeResult(t *testing.T) {
	slots := []filamentSlot{
		{SlotID: 1, UsedG: 10, Color: "#FF0000"},
		{SlotID: 2, UsedG: 5, Color: ""}, // no color at all
	}
	trayColor := map[string]string{"ams0-0": "#ff0000"}
	if got := matchSlotsByColor(slots, trayColor); got != nil {
		t.Fatalf("expected nil (all-or-nothing) when one slot lacks a color, got %v", got)
	}
}

func TestResolveSlotToTray_PrefersMqttMapping(t *testing.T) {
	slots := []filamentSlot{{SlotID: 1, UsedG: 10, Color: "#FF0000"}}
	snap := &baselineState{
		mqttMapping: []any{float64(1)}, // ams0-1
		trayColor:   map[string]string{"ams0-0": "#ff0000"},
		trayType:    map[string]string{"ams0-0": "PLA"},
	}
	got := resolveSlotToTray(slots, snap)
	if got[1] != "ams0-1" {
		t.Fatalf("expected mqtt mapping to win over color match, got %v", got)
	}
}

func TestResolveSlotToTray_PositionBasedSkipsUnloadedSlots(t *testing.T) {
	// Two loaded slots (ams0-0, ams0-2) with an unloaded ams0-1 in between —
	// slicer only sees 2 filaments, so slot 1 -> first loaded, slot 2 ->
	// second loaded, skipping the empty physical slot (#1607-equivalent).
	slots := []filamentSlot{
		{SlotID: 1, UsedG: 10, Color: "#111111"},
		{SlotID: 2, UsedG: 5, Color: "#222222"},
	}
	snap := &baselineState{
		trayType: map[string]string{
			"ams0-0": "PLA",
			"ams0-1": "", // unloaded — must be skipped
			"ams0-2": "PETG",
		},
	}
	got := resolveSlotToTray(slots, snap)
	want := map[int]string{1: "ams0-0", 2: "ams0-2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolveSlotToTray = %v, want %v", got, want)
	}
}

func TestResolveSlotToTray_SingleFilamentUsesActiveTray(t *testing.T) {
	slots := []filamentSlot{{SlotID: 1, UsedG: 10}}
	snap := &baselineState{activeTrayKey: "external"}
	got := resolveSlotToTray(slots, snap)
	if got[1] != "external" {
		t.Fatalf("expected single-filament fallback to active tray, got %v", got)
	}
}

func TestResolveSlotToTray_NilSnapshotOrNoSlots(t *testing.T) {
	if got := resolveSlotToTray(nil, &baselineState{}); got != nil {
		t.Fatalf("expected nil for empty slots, got %v", got)
	}
	if got := resolveSlotToTray([]filamentSlot{{SlotID: 1, UsedG: 1}}, nil); got != nil {
		t.Fatalf("expected nil for nil snapshot, got %v", got)
	}
}
