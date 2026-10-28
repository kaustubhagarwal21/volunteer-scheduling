type Cell = string | number | null;

// A cell starting with one of these is treated as a formula by Excel / Google Sheets.
// A volunteer could otherwise register with a name like =HYPERLINK(...) ("CSV injection").
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field per RFC 4180, with text that looks like a formula neutralised. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header plus rows, CRLF line endings as RFC 4180 specifies. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
