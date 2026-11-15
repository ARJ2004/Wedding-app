/** Web preview: download the file. */
export async function shareTextFile(name: string, mime: string, text: string) {
  const g = globalThis as unknown as {
    Blob: new (parts: string[], opts: { type: string }) => unknown;
    URL: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
    document: { createElement(t: 'a'): { href: string; download: string; click(): void } };
  };
  const url = g.URL.createObjectURL(new g.Blob([text], { type: mime }));
  const a = g.document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  g.URL.revokeObjectURL(url);
}
