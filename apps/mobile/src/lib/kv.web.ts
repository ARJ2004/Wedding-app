/** Web preview: localStorage (the real app uses encrypted MMKV). */
export async function initKv(): Promise<void> {}
export const kv = {
  getItem: (k: string): string | null => {
    try {
      return window!.localStorage.getItem(`mehfil.kv.${k}`);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      window!.localStorage.setItem(`mehfil.kv.${k}`, v);
    } catch {
      /* quota or private mode */
    }
  },
  removeItem: (k: string) => {
    try {
      window!.localStorage.removeItem(`mehfil.kv.${k}`);
    } catch {
      /* ignore */
    }
  },
};
