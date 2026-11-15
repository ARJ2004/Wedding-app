/** Web preview only: sessionStorage (the real app uses the OS keychain). */
const KEY = 'mehfil.session';
export const secureStore = {
  async get(): Promise<string | null> {
    try {
      return window!.sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  async set(value: string): Promise<void> {
    try {
      window!.sessionStorage.setItem(KEY, value);
    } catch {
      /* private mode: session lives in memory only */
    }
  },
  async clear(): Promise<void> {
    try {
      window!.sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};
