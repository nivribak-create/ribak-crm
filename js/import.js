// Reading a contact list the user already has — a spreadsheet exported from
// WhatsApp, a CSV, or text copied out of Excel. Everything happens in the
// browser: the file is never uploaded anywhere, and only the rows the user
// keeps are written to their own database.

const DIGITS = /\d/g;

// ---- xlsx --------------------------------------------------------------
// A .xlsx is a zip. Browsers can inflate raw deflate natively, so the whole
// reader is a few dozen lines with no library.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('unsupported_browser');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // end-of-central-directory, scanned backwards past any comment
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_a_zip');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // the local header repeats the name and carries its own extra field
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    files[name] = { method, data: bytes.subarray(start, start + compressedSize) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    async text(name) {
      const f = files[name];
      if (!f) return null;
      const raw = f.method === 0 ? f.data : await inflateRaw(f.data);
      return new TextDecoder().decode(raw);
    },
    has: name => Boolean(files[name]),
    names: Object.keys(files),
  };
}

function xmlDoc(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

async function rowsFromXlsx(buffer) {
  const zip = await readZip(buffer);
  const sheetName = zip.names.find(n => /^xl\/worksheets\/sheet1\.xml$/.test(n))
    || zip.names.find(n => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) throw new Error('no_sheet');

  const shared = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const doc = xmlDoc(await zip.text('xl/sharedStrings.xml'));
    for (const si of doc.getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    }
  }
  const doc = xmlDoc(await zip.text(sheetName));
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const type = c.getAttribute('t');
      let value = '';
      if (type === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map(t => t.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        value = v ? v.textContent : '';
        if (type === 's') value = shared[Number(value)] ?? '';
      }
      cells.push(String(value).trim());
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

// ---- delimited text ----------------------------------------------------
function rowsFromText(text) {
  return text.split(/\r?\n/)
    .map(line => line.split(/\t|,|;/).map(c => c.trim().replace(/^"|"$/g, '')))
    .filter(cells => cells.some(Boolean));
}

// ---- rows → leads ------------------------------------------------------
export function normalizePhone(raw) {
  let d = String(raw || '').match(DIGITS)?.join('') || '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('972')) d = '0' + d.slice(3);
  else if (d.length === 9 && d.startsWith('5')) d = '0' + d;
  return /^0\d{8,9}$/.test(d) ? d : null;
}

const HEADER_WORDS = /טלפון|נייד|שם|phone|name|mobile|number/i;

export function rowsToLeads(rows) {
  const leads = [];
  const seen = new Set();
  let skipped = 0;
  for (const cells of rows) {
    const phoneCell = cells.find(c => normalizePhone(c));
    const phone = phoneCell ? normalizePhone(phoneCell) : null;
    if (!phone) {
      if (!cells.some(c => HEADER_WORDS.test(c))) skipped++;
      continue;
    }
    // the longest remaining cell that isn't mostly digits reads as the name
    const name = cells
      .filter(c => c !== phoneCell && c && (c.match(DIGITS)?.length || 0) < c.length / 2)
      .sort((a, b) => b.length - a.length)[0] || '';
    if (seen.has(phone)) { skipped++; continue; }
    seen.add(phone);
    leads.push({ phone, name: name.trim() });
  }
  return { leads, skipped };
}

export async function readFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return rowsToLeads(await rowsFromXlsx(await file.arrayBuffer()));
  }
  if (name.endsWith('.xls')) throw new Error('old_xls');
  return rowsToLeads(rowsFromText(await file.text()));
}

export const readText = text => rowsToLeads(rowsFromText(text));
