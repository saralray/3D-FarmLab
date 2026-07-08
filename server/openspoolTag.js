// OpenSpool tag payload — the JSON a phone (Android Web NFC / iOS Core NFC)
// writes directly onto an NFC tag as a "mime" NDEF record. This is the format
// a Snapmaker U1 running the community Extended Firmware's "OpenRFID" mode
// reads natively off a physical spool — no MQTT/gcode needed once a tagged
// spool is loaded.
//
// Kept minimal on purpose: protocol/version/type/color_hex are all the
// firmware needs to identify and auto-switch the loaded filament. Every
// other spool detail (brand, temps, subtype, weight, diameter) already lives
// server-side in filament_spools, keyed by the tag's own hardware UID (see
// findFilamentSpoolByTag / handleNfc in filamentStation.js) — it never needs
// to round-trip through the tag itself. The fuller payload used to be
// written here too, but that easily exceeds an NTAG213's ~144-byte usable
// capacity (fine on NTAG215/216) and produced write "io error"s once a spool
// had more than a couple of optional fields set.
//
// Only the JSON-shaping logic lives here now. Raw NDEF byte-packing (CC/TLV/
// record-header wrapping for writing directly to tag memory pages over SPI)
// isn't needed: Web NFC's NDEFReader.write() and iOS's Core NFC both take
// structured records and handle NDEF framing themselves — the phone's OS/
// browser NFC stack does that job, not this server.

export function buildOpenSpoolPayload(spool) {
  const rgba = (spool.rgba || 'FFFFFFFF').toUpperCase();
  return {
    protocol: 'openspool',
    version: '1.0',
    type: spool.material,
    color_hex: `#${rgba.slice(0, 6)}`,
  };
}
