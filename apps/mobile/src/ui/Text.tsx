import type { TypeName } from '@mehfil/design-tokens';
import React from 'react';
import { Text as RNText, type TextProps } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export type TextTone = 'default' | 'muted' | 'primary' | 'danger' | 'success' | 'onPrimary';

interface Props extends TextProps {
  variant?: TypeName;
  tone?: TextTone;
  align?: 'left' | 'center' | 'right';
}

/** All text goes through here so type scale, large-text mode and colours stay consistent. */
export function Text({ variant = 'body', tone = 'default', align, style, ...rest }: Props) {
  const t = useTheme();
  const color = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    primary: t.colors.primary,
    danger: t.colors.danger,
    success: t.colors.success,
    onPrimary: t.colors.onPrimary,
  }[tone];
  const step = t.type[variant];
  const isHeading = variant === 'title' || variant === 'headline';
  return (
    <RNText
      accessibilityRole={isHeading ? 'header' : undefined}
      maxFontSizeMultiplier={t.largeText ? 1.5 : 2}
      style={[
        {
          color,
          fontSize: step.fontSize,
          lineHeight: step.lineHeight,
          fontWeight: step.fontWeight,
          textAlign: align,
          fontFamily: t.fontFamily.body === 'System' ? undefined : t.fontFamily.body,
        },
        style,
      ]}
      {...rest}
    />
  );
}
