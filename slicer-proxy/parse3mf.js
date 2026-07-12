// Minimal, dependency-free reader for a single named entry out of a ZIP / 3MF.
//
// A .3mf is a standard ZIP archive; we only need Metadata/slice_info.config (a
// few KB), so we avoid pulling in a zip dependency — the slicer-proxy image
// installs a deliberately small, pinned dep set (see Dockerfile.slicer-proxy).
// Handles stored (method 0) and deflate (method 8) entries; no zip64 / encryption,
// which is fine for the tiny slice_info entry Orca / Bambu Studio write.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDIR_SIG = 0x02014b50; // Central directory file header
const LFH_SIG = 0x04034b50; // Local file header

// Standard CRC32 (ISO 3309 / zip), table-based. Node's zlib doesn't expose a
// public crc32() until v22; the container here runs v20, so it's hand-rolled
// rather than adding a dependency (matches this file's own stated policy).
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Locate a central-directory entry by exact name. Compressed size and the local
// header offset come from the central directory (authoritative even when the
// local header defers sizes to a data descriptor).
function findEntryInZip(buf, wantName) {
  const minEocd = 22;
  if (buf.length < minEocd) return null;
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - (minEocd + 0xffff));
  for (let i = buf.length - minEocd; i >= scanStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  let p = cdOffset;
  for (let n = 0; n < cdCount; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDIR_SIG) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wantName) return { method, compSize, lfhOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function readEntryData(buf, entry) {
  const { method, compSize, lfhOffset } = entry;
  if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) return null;
  // The local header's own name/extra lengths give the data start — they may
  // differ from the central directory's extra length.
  const nameLen = buf.readUInt16LE(lfhOffset + 26);
  const extraLen = buf.readUInt16LE(lfhOffset + 28);
  const dataStart = lfhOffset + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return comp; // stored
  if (method === 8) return inflateRawSync(comp); // deflate
  return null; // unsupported compression method
}

// Return the decompressed bytes of `name` from the zip in `buf`, or null.
export function readZipEntry(buf, name) {
  try {
    const entry = findEntryInZip(buf, name);
    if (!entry) return null;
    return readEntryData(buf, entry);
  } catch {
    return null;
  }
}

// Extract the sliced plate G-code out of an Orca/Bambu .gcode.3mf bundle. Klipper/
// Moonraker printers need plain G-code, but the slicer uploads the .3mf container
// (Metadata/plate_<n>.gcode inside). Returns { name, data } of the first plate, or
// null when the buffer is not a bundle / has no plate G-code.
export function extractPlateGcodeFrom3mf(buf) {
  try {
    const minEocd = 22;
    if (buf.length < minEocd) return null;
    let eocd = -1;
    const scanStart = Math.max(0, buf.length - (minEocd + 0xffff));
    for (let i = buf.length - minEocd; i >= scanStart; i -= 1) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    const cdCount = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const gcodeRe = /^Metadata\/plate_\d+\.gcode$/;

    let p = cdOffset;
    for (let n = 0; n < cdCount; n += 1) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDIR_SIG) return null;
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (gcodeRe.test(name)) {
        const data = readZipEntry(buf, name);
        if (data) return { name, data };
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  }
}

// Sum the plate-level filament weight (grams) from a Bambu / Orca 3MF's
// Metadata/slice_info.config. Each <plate> carries
// <metadata key="weight" value="<grams>"/>; summing across plates yields the
// whole job's filament weight (mirrors bambuddy archive.py's file-level total).
// Returns grams (> 0, one decimal) or null when there's no usable estimate.
export function extractFilamentGramsFrom3mf(buf) {
  const data = readZipEntry(buf, 'Metadata/slice_info.config');
  if (!data) return null;
  const xml = data.toString('utf8');
  let total = 0;
  let seen = false;
  const re = /key="weight"\s+value="([0-9]*\.?[0-9]+)"/gi;
  let match = re.exec(xml);
  while (match !== null) {
    const grams = Number.parseFloat(match[1]);
    if (Number.isFinite(grams) && grams > 0) {
      total += grams;
      seen = true;
    }
    match = re.exec(xml);
  }
  return seen ? Math.round(total * 10) / 10 : null;
}

