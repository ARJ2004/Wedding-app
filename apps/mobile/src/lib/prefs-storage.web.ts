const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const prefsStorage = {
  get: (key: string): string | null => safe(() => window!.localStorage.getItem(`mehfil.${key}`), null),
  set: (key: string, value: string) => safe(() => window!.localStorage.setItem(`mehfil.${key}`, value), undefined),
  remove: (key: string) => safe(() => window!.localStorage.removeItem(`mehfil.${key}`), undefined),
};
