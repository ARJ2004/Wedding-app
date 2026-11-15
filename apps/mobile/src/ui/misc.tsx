import React from 'react';
import { ActivityIndicator, Pressable, Switch, View } from 'react-native';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import { Button } from './Button';
import { Text } from './Text';

export function SectionLabel({ children }: { children: string }) {
  const s = useStyles((t) => ({ label: { marginTop: t.spacing.md, letterSpacing: 0.6 } }));
  return (
    <Text variant="caption" tone="muted" style={s.label}>
      {children.toUpperCase()}
    </Text>
  );
}

export function ListRow({
  title,
  subtitle,
  trailing,
  onPress,
  testID,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
}) {
  const s = useStyles((t) => ({
    row: {
      minHeight: t.minTouchTarget + 8,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: t.spacing.sm,
      gap: t.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
    },
    body: { flex: 1, gap: t.spacing.xxs },
  }));
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} onPress={onPress} disabled={!onPress} style={s.row} testID={testID}>
      <View style={s.body}>
        <Text variant="bodyStrong">{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

export function ToggleRow({ title, subtitle, value, onChange, testID }: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  const t = useTheme();
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      testID={testID}
      trailing={
        <Switch
          accessibilityLabel={title}
          value={value}
          onValueChange={onChange}
          trackColor={{ true: t.colors.primary, false: t.colors.border }}
          thumbColor={t.colors.surface}
        />
      }
    />
  );
}

export function Tag({ label, tone = 'neutral', testID }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'primary'; testID?: string }) {
  const s = useStyles((t) => ({
    tag: {
      alignSelf: 'flex-start',
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xxs,
      borderRadius: t.radii.sm,
      borderWidth: 1,
      borderColor: {
        neutral: t.colors.border,
        success: t.colors.success,
        warning: t.colors.warning,
        danger: t.colors.danger,
        primary: t.colors.primary,
      }[tone],
    },
  }));
  const textTone = tone === 'neutral' ? 'muted' : tone === 'warning' ? 'default' : tone;
  return (
    <View style={s.tag} testID={testID}>
      <Text variant="caption" tone={textTone}>
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({ title, body, actionLabel, onAction }: { title: string; body?: string; actionLabel?: string; onAction?: () => void }) {
  const s = useStyles((t) => ({ wrap: { alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.xxl } }));
  return (
    <View style={s.wrap}>
      <Text variant="title" align="center">
        {title}
      </Text>
      {body ? (
        <Text tone="muted" align="center">
          {body}
        </Text>
      ) : null}
      {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <EmptyState title={message} actionLabel={onRetry ? 'Try again' : undefined} onAction={onRetry} />;
}

export function Loading() {
  const t = useTheme();
  const s = useStyles((th) => ({ wrap: { padding: th.spacing.xxl, alignItems: 'center' } }));
  return (
    <View style={s.wrap} accessibilityLabel="Loading">
      <ActivityIndicator color={t.colors.primary} size="large" />
    </View>
  );
}
