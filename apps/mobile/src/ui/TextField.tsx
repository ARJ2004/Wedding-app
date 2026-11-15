import React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

interface Props extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextField({ label, error, hint, testID, ...input }: Props) {
  const t = useTheme();
  const s = useStyles((th) => ({
    wrap: { gap: th.spacing.xs },
    input: {
      minHeight: th.minTouchTarget,
      borderWidth: 1.5,
      borderColor: th.colors.border,
      borderRadius: th.radii.md,
      paddingHorizontal: th.spacing.md,
      color: th.colors.text,
      backgroundColor: th.colors.surface,
      fontSize: th.type.body.fontSize,
    },
    inputError: { borderColor: th.colors.danger },
  }));
  return (
    <View style={s.wrap}>
      <Text variant="bodyStrong">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.colors.textMuted}
        style={[s.input, error ? s.inputError : null]}
        testID={testID}
        {...input}
      />
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
