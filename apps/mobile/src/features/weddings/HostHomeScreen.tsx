import React from 'react';
import { Image, View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Card, EmptyState, Loading, Screen, SectionLabel, Tag, Text } from '../../ui';
import { EventCard, useEvents, useVenues } from '../events';
import { useGroups, useParties } from '../guests';
import { useWedding } from './hooks';

function Stat({ label, value, testID }: { label: string; value: number | string; testID?: string }) {
  const s = useStyles((t) => ({ stat: { flex: 1, alignItems: 'center', gap: t.spacing.xxs } }));
  return (
    <View style={s.stat} testID={testID}>
      <Text variant="headline" tone="primary">
        {String(value)}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}

export function HostHomeScreen() {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const wedding = useWedding(weddingId);
  const events = useEvents(weddingId);
  const venues = useVenues(weddingId);
  const parties = useParties(weddingId, '', null);
  useGroups(weddingId);
  const s = useStyles((th) => ({
    hero: { backgroundColor: th.colors.primary, borderRadius: th.radii.lg, padding: th.spacing.xl, gap: th.spacing.xs, overflow: 'hidden' },
    cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.35 },
    stats: { flexDirection: 'row' },
  }));

  if (wedding.isLoading || !wedding.data) return <Screen><Loading /></Screen>;
  const w = wedding.data;
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.ceil((Date.parse(w.startsOn) - Date.parse(today)) / 86_400_000);
  const guestsCount = (parties.data?.items ?? []).reduce((n, p) => n + p.members.length, 0);
  const upcoming = (events.data ?? []).filter((e) => e.startsAt >= new Date().toISOString()).slice(0, 3);
  const venueName = new Map((venues.data ?? []).map((v) => [v.id, v.name]));

  return (
    <Screen testID="screen-host-home">
      <View style={s.hero}>
        {w.coverUrl ? <Image source={{ uri: w.coverUrl }} style={s.cover} accessibilityIgnoresInvertColors /> : null}
        <Text variant="caption" tone="onPrimary">
          {formatInZone(`${w.startsOn}T12:00:00Z`, w.timezone, { day: 'numeric', month: 'short' })} –{' '}
          {formatInZone(`${w.endsOn}T12:00:00Z`, w.timezone, { day: 'numeric', month: 'short', year: 'numeric' })}
          {w.cities.length ? ` · ${w.cities.join(', ')}` : ''}
        </Text>
        <Text variant="headline" tone="onPrimary">
          {w.title}
        </Text>
        <Text tone="onPrimary">{days > 0 ? t('home.days', { days }) : t('home.today')}</Text>
      </View>
      <Card>
        <View style={s.stats}>
          <Stat label={t('home.parties')} value={parties.data?.items.length ?? '–'} testID="stat-parties" />
          <Stat label={t('home.guests')} value={parties.data ? guestsCount : '–'} />
          <Stat label={t('home.events')} value={events.data?.length ?? '–'} />
        </View>
        <Tag label={t(`role.${w.myRole}`)} tone="primary" />
      </Card>
      <SectionLabel>{t('home.next')}</SectionLabel>
      {events.data && upcoming.length === 0 ? <EmptyState title={t('home.noEvents')} /> : null}
      {upcoming.map((e) => (
        <EventCard key={e.id} event={e} timezone={w.timezone} venueName={e.venueId ? venueName.get(e.venueId) : undefined} />
      ))}
    </Screen>
  );
}
