import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text';

interface Props {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** Optional leading glyph; the label is always shown (older guests need words, not icons). */
  icon?: string;
  testID?: string;
  accessibilityHint?: string;
}

export function Button({ label, onPress, variant = 'primary', loading, disabled, icon, testID, accessibilityHint }: Props) {
  const t = useTheme();
  const s = useStyles((th) => ({
    base: {
      minHeight: th.minTouchTarget,
      borderRadius: th.radii.md,
      paddingHorizontal: th.spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: th.spacing.sm,
    },
    primary: { backgroundColor: th.colors.primary },
    secondary: { backgroundColor: th.colors.surface, borderWidth: 1.5, borderColor: th.colors.primary },
    danger: { backgroundColor: th.colors.danger },
    text: { backgroundColor: 'transparent' },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.85 },
    row: { flexDirection: 'row', alignItems: 'center', gap: th.spacing.sm },
  }));
  const tone = variant === 'primary' || variant === 'danger' ? 'onPrimary' : 'primary';
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
      disabled={isDisabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [s.base, s[variant], isDisabled && s.disabled, pressed && s.pressed]}
    >
      {loading ? (
        <ActivityIndicator color={tone === 'onPrimary' ? t.colors.onPrimary : t.colors.primary} />
      ) : (
        <View style={s.row}>
          {icon ? <Text variant="bodyStrong" tone={tone}>{icon}</Text> : null}
          <Text variant="bodyStrong" tone={tone}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
