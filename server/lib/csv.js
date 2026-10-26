// A small hand-rolled RFC4180 CSV reader/writer — no csv-parsing dependency, same reasoning as
// vendoring the barcode library instead of pulling one in from a CDN: this app needs to keep
// working fully offline on a standalone install. Parsing/writing CSV correctly (quoted fields,
// embedded commas/quotes/newlines) is a small, well-bounded amount of code to own directly.

// Splits CSV text into rows of raw string cells. Treats the first row as a header elsewhere
// (parseCsvObjects below) — this function itself knows nothing about headers.
function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  // Normalize line endings up front so the state machine below only ever has to think about \n.
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else {
      cell += c;
    }
  }
  // Last cell/row, unless the file ended cleanly on its own trailing newline (in which case
  // there's nothing left to flush — an empty final row would otherwise show up as a phantom
  // blank line).
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Rows → array of { header: value } objects, keyed by the first row. A short row (fewer cells
// than headers) just leaves the missing keys undefined; an empty line anywhere is skipped
// rather than producing an all-undefined object.
function parseCsvObjects(text) {
  const rows = parseCsvRows(text).filter((r) => !(r.length === 1 && r[0] === ''));
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i]; });
    return obj;
  });
}

function escapeCsvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// array of objects + an explicit column order → CSV text (CRLF line endings, per RFC4180).
function toCsv(rows, columns) {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCsvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsvRows, parseCsvObjects, toCsv };
