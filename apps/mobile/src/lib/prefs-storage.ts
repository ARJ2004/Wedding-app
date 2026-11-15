/**
 * Tiny synchronous key-value store for non-secret preferences. In-memory on native until MMKV
 * lands with APP-04 (offline cache); the web preview uses localStorage (prefs-storage.web.ts).
 */
const memory = new Map<string, string>();

export const prefsStorage = {
  get: (key: string): string | null => memory.get(key) ?? null,
  set: (key: string, value: string) => {
    memory.set(key, value);
  },
  remove: (key: string) => {
    memory.delete(key);
  },
};
