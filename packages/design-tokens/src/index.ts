/**
 * Mehfil design tokens (FND-10). One source for the React Native theme (apps/mobile/src/theme)
 * and the guest lite web CSS variables. Components read semantic names only — never raw hex.
 * Brand palette is provisional until DSN-01 lands; contrast rules are enforced by tests.
 */

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radii = { sm: 8, md: 12, lg: 20, pill: 999 } as const;
/** WCAG / older-guest rule from lead.md: every tappable target is at least 48 dp. */
export const minTouchTarget = 48;

export type ColorScheme = 'light' | 'dark';

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

const light: Palette = {
  background: '#FFF8F1',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  border: '#E6D9CC',
  text: '#2A1A14',
  textMuted: '#6B5348',
  primary: '#8E1B3C', // deep maroon
  onPrimary: '#FFFFFF',
  accent: '#B7791F', // marigold
  onAccent: '#1F1300',
  success: '#1E6B3A',
  warning: '#8A5300',
  danger: '#B42318',
  info: '#1D4E89',
  focus: '#1D4E89',
};

const dark: Palette = {
  background: '#17100D',
  surface: '#221814',
  surfaceRaised: '#2C201B',
  border: '#4A3A33',
  text: '#F7EDE6',
  textMuted: '#CBB8AD',
  primary: '#F2A7BB',
  onPrimary: '#3A0716',
  accent: '#F2C46B',
  onAccent: '#2A1A00',
  success: '#8FD6A6',
  warning: '#F5C27A',
  danger: '#FF9C92',
  info: '#9CC4F5',
  focus: '#9CC4F5',
};

/** High contrast pushes text to near black/white and borders to full strength. */
const highContrast: Record<ColorScheme, Partial<Palette>> = {
  light: { background: '#FFFFFF', text: '#000000', textMuted: '#2A1A14', border: '#2A1A14', primary: '#6A0F2B' },
  dark: { background: '#000000', surface: '#0D0907', text: '#FFFFFF', textMuted: '#F7EDE6', border: '#F7EDE6' },
};

export interface TypeStep {
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '600' | '700';
}

/**
 * Line heights are generous (≥ 1.5×) so Devanagari and Kannada matras are not clipped (L10N-04).
 * Large-text mode multiplies sizes by 1.3 on top of the OS font scale.
 */
const typeScale = {
  caption: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  title: { fontSize: 20, lineHeight: 30, fontWeight: '700' },
  headline: { fontSize: 26, lineHeight: 38, fontWeight: '700' },
} satisfies Record<string, TypeStep>;

export type TypeName = keyof typeof typeScale;
export const LARGE_TEXT_MULTIPLIER = 1.3;

export interface ThemeOptions {
  scheme: ColorScheme;
  largeText?: boolean;
  highContrast?: boolean;
}

export interface Theme {
  scheme: ColorScheme;
  largeText: boolean;
  highContrast: boolean;
  colors: Palette;
  type: Record<TypeName, TypeStep>;
  spacing: typeof spacing;
  radii: typeof radii;
  minTouchTarget: number;
}

export function resolveTheme(opts: ThemeOptions): Theme {
  const base = opts.scheme === 'dark' ? dark : light;
  const colors = opts.highContrast ? { ...base, ...highContrast[opts.scheme] } : base;
  const mult = opts.largeText ? LARGE_TEXT_MULTIPLIER : 1;
  const type = Object.fromEntries(
    Object.entries(typeScale).map(([k, v]) => [
      k,
      { ...v, fontSize: Math.round(v.fontSize * mult), lineHeight: Math.round(v.lineHeight * mult) },
    ]),
  ) as Record<TypeName, TypeStep>;
  return {
    scheme: opts.scheme,
    largeText: Boolean(opts.largeText),
    highContrast: Boolean(opts.highContrast),
    colors,
    type,
    spacing,
    radii,
    minTouchTarget,
  };
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.1 contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Foreground/background pairs that must meet 4.5:1 (7:1 in high-contrast mode). */
export const TEXT_PAIRS: [keyof Palette, keyof Palette][] = [
  ['text', 'background'],
  ['text', 'surface'],
  ['textMuted', 'background'],
  ['textMuted', 'surface'],
  ['onPrimary', 'primary'],
  ['onAccent', 'accent'],
  ['danger', 'surface'],
  ['success', 'surface'],
  ['warning', 'surface'],
  ['info', 'surface'],
];

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** CSS custom properties for the guest lite web (`:root { --color-text: … }`). */
export function toCssVariables(theme: Theme): string {
  const lines = [
    ...Object.entries(theme.colors).map(([k, v]) => `--color-${kebab(k)}: ${v};`),
    ...Object.entries(theme.spacing).map(([k, v]) => `--space-${k}: ${v}px;`),
    ...Object.entries(theme.radii).map(([k, v]) => `--radius-${k}: ${v}px;`),
    ...Object.entries(theme.type).flatMap(([k, v]) => [
      `--font-size-${kebab(k)}: ${v.fontSize}px;`,
      `--line-height-${kebab(k)}: ${v.lineHeight}px;`,
    ]),
    `--min-touch: ${theme.minTouchTarget}px;`,
  ];
  return lines.join('\n');
}
