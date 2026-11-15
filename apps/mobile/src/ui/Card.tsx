import React from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import { useStyles } from '../theme/ThemeProvider';

interface Props extends ViewProps {
  onPress?: () => void;
  accessibilityLabel?: string;
}

export function Card({ children, onPress, style, accessibilityLabel, testID, ...rest }: Props) {
  const s = useStyles((t) => ({
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radii.lg,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.lg,
      gap: t.spacing.sm,
    },
    pressed: { opacity: 0.9 },
  }));
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => [s.card, pressed && s.pressed, style as object]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View style={[s.card, style]} testID={testID} {...rest}>
      {children}
    </View>
  );
}
