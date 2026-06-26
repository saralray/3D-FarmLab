// Minimal XLSX file generator — no external dependencies.
// Produces a valid .xlsx (OOXML SpreadsheetML inside a ZIP archive) using the
// "stored" (uncompressed) ZIP compression method so no deflate library is needed.

import type { PrintJob } from '../types';

// ── ZIP utilities ─────────────────────────────────────────────────────────────

function u16(n: number): Uint8Array {
  n = n >>> 0;
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  n = n >>> 0;
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// CRC-32 (IEEE 802.3 polynomial) — required by ZIP
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ENC = new TextEncoder();

interface ZipFile { name: string; data: Uint8Array; }

function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = ENC.encode(file.name);
    const crc = crc32(file.data);
    const len = file.data.length;
    const now = new Date();
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) >>> 0;
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) >>> 0;

    const local = concat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(len), u32(len),
      u16(nameBytes.length), u16(0),
      nameBytes,
      file.data,
    );

    const central = concat(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(len), u32(len),
      u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    );

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = concat(...centrals);
  const eocd = concat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  );

  return concat(...locals, centralDir, eocd);
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colLetter(c: number): string {
  return String.fromCharCode(65 + c);
}

function buildSheetXml(rows: string[][]): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>';

  for (let r = 0; r < rows.length; r++) {
    xml += `<row r="${r + 1}">`;
    for (let c = 0; c < rows[r].length; c++) {
      const ref = `${colLetter(c)}${r + 1}`;
      xml += `<c r="${ref}" t="inlineStr"><is><t>${esc(rows[r][c] ?? '')}</t></is></c>`;
    }
    xml += '</row>';
  }

  xml += '</sheetData></worksheet>';
  return xml;
}

// ── Queue-specific serialization ──────────────────────────────────────────────

const HEADERS = ['Status', 'Name', 'Email', 'File', 'Qty', 'Priority', 'Notes', 'Submitted At'];

function jobToRow(job: PrintJob, section: 'Pending' | 'Printed'): string[] {
  return [
    section,
    job.submitterName ?? '',
    job.submitterEmail ?? '',
    job.filename ?? '',
    String(job.fileCount ?? 1),
    job.priority,
    job.notes ?? '',
    job.submittedAt ? new Date(job.submittedAt).toLocaleString() : '',
  ];
}

// Minimal styles.xml — required by OOXML spec for Excel compatibility
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '</styleSheet>';

// ── Public API ────────────────────────────────────────────────────────────────

export function exportQueueToXlsx(
  queue: PrintJob[],
  history: PrintJob[],
  filename = 'print-queue.xlsx',
) {
  const xml = (s: string) => ENC.encode(s);

  // Single sheet: pending queue first, then printed history — Status column
  // tells them apart. One sheet is simpler and avoids tab-navigation confusion.
  const rows = [
    HEADERS,
    ...queue.map((j) => jobToRow(j, 'Pending')),
    ...history.map((j) => jobToRow(j, 'Printed')),
  ];

  const files: ZipFile[] = [
    {
      name: '[Content_Types].xml',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        '<sheet name="Print Queue" sheetId="1" r:id="rId1"/>' +
        '</sheets>' +
        '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(buildSheetXml(rows)),
    },
    {
      name: 'xl/styles.xml',
      data: xml(STYLES_XML),
    },
  ];

  const blob = new Blob([buildZip(files)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
