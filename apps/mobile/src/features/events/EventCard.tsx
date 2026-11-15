import type { Event } from '@mehfil/api-client';
import React from 'react';
import { View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useStyles } from '../../theme/ThemeProvider';
import { Card, Text } from '../../ui';

/** Shared by host Events/Home now and Guest Home later (moves to components/ with GH-02). */
export function EventCard({ event, timezone, venueName }: { event: Event; timezone: string; venueName?: string }) {
  const t = useT();
  const s = useStyles((th) => ({
    row: { flexDirection: 'row', gap: th.spacing.md, alignItems: 'flex-start' },
    date: {
      width: 56,
      borderRadius: th.radii.md,
      backgroundColor: th.colors.background,
      borderWidth: 1,
      borderColor: th.colors.border,
      alignItems: 'center',
      paddingVertical: th.spacing.xs,
    },
    body: { flex: 1, gap: th.spacing.xxs },
  }));
  return (
    <Card testID={`event-${event.name}`}>
      <View style={s.row}>
        <View style={s.date}>
          <Text variant="caption" tone="muted">
            {formatInZone(event.startsAt, timezone, { month: 'short' })}
          </Text>
          <Text variant="title" tone="primary">
            {formatInZone(event.startsAt, timezone, { day: 'numeric' })}
          </Text>
        </View>
        <View style={s.body}>
          <Text variant="title">{event.name}</Text>
          <Text tone="muted">
            {formatInZone(event.startsAt, timezone, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
            {venueName ? ` · ${venueName}` : ''}
          </Text>
          {event.dressCode ? <Text variant="caption">{t('events.dress', { dressCode: event.dressCode })}</Text> : null}
        </View>
      </View>
    </Card>
  );
}
