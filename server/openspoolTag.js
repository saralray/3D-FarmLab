// OpenSpool tag payload — the JSON a phone (Android Web NFC / iOS Core NFC)
// writes directly onto an NFC tag as a "mime" NDEF record. This is the format
// a Snapmaker U1 running the community Extended Firmware's "OpenRFID" mode
// reads natively off a physical spool — no MQTT/gcode needed once a tagged
// spool is loaded.
//
// Only the JSON-shaping logic lives here now. Raw NDEF byte-packing (CC/TLV/
// record-header wrapping for writing directly to tag memory pages over SPI)
// isn't needed: Web NFC's NDEFReader.write() and iOS's Core NFC both take
// structured records and handle NDEF framing themselves — the phone's OS/
// browser NFC stack does that job, not this server.

export function buildOpenSpoolPayload(spool) {
  const rgba = (spool.rgba || 'FFFFFFFF').toUpperCase();
  const payload = {
    protocol: 'openspool',
    version: '1.0',
    type: spool.material,
    color_hex: `#${rgba.slice(0, 6)}`,
  };
  if (spool.brand) payload.brand = spool.brand;
  if (spool.nozzleTempMin != null) payload.min_temp = spool.nozzleTempMin;
  if (spool.nozzleTempMax != null) payload.max_temp = spool.nozzleTempMax;
  if (spool.bedTempMin != null) payload.bed_min_temp = spool.bedTempMin;
  if (spool.bedTempMax != null) payload.bed_max_temp = spool.bedTempMax;
  if (spool.subtype) payload.subtype = spool.subtype;
  if (rgba.length >= 8) payload.alpha = rgba.slice(6, 8);
  if (spool.labelWeight) payload.weight = spool.labelWeight;
  if (spool.diameter) payload.diameter = spool.diameter;
  return payload;
}
