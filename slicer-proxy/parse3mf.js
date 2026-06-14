// Minimal, dependency-free reader for a single named entry out of a ZIP / 3MF.
//
// A .3mf is a standard ZIP archive; we only need Metadata/slice_info.config (a
// few KB), so we avoid pulling in a zip dependency — the slicer-proxy image
// installs a deliberately small, pinned dep set (see Dockerfile.slicer-proxy).
// Handles stored (method 0) and deflate (method 8) entries; no zip64 / encryption,
// which is fine for the tiny slice_info entry Orca / Bambu Studio write.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDIR_SIG = 0x02014b50; // Central directory file header
const LFH_SIG = 0x04034b50; // Local file header

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
