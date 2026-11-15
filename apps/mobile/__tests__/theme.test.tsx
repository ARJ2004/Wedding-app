import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text as RNText } from 'react-native';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { useAppearance } from '../src/theme/preferences';
import { Button } from '../src/ui';

function Probe() {
  const t = useTheme();
  return <RNText testID="probe">{`${t.palette}|${t.scheme}|${t.type.body.fontSize}|${t.colors.primary}`}</RNText>;
}

test('theme follows appearance preferences and the palette choice', async () => {
  useAppearance.getState().set({ scheme: 'dark', largeText: true, palette: 'royalIndigoRose' });
  await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  expect(screen.getByTestId('probe').props.children).toBe('royalIndigoRose|dark|21|#AEB2FF');
});

test('buttons are labelled and at least 48dp tall', async () => {
  await render(
    <ThemeProvider>
      <Button label="Save" onPress={() => undefined} testID="b" />
    </ThemeProvider>,
  );
  const b = screen.getByTestId('b');
  expect(b.props.accessibilityLabel).toBe('Save');
  const style = Object.assign({}, ...[b.props.style].flat(3).filter(Boolean));
  expect(style.minHeight).toBeGreaterThanOrEqual(48);
});
