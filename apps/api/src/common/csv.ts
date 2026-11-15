/**
 * One CSV cell, safe to open in Excel/Sheets. Cells starting with = + - @ tab or CR can run as
 * formulas (CSV injection), so they get a leading apostrophe — except plain numbers and phone
 * numbers like "+919845012345", which must stay intact.
 */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const isNumber = /^[+-]?\d[\d\s]*(\.\d+)?$/.test(s);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');