// List the filaments a sliced Bambu/Orca 3MF actually uses, from
// Metadata/slice_info.config's per-plate <filament id=".." type=".." color=".."/>
// entries. Only used filaments appear there — a four-filament project sliced
// with one filament carries a single entry whose id is that filament's 1-based
// global number (so the id doubles as the ams_mapping slot index + 1). Returns
// [{ id, type, color }] sorted by id, deduped across plates; [] when the file
// has no slice info.
export function extractFilamentsFrom3mf(buf) {
  const data = readZipEntry(buf, 'Metadata/slice_info.config');
  if (!data) return [];
  const xml = data.toString('utf8');
  const filaments = new Map();
  const re = /<filament\s+([^>]*?)\/?>/gi;
  let match = re.exec(xml);
  while (match !== null) {
    const attrs = match[1];
    const id = Number.parseInt(/(?:^|\s)id="(\d+)"/.exec(attrs)?.[1] ?? '', 10);
    const type = (/(?:^|\s)type="([^"]*)"/.exec(attrs)?.[1] ?? '').trim();
    const color = (/(?:^|\s)color="([^"]*)"/.exec(attrs)?.[1] ?? '').trim();
    if (Number.isInteger(id) && id > 0 && type && !filaments.has(id)) {
      filaments.set(id, { id, type, color });
    }
    match = re.exec(xml);
  }
  return [...filaments.values()].sort((a, b) => a.id - b.id);
}

