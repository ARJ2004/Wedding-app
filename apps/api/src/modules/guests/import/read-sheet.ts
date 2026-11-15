import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { AppError } from '../../../common/errors';

export const MAX_ROWS = 5000;

export interface SheetData {
  sheets: string[];
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return String(v.result ?? ''); // formula: use cached value, never evaluate
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function toRecords(matrix: string[][], headerRow: number) {
  const headerCells = matrix[headerRow - 1] ?? [];
  const headers = headerCells.map((h, i) => (h.trim() ? h.trim() : `Column ${i + 1}`));
  const rows = matrix
    .slice(headerRow)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  if (rows.length > MAX_ROWS) throw new AppError('GST_IMPORT_TOO_MANY_ROWS', `Up to ${MAX_ROWS} rows per import`, 422);
  return { headers, rows };
}

/** Reads xlsx (cached values only, formulas never evaluated) or csv into header-keyed rows. */
export async function readSheet(body: Buffer, contentType: string, opts: { sheetName?: string; headerRow?: number } = {}): Promise<SheetData> {
  const headerRow = opts.headerRow ?? 1;
  if (contentType.includes('spreadsheetml')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(body as unknown as ArrayBuffer);
    } catch {
      throw new AppError('GST_IMPORT_FILE_UNREADABLE', 'Could not read this Excel file', 422);
    }
    const sheets = wb.worksheets.map((w) => w.name);
    const ws = (opts.sheetName && wb.getWorksheet(opts.sheetName)) || wb.worksheets[0];
    if (!ws) throw new AppError('GST_IMPORT_FILE_UNREADABLE', 'The file has no sheets', 422);
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const values = row.values as ExcelJS.CellValue[];
      matrix[n - 1] = values.slice(1).map(cellText);
    });
    for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
    return { sheets, sheetName: ws.name, ...toRecords(matrix, headerRow) };
  }
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  return { sheets: ['CSV'], sheetName: 'CSV', ...toRecords(parsed.data.map((r) => r.map(String)), headerRow) };
}
