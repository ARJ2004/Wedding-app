import { pick, types } from '@react-native-documents/picker';

export interface PickedFile {
  name: string;
  type: string;
  size: number;
  body: Blob;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Spreadsheet picker (Files / Drive / WhatsApp downloads). Returns null when cancelled. */
export async function pickSpreadsheet(): Promise<PickedFile | null> {
  try {
    const [file] = await pick({ type: [types.xlsx, types.csv, 'text/comma-separated-values'] });
    if (!file) return null;
    const body = await (await fetch(file.uri)).blob();
    const name = file.name ?? 'guests';
    const type = name.toLowerCase().endsWith('.csv') ? 'text/csv' : (file.type ?? XLSX);
    return { name, type, size: file.size ?? body.size, body };
  } catch (e) {
    if ((e as { code?: string }).code === 'OPERATION_CANCELED') return null;
    throw e;
  }
}