// List every central-directory entry (name, method, sizes, crc32, local
// header offset, and its DOS mod time/date so a rewritten entry can keep
// them). Needed to rebuild the archive when patching one entry's content.
function listZipEntries(buf) {
  const minEocd = 22;
  if (buf.length < minEocd) return [];
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - (minEocd + 0xffff));
  for (let i = buf.length - minEocd; i >= scanStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];

  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < cdCount; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, modTime, modDate, crc, compSize, uncompSize, lfhOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The compressed data bytes for one entry (excluding its local header/name/
// extra), read using the central directory's authoritative compSize. Some
// zip writers defer sizes to a trailing data descriptor after the data
// (general-purpose flag bit 3) rather than filling them into the local
// header; extracting only the data itself and always regenerating a fresh,
// self-consistent local header (see below) sidesteps that entirely rather
// than needing to detect and skip a descriptor that may or may not follow.
function extractEntryData(buf, entry) {
  const { lfhOffset, compSize } = entry;
  if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(lfhOffset + 26);
  const extraLen = buf.readUInt16LE(lfhOffset + 28);
  const dataStart = lfhOffset + 30 + nameLen + extraLen;
  if (dataStart + compSize > buf.length) return null;
  return buf.subarray(dataStart, dataStart + compSize);
}

// Rebuild a zip/3mf with one or more named entries replaced (stored
// uncompressed — simplest to get right, and the size difference vs. deflate
// is negligible for a farm print pushed over the LAN). `replacements` is a
// Map<entryName, Buffer>. Every entry's local header is freshly generated
// from the central directory's data (flag 0, no data descriptor) rather than
// copied from the original — copying a local header verbatim while only
// extracting `compSize` bytes of data silently produces a corrupt archive
// whenever the original entry actually used a trailing data descriptor
// (confirmed: unzip reported "overlapped components" on the first version of
// this function that copied raw local headers unchanged). Every other
// entry's *data* is still copied unchanged; only replaced entries' content
// and every entry's header bytes change. Returns null if any replacement
// name isn't found or the archive can't be parsed, so the caller can fall
// back to the original buffer.
function rewriteZipEntries(buf, replacements) {
  const entries = listZipEntries(buf);
  if (entries.length === 0) return null;
  for (const name of replacements.keys()) {
    if (!entries.some((e) => e.name === name)) return null;
  }

  const localParts = [];
  const localOffsets = [];
  let offset = 0;

  for (const entry of entries) {
    localOffsets.push(offset);
    const replacement = replacements.get(entry.name);
    const isTarget = replacement !== undefined;
    const data = isTarget ? replacement : extractEntryData(buf, entry);
    if (!data) return null;
    const method = isTarget ? 0 : entry.method;
    const crc = isTarget ? crc32(data) : entry.crc;
    const size = data.length;

    const nameBuf = Buffer.from(entry.name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed to extract
    lfh.writeUInt16LE(0, 6); // general purpose flag — no data descriptor
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(entry.modTime, 10);
    lfh.writeUInt16LE(entry.modDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18); // compressed size (== uncompressed for stored target entry)
    lfh.writeUInt32LE(isTarget ? size : entry.uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    localParts.push(lfh, nameBuf, data);
    offset += lfh.length + nameBuf.length + data.length;

    entry.rewritten = { method, crc, size, uncompSize: isTarget ? size : entry.uncompSize };
  }

  const cdStart = offset;
  const cdParts = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.rewritten?.method ?? entry.method;
    const crc = entry.rewritten?.crc ?? entry.crc;
    const size = entry.rewritten?.size ?? entry.compSize;
    const uncompSize = entry.rewritten?.uncompSize ?? entry.uncompSize;
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDIR_SIG, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed to extract
    cdh.writeUInt16LE(0, 8); // general purpose flag
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(entry.modTime, 12);
    cdh.writeUInt16LE(entry.modDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(localOffsets[i], 42);
    cdParts.push(cdh, nameBuf);
  }
  const cdBuf = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

// Comment out the "M972 S31 ... Toolhead camera detection" line Orca/Bambu
// Studio's H2-series machine profile bakes into every sliced file's start
// gcode. Confirmed live on a farm H2S unit: this specific hardware check
// fails every time a print is pushed through this server (over both the FTP
// and HTTP delivery paths), pausing the job at 0% with a camera-fault HMS
// code -- yet the identical line in a normal LAN-mode BambuStudio print (same
// physical printer, same check) succeeded. The check is baked into the gcode
// itself, not controllable via any project_file/MQTT field, so the only way
// to skip it is editing the file we're about to serve. This trades away a
// real hardware safety check for that unit; do this deliberately, not as a
// blanket default assumption that the check is unimportant.
//
// The plate gcode has a sibling Metadata/plate_<n>.gcode.md5 entry — a plain
// uppercase-hex MD5 of the gcode's exact bytes (confirmed live) that the
// firmware checks before accepting the file. Patching the gcode without
// updating this sidecar produces "content of print file is unreadable" —
// the exact same-looking failure as the original bug, but now a checksum
// mismatch rather than the camera check. Both entries are rewritten together
// in one archive rebuild.
// Returns the patched buffer, or the original unchanged if there's no plate
// gcode entry, the line isn't present (already patched / not an H2 profile
// slice), or the archive can't be safely rewritten.
export function patchBambuToolheadCameraDetection(buf) {
  const plate = extractPlateGcodeFrom3mf(buf);
  if (!plate) return buf;

  const text = plate.data.toString('utf8');
  const patternRe = /^([ \t]*)(M972\s+S31\b[^\n]*)$/m;
  if (!patternRe.test(text)) return buf;

  const patchedText = text.replace(patternRe, '$1;$2');
  const patchedGcode = Buffer.from(patchedText, 'utf8');
  const replacements = new Map([[plate.name, patchedGcode]]);

  const md5Name = `${plate.name}.md5`;
  if (readZipEntry(buf, md5Name)) {
    const digest = createHash('md5').update(patchedGcode).digest('hex').toUpperCase();
    replacements.set(md5Name, Buffer.from(digest, 'utf8'));
  }

  const patched = rewriteZipEntries(buf, replacements);
  return patched ?? buf;
}
