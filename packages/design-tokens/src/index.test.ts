import { contrastRatio, PALETTE_NAMES, resolveTheme, TEXT_PAIRS, toCssVariables, type ColorScheme } from './index';

const schemes: ColorScheme[] = ['light', 'dark'];

describe('design tokens', () => {
  const combos = PALETTE_NAMES.flatMap((palette) => schemes.map((scheme) => [palette, scheme] as const));

  it.each(combos)('%s %s text pairs meet WCAG AA (4.5:1)', (palette, scheme) => {
    const { colors } = resolveTheme({ scheme, palette });
    for (const [fg, bg] of TEXT_PAIRS) {
      expect({ pair: `${fg}/${bg}`, ratio: contrastRatio(colors[fg], colors[bg]) >= 4.5 }).toEqual({
        pair: `${fg}/${bg}`,
        ratio: true,
      });
    }
  });

  it.each(combos)('%s %s high-contrast body text reaches 7:1 (AAA)', (palette, scheme) => {
    const { colors } = resolveTheme({ scheme, palette, highContrast: true });
    expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(colors.textMuted, colors.background)).toBeGreaterThanOrEqual(7);
  });

  it('large text scales sizes and keeps line height ≥ 1.4× for Indic scripts', () => {
    const normal = resolveTheme({ scheme: 'light' });
    const large = resolveTheme({ scheme: 'light', largeText: true });
    expect(large.type.body.fontSize).toBeGreaterThan(normal.type.body.fontSize);
    for (const step of Object.values(large.type)) {
      expect(step.lineHeight / step.fontSize).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('keeps touch targets at 48', () => {
    expect(resolveTheme({ scheme: 'dark' }).minTouchTarget).toBe(48);
  });

  it('emits CSS variables for the lite web', () => {
    const css = toCssVariables(resolveTheme({ scheme: 'light' }));
    expect(css).toContain('--color-text: #2A1A14;');
    expect(css).toContain('--color-on-primary: #FFFFFF;');
    expect(css).toContain('--font-size-body: 16px;');
    expect(css).toContain('--min-touch: 48px;');
  });

  it('computes known contrast ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });
});
