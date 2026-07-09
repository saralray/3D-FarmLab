package main

import (
	"archive/zip"
	"bytes"
	"testing"
)

// build3mf packs a single Metadata/slice_info.config entry into an in-memory
// zip, mimicking the (small) part of a real 3MF parse3mfFilamentSlots reads.
func build3mf(t *testing.T, sliceInfoXML string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("Metadata/slice_info.config")
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, err := w.Write([]byte(sliceInfoXML)); err != nil {
		t.Fatalf("write zip entry: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func TestParse3mfFilamentSlots_MultiplePlatesAndFilaments(t *testing.T) {
	xmlDoc := `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header/>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="weight" value="15.5"/>
    <filament id="1" type="PLA" color="#FF0000" used_m="4.2" used_g="12.5"/>
    <filament id="2" type="PETG" color="#00FF00FF" used_m="1.0" used_g="3.0"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <filament id="1" type="PLA" color="#FF0000" used_m="0.5" used_g="1.5"/>
  </plate>
</config>`

	slots, ok := parse3mfFilamentSlots(build3mf(t, xmlDoc))
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if len(slots) != 3 {
		t.Fatalf("expected 3 filament entries summed across plates, got %d: %+v", len(slots), slots)
	}

	var total float64
	for _, s := range slots {
		total += s.UsedG
	}
	if total != 17.0 {
		t.Fatalf("expected total used_g=17.0, got %.2f", total)
	}
}

func TestParse3mfFilamentSlots_MissingOrZeroUsedGSkipped(t *testing.T) {
	xmlDoc := `<config>
  <plate>
    <filament id="1" type="PLA" color="#FF0000" used_g="0"/>
    <filament id="2" type="PLA" color="#00FF00"/>
    <filament id="3" type="PLA" color="#0000FF" used_g="5.0"/>
  </plate>
</config>`

	slots, ok := parse3mfFilamentSlots(build3mf(t, xmlDoc))
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if len(slots) != 1 || slots[0].SlotID != 3 {
		t.Fatalf("expected only slot 3 to survive (used_g=0/missing skipped), got %+v", slots)
	}
}

func TestParse3mfFilamentSlots_NoSliceInfoConfig(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if _, err := zw.Create("Metadata/other.config"); err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}

	slots, ok := parse3mfFilamentSlots(buf.Bytes())
	if ok || slots != nil {
		t.Fatalf("expected ok=false, nil slots when slice_info.config is absent, got %v, %+v", ok, slots)
	}
}

func TestParse3mfFilamentSlots_NotAZip(t *testing.T) {
	slots, ok := parse3mfFilamentSlots([]byte("not a zip file"))
	if ok || slots != nil {
		t.Fatalf("expected ok=false, nil slots for garbage input, got %v, %+v", ok, slots)
	}
}
