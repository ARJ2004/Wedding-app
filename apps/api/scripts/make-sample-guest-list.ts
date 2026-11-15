import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

/**
 * Writes docs/samples/guest-list-sample.xlsx: a realistically messy family guest sheet
 * (Hinglish headers, mixed phone formats, a members column, a bad number, a duplicate) for
 * trying the import (GST-02) in the app or the preview. All names and numbers are fictional.
 */
async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guest List');
  ws.addRow(['S.No', 'Naam', 'Mobile No.', 'Members', 'Ladke wale / Ladki wale', 'City', 'Outstation']);
  const rows: (string | number)[][] = [
    [1, 'Suresh Kulkarni', '098860 11223', 'Meena & 2 kids', 'Ladki wale', 'Pune', 'Yes'],
    [2, 'Lakshmi Iyer', '+91 99000 22334', 'Raghav', 'Ladki wale', 'Chennai', 'Yes'],
    [3, 'Farhan Shaikh', '9820033445', '', 'Ladke wale', 'Mumbai', 'Yes'],
    [4, 'Bindu Mausi', '12345', 'Mohan', 'Ladki wale', 'Hubli', 'Yes'],
    [5, 'Arjun Mehta', '+1 (415) 555 0199', 'Kavya', 'Ladke wale', 'San Francisco', 'Yes'],
    [6, 'Pooja Hegde', '98450 44556', '', 'Ladke wale', 'Bengaluru', 'No'],
    [7, 'Suresh K.', '9886011223', '', 'Ladki wale', 'Pune', 'Yes'],
    [8, '', '98450 77889', '', 'Ladke wale', 'Mysuru', 'No'],
    [9, 'Nanaji', '', 'Naniji', 'Ladki wale', 'Jaipur', 'Yes'],
  ];
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => (c.width = 22));
  const out = join(__dirname, '../../../docs/samples');
  mkdirSync(out, { recursive: true });
  await wb.xlsx.writeFile(join(out, 'guest-list-sample.xlsx'));
  process.stdout.write(`wrote ${join(out, 'guest-list-sample.xlsx')}\n`);
}

void main();
