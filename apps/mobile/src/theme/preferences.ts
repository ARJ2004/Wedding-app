import { THEME_CONFIG, type PaletteName } from '@mehfil/design-tokens';
import { create } from 'zustand';
import { prefsStorage } from '../lib/prefs-storage';

export type SchemePreference = 'system' | 'light' | 'dark';

export interface AppearancePrefs {
  scheme: SchemePreference;
  largeText: boolean;
  highContrast: boolean;
  /** null = the app default from packages/design-tokens/src/theme.config.ts */
  palette: PaletteName | null;
}

interface AppearanceState extends AppearancePrefs {
  set(patch: Partial<AppearancePrefs>): void;
}

const KEY = 'appearance.v1';

function initial(): AppearancePrefs {
  const saved = prefsStorage.get(KEY);
  const fallback: AppearancePrefs = { scheme: 'system', largeText: false, highContrast: false, palette: null };
  if (!saved) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(saved) as Partial<AppearancePrefs>) };
  } catch {
    return fallback;
  }
}

/** Per-device appearance choices. The brand default lives in THEME_CONFIG, not here. */
export const useAppearance = create<AppearanceState>((set, get) => ({
  ...initial(),
  set(patch) {
    set(patch);
    const { scheme, largeText, highContrast, palette } = { ...get(), ...patch };
    prefsStorage.set(KEY, JSON.stringify({ scheme, largeText, highContrast, palette }));
  },
}));

export const defaultPalette = (): PaletteName => THEME_CONFIG.palette;
