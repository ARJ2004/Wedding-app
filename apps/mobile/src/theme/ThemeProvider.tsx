import { resolveTheme, type Theme } from '@mehfil/design-tokens';
import React, { createContext, useContext, useMemo } from 'react';
import { StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };
import { useAppearance } from './preferences';

const ThemeContext = createContext<Theme | null>(null);

/**
 * Supplies the resolved theme to every component. All colours, sizes and fonts come from
 * packages/design-tokens (palettes.ts + theme.config.ts) — change the look there, not here.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const { scheme, largeText, highContrast, palette } = useAppearance();
  const resolvedScheme = scheme === 'system' ? (system === 'dark' ? 'dark' : 'light') : scheme;
  const theme = useMemo(
    () => resolveTheme({ scheme: resolvedScheme, largeText, highContrast, palette: palette ?? undefined }),
    [resolvedScheme, largeText, highContrast, palette],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside <ThemeProvider>');
  return theme;
}

/** Memoised StyleSheet built from the theme: `const s = useStyles((t) => ({ box: { padding: t.spacing.md } }))`. */
export function useStyles<T extends NamedStyles<T>>(factory: (t: Theme) => T & NamedStyles<T>): T {
  const theme = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(factory(theme)), [theme]);
}
