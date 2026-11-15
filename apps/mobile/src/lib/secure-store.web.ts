export type SecureKey = 'host' | 'guest' | 'install' | 'cachekey';

/** Web preview only: sessionStorage (the real app uses the OS keychain). */
const k = (key: SecureKey) => `mehfil.secure.${key}`;
export const secureStore = {
  async get(key: SecureKey = 'host'): Promise<string | null> {
    try {
      return window!.sessionStorage.getItem(k(key));
    } catch {
      return null;
    }
  },
  async set(value: string, key: SecureKey = 'host'): Promise<void> {
    try {
      window!.sessionStorage.setItem(k(key), value);
    } catch {
      /* private mode: session lives in memory only */
    }
  },
  async clear(key: SecureKey = 'host'): Promise<void> {
    try {
      window!.sessionStorage.removeItem(k(key));
    } catch {
      /* ignore */
    }
  },
};
