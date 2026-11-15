/**
 * Colour palettes to choose from. Every palette defines the same semantic names for light and
 * dark, so switching palettes never touches a component. Contrast is enforced by tests for all
 * palettes (WCAG AA, AAA in high-contrast mode).
 */
export interface Palette {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  focus: string;
}

export interface PaletteSet {
  label: string;
  description: string;
  light: Palette;
  dark: Palette;
}

const status = {
  light: { success: '#1E6B3A', warning: '#8A5300', danger: '#B42318', info: '#1D4E89' },
  dark: { success: '#8FD6A6', warning: '#F5C27A', danger: '#FF9C92', info: '#9CC4F5' },
};

export const PALETTES = {
  maroonMarigold: {
    label: 'Maroon & Marigold',
    description: 'Classic North Indian wedding: deep maroon with marigold gold on warm ivory.',
    light: {
      background: '#FFF8F1', surface: '#FFFFFF', surfaceRaised: '#FFFFFF', border: '#E6D9CC',
      text: '#2A1A14', textMuted: '#6B5348', primary: '#8E1B3C', onPrimary: '#FFFFFF',
      accent: '#B7791F', onAccent: '#1F1300', focus: '#1D4E89', ...status.light,
    },
    dark: {
      background: '#17100D', surface: '#221814', surfaceRaised: '#2C201B', border: '#4A3A33',
      text: '#F7EDE6', textMuted: '#CBB8AD', primary: '#F2A7BB', onPrimary: '#3A0716',
      accent: '#F2C46B', onAccent: '#2A1A00', focus: '#9CC4F5', ...status.dark,
    },
  },
  mehendiGold: {
    label: 'Mehendi & Gold',
    description: 'Henna green with antique gold: earthy, calm, great for Mehendi and Haldi.',
    light: {
      background: '#F7F8EE', surface: '#FFFFFF', surfaceRaised: '#FFFFFF', border: '#D9DDC4',
      text: '#1C2414', textMuted: '#4F5A40', primary: '#3F5A1E', onPrimary: '#FFFFFF',
      accent: '#9A6B12', onAccent: '#FFFFFF', focus: '#1D4E89', ...status.light,
    },
    dark: {
      background: '#10140B', surface: '#191F12', surfaceRaised: '#222A18', border: '#3D4730',
      text: '#EEF2E2', textMuted: '#C2CBAE', primary: '#B9D98C', onPrimary: '#1A2608',
      accent: '#E8C46A', onAccent: '#2A1E00', focus: '#9CC4F5', ...status.dark,
    },
  },
  royalIndigoRose: {
    label: 'Royal Indigo & Rose',
    description: 'Midnight indigo with rose pink: evening receptions and Sangeet nights.',
    light: {
      background: '#F7F6FC', surface: '#FFFFFF', surfaceRaised: '#FFFFFF', border: '#DCD8EC',
      text: '#191632', textMuted: '#4E4970', primary: '#2E2A7A', onPrimary: '#FFFFFF',
      accent: '#A3245C', onAccent: '#FFFFFF', focus: '#1D4E89', ...status.light,
    },
    dark: {
      background: '#0E0D1C', surface: '#171630', surfaceRaised: '#201E3E', border: '#3A3763',
      text: '#ECEBFA', textMuted: '#BDB9E0', primary: '#AEB2FF', onPrimary: '#14124A',
      accent: '#FF9CC5', onAccent: '#3E0A22', focus: '#9CC4F5', ...status.dark,
    },
  },
  peacockSaffron: {
    label: 'Peacock & Saffron',
    description: 'Peacock teal with saffron orange: bright, South Indian temple wedding feel.',
    light: {
      background: '#F3F9F8', surface: '#FFFFFF', surfaceRaised: '#FFFFFF', border: '#CFE3E0',
      text: '#0E2422', textMuted: '#3F5D5A', primary: '#0B5C63', onPrimary: '#FFFFFF',
      accent: '#B34A00', onAccent: '#FFFFFF', focus: '#1D4E89', ...status.light,
    },
    dark: {
      background: '#081514', surface: '#0F201F', surfaceRaised: '#162B29', border: '#2D4A47',
      text: '#E6F5F3', textMuted: '#AFCFCB', primary: '#7FD6DC', onPrimary: '#032A2E',
      accent: '#FFB070', onAccent: '#3A1800', focus: '#9CC4F5', ...status.dark,
    },
  },
} satisfies Record<string, PaletteSet>;

export type PaletteName = keyof typeof PALETTES;
export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
