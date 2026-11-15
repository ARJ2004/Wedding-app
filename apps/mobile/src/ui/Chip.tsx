import React from 'react';
import { Pressable, ScrollView } from 'react-native';
import { useStyles } from '../theme/ThemeProvider';
import { Text } from './Text';

interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  testID?: string;
}

export function Chip({ label, selected, onPress, testID }: ChipProps) {
  const s = useStyles((t) => ({
    chip: {
      minHeight: t.minTouchTarget - 8,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.pill,
      borderWidth: 1.5,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surface,
      justifyContent: 'center',
    },
    selected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      disabled={!onPress}
      testID={testID}
      style={[s.chip, selected && s.selected]}
    >
      <Text variant="caption" tone={selected ? 'onPrimary' : 'default'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  const s = useStyles((t) => ({ row: { gap: t.spacing.sm, paddingVertical: t.spacing.xs } }));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
      {children}
    </ScrollView>
  );
}
