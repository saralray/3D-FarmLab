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
// spot" for the U1, with NTAG216 (888 bytes) also supported — NTAG213
// (~144 bytes) is not what's recommended, so the full field set here isn't a
// capacity risk on the tags this firmware actually expects. A prior version
// of this function trimmed down to protocol/version/type/color_hex to fit
// NTAG213; that traded away brand/subtype/temps for no documented benefit.
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

export function buildOpenSpoolPayload(spool) {
  const rgba = (spool.rgba || 'FFFFFFFF').toUpperCase();
  const payload = {
    protocol: 'openspool',
    version: '1.0',
    type: spool.material,
    color_hex: `#${rgba.slice(0, 6)}`,
  };
  if (spool.brand) payload.brand = spool.brand;
  if (spool.subtype) payload.subtype = spool.subtype;
  if (spool.nozzleTempMin != null) payload.min_temp = spool.nozzleTempMin;
  if (spool.nozzleTempMax != null) payload.max_temp = spool.nozzleTempMax;
  if (spool.bedTempMin != null) payload.bed_min_temp = spool.bedTempMin;
  if (spool.bedTempMax != null) payload.bed_max_temp = spool.bedTempMax;
  if (spool.diameter != null) payload.diameter = spool.diameter;
  if (spool.labelWeight) payload.weight = spool.labelWeight;
  return payload;
}
