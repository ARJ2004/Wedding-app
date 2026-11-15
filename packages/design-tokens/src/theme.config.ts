import type { PaletteName } from './palettes';

/**
 * THE ONE PLACE TO CHANGE THE APP'S LOOK.
 *
 * - `palette`: pick one of PALETTES in ./palettes.ts (or add a new one there).
 * - `fontFamily`: body and heading font names (loaded by the app / lite web).
 * - `radiusScale`: 1 = default roundness; 0.5 sharper, 1.5 rounder.
 *
 * The app, the guest lite web page and screenshots all read this through resolveTheme().
 * Planner branding (PLN-04) can override `palette` per wedding at runtime.
 */
export const THEME_CONFIG: { palette: PaletteName; fontFamily: { body: string; heading: string }; radiusScale: number } = {
  palette: 'maroonMarigold',
  fontFamily: { body: 'System', heading: 'System' },
  radiusScale: 1,
};
