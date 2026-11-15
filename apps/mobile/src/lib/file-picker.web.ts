export interface PickedFile {
  name: string;
  type: string;
  size: number;
  body: Blob;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Web preview: a hidden <input type=file>. */
export function pickSpreadsheet(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const doc = (globalThis as unknown as { document: { createElement(t: string): HTMLInputLike; body: { appendChild(n: unknown): void } } }).document;
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv';
    input.setAttribute('data-testid', 'file-input');
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      const type = f.name.toLowerCase().endsWith('.csv') ? 'text/csv' : f.type || XLSX;
      resolve({ name: f.name, type, size: f.size, body: f });
    };
    doc.body.appendChild(input);
    input.click();
  });
}

interface HTMLInputLike {
  type: string;
  accept: string;
  style: { display: string };
  files?: { [i: number]: Blob & { name: string; size: number; type: string } } | null;
  onchange: (() => void) | null;
  setAttribute(k: string, v: string): void;
  remove(): void;
  click(): void;
}
