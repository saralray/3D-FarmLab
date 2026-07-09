// OpenSpool tag payload — the JSON a phone (Android Web NFC / iOS Core NFC)
// writes directly onto an NFC tag as a "mime" NDEF record. This is the format
// a Snapmaker U1 running the community Extended Firmware's "OpenRFID" mode
// (github.com/paxx12/SnapmakerU1-Extended-Firmware, itself built on
// github.com/suchmememanyskill/OpenRFID) reads natively off a physical spool
// — no MQTT/gcode needed once a tagged spool is loaded.
//
// Field set and names follow that firmware's documented OpenSpool schema
// (docs/rfid_support.md) exactly: protocol/version/type/color_hex are
// required, everything else below is optional and included only when the
// spool record has it set. brand + subtype matter beyond labeling — Snapmaker
// Orca only recognizes a filament under the `<brand> <type> <subtype>` naming
// convention, and OpenRFID mode hides spools it can't match to a known brand
// (there's a firmware-side "force generic vendor" variant that skips that
// check, but this payload shouldn't rely on the operator having picked it).
//
// The firmware's own docs recommend NTAG215 (540 bytes usable) as "the sweet
// spot" for the U1, with NTAG216 (888 bytes) also supported. Temperature
// (min/max nozzle, min/max bed) and diameter are intentionally left off this
// payload to keep it minimal — Orca/Bambu Studio already source those from
// the material profile the operator picks, so writing them to the tag is
// redundant; brand/subtype/weight/alpha stay since Orca's filament-matching
// depends on them.
//
// Only the JSON-shaping logic lives here now. Raw NDEF byte-packing (CC/TLV/
// record-header wrapping for writing directly to tag memory pages over SPI)
// isn't needed: Web NFC's NDEFReader.write() and iOS's Core NFC both take
// structured records and handle NDEF framing themselves — the phone's OS/
// browser NFC stack does that job, not this server.
//
// Genuine Bambu Lab tags are a separate system entirely (Mifare Classic 1K,
// proprietary encryption) — out of scope here. Note the same OpenRFID
// firmware can *read* those natively too (a `bambu_lab_tag_processor` key
// configured in openrfid_user.cfg), but writing one isn't something this
// payload (or Web NFC / Core NFC, which are NDEF-only) can produce.
//
// `alpha` comes free from the spool's own rgba (its last byte) rather than
// a separate field. `additional_color_hexes` (multicolor spools) is the one
// documented optional field left out — filament_spools only stores a single
// rgba, so there's no source data for it without a schema change.
//
// `brand` carries the spool's FarmLab-generated `serial` (FL-0001, ...), not
// its real manufacturer brand: OpenSpool has no dedicated "unique ID" field,
// and three identical yellow-PLA spools would otherwise write byte-identical
// tags. `brand` is the one documented field free-form enough to abuse this
// way, at the cost of the manufacturer name no longer reaching the tag (it's
// still tracked in FarmLab's own `filament_spools.brand` column). Because the
// tag's brand text won't match a recognized vendor, the printer's OpenRFID
// mode should be set to "force generic vendor" so Orca doesn't hide the
// spool — plain OpenRFID mode hides spools it can't match to a known brand.

export function buildOpenSpoolPayload(spool) {
  const rgba = (spool.rgba || 'FFFFFFFF').toUpperCase();
  const payload = {
    protocol: 'openspool',
    version: '1.0',
    type: spool.material,
    color_hex: `#${rgba.slice(0, 6)}`,
  };
  if (spool.serial) payload.brand = spool.serial;
  else if (spool.brand) payload.brand = spool.brand;
  if (spool.subtype) payload.subtype = spool.subtype;
  if (spool.labelWeight) payload.weight = spool.labelWeight;
  if (rgba.length >= 8) payload.alpha = rgba.slice(6, 8);
  return payload;
}
