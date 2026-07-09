package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"strconv"
)

// filamentSlot is one <filament> element from a 3MF's Metadata/slice_info.config
// — the slicer's own per-filament-slot usage estimate, distinct from the
// plate-level <metadata key="weight"> totals parse3mfFilamentGrams (bambuftp.go)
// sums. Mirrors Bambuddy's extract_filament_usage_from_3mf
// (backend/app/utils/threemf_tools.py:409-484).
type filamentSlot struct {
	SlotID int
	UsedG  float64
	Type   string
	Color  string
}

// sliceInfoFilamentXML is one <filament id=".." used_g=".." type=".." color="..">
// element, found nested under each <plate> in slice_info.config.
type sliceInfoFilamentXML struct {
	ID    string `xml:"id,attr"`
	UsedG string `xml:"used_g,attr"`
	Type  string `xml:"type,attr"`
	Color string `xml:"color,attr"`
}

type sliceInfoPlateXML struct {
	Filaments []sliceInfoFilamentXML `xml:"filament"`
}

type sliceInfoConfigXML struct {
	Plates []sliceInfoPlateXML `xml:"plate"`
}

// parse3mfFilamentSlots extracts per-filament-slot usage from a 3MF's
// Metadata/slice_info.config. Returns (slots, true) when at least one
// filament element with a positive used_g was found, else (nil, false).
//
// Sums across every plate in the file (matching Bambuddy's plate_id=None
// path) — the Go poller doesn't currently track which plate of a multi-plate
// 3MF a job actually printed, so per-plate scoping isn't attempted.
func parse3mfFilamentSlots(buf []byte) ([]filamentSlot, bool) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return nil, false
	}

	var data []byte
	for _, f := range zr.File {
		if f.Name == "Metadata/slice_info.config" {
			rc, err := f.Open()
			if err != nil {
				return nil, false
			}
			data, err = io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return nil, false
			}
			break
		}
	}
	if data == nil {
		return nil, false
	}

	var cfg sliceInfoConfigXML
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return nil, false
	}

	var slots []filamentSlot
	for _, plate := range cfg.Plates {
		for _, f := range plate.Filaments {
			slotID, err := strconv.Atoi(f.ID)
			if err != nil || slotID <= 0 {
				continue
			}
			usedG, err := strconv.ParseFloat(f.UsedG, 64)
			if err != nil || usedG <= 0 {
				continue
			}
			slots = append(slots, filamentSlot{
				SlotID: slotID,
				UsedG:  round1(usedG),
				Type:   f.Type,
				Color:  f.Color,
			})
		}
	}
	if len(slots) == 0 {
		return nil, false
	}
	return slots, true
}
