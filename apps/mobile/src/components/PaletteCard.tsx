import { PALETTES, type PaletteName } from '@mehfil/design-tokens';
import React from 'react';
import { View } from 'react-native';
import { useStyles } from '../theme/ThemeProvider';
import { Card, Text } from '../ui';

/** A palette option with its name, description and swatches (More → Appearance, Wedding settings). */
export function PaletteCard({ name, selected, onPress, testID }: { name: PaletteName; selected: boolean; onPress: () => void; testID?: string }) {
  const p = PALETTES[name];
  const s = useStyles((t) => ({
    row: { flexDirection: 'row', gap: t.spacing.xs },
    dot: { width: 22, height: 22, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.colors.border },
    selected: { borderColor: t.colors.primary, borderWidth: 2 },
  }));
  return (
    <Card onPress={onPress} accessibilityLabel={p.label} testID={testID} style={selected ? s.selected : undefined}>
      <Text variant="bodyStrong" tone={selected ? 'primary' : 'default'}>
        {selected ? '● ' : ''}
        {p.label}
      </Text>
      <Text variant="caption" tone="muted">
        {p.description}
      </Text>
      <View style={s.row}>
        {[p.light.primary, p.light.accent, p.light.background, p.dark.primary].map((c, i) => (
          <View key={`${c}-${i}`} style={[s.dot, { backgroundColor: c }]} />
        ))}
      </View>
    </Card>
  );
}
