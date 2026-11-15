import React from 'react';
import { Image, Linking, View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, ErrorState, Loading, Screen, SectionLabel, Text } from '../../ui';
import { EventCard } from '../events';
import { useGuestHome, type GuestHome } from './hooks';

type GEvent = GuestHome['events'][number];

const mapsUrl = (v: NonNullable<GEvent['venue']>) =>
  v.mapsUrl ?? (v.lat != null ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address ?? ''}`)}`);

/** GH-01/02: the guest's personal schedule. Icon + label on every action (older guests). */
export function GuestHomeScreen({ onRsvp }: { onRsvp: () => void }) {
  const t = useT();
  const home = useGuestHome();
  const s = useStyles((th) => ({
    hero: { backgroundColor: th.colors.primary, borderRadius: th.radii.lg, padding: th.spacing.xl, gap: th.spacing.xs, overflow: 'hidden' },
    cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.35 },
    actions: { flexDirection: 'row', gap: th.spacing.sm, flexWrap: 'wrap' },
    banner: { backgroundColor: th.colors.surfaceRaised, borderColor: th.colors.accent, borderWidth: 2 },
  }));
  if (home.isLoading) return <Screen><Loading /></Screen>;
  if (!home.data) return <Screen><ErrorState message={(home.error as Error | null)?.message ?? ''} onRetry={() => { void home.refetch(); }} /></Screen>;
  const h = home.data;

  return (
    <Screen testID="screen-guest-home">
      <View style={s.hero}>
        {h.wedding.coverUrl ? <Image source={{ uri: h.wedding.coverUrl }} style={s.cover} accessibilityIgnoresInvertColors /> : null}
        <Text tone="onPrimary">{t('guestHome.hello', { name: h.me.fullName.split(' ')[0] ?? h.me.fullName })}</Text>
        <Text variant="headline" tone="onPrimary">
          {h.wedding.title}
        </Text>
        <Text tone="onPrimary">
          {formatInZone(`${h.wedding.startsOn}T12:00:00Z`, h.wedding.timezone, { day: 'numeric', month: 'short' })} –{' '}
          {formatInZone(`${h.wedding.endsOn}T12:00:00Z`, h.wedding.timezone, { day: 'numeric', month: 'short', year: 'numeric' })}
          {h.wedding.cities.length ? ` · ${h.wedding.cities.join(', ')}` : ''}
        </Text>
      </View>

      {h.rsvpPending > 0 ? (
        <Card style={s.banner} testID="rsvp-banner">
          <Text variant="bodyStrong">{t('guestHome.rsvpPending', { count: h.rsvpPending })}</Text>
          <Button label={t('guestHome.rsvpCta')} icon="✓" onPress={onRsvp} testID="rsvp-cta" />
        </Card>
      ) : null}

      <SectionLabel>{t('guestHome.schedule')}</SectionLabel>
      {h.events.map((e) => (
        <EventCard key={e.id} event={e} timezone={h.wedding.timezone} venueName={e.venue?.name}>
          {e.rsvp.enabled && e.rsvp.answered > 0 ? (
            <Text variant="caption" tone="success">
              {t('guestHome.rsvpCount', { attending: e.rsvp.attending, total: e.rsvp.total })}
            </Text>
          ) : null}
          {e.venue ? (
            <View style={s.actions}>
              <Button label={t('guestHome.openMaps')} icon="⌖" variant="secondary" onPress={() => { void Linking.openURL(mapsUrl(e.venue!)); }} />
            </View>
          ) : null}
        </EventCard>
      ))}

      {h.contacts.length ? <SectionLabel>{t('guestHome.contacts')}</SectionLabel> : null}
      {h.contacts.map((c) => (
        <Card key={`${c.phone}-${c.label}`}>
          <Text variant="bodyStrong">{c.name}</Text>
          <Text variant="caption" tone="muted">
            {c.label}
          </Text>
          <View style={s.actions}>
            <Button label={t('guestHome.call')} icon="☎" variant="secondary" onPress={() => { void Linking.openURL(`tel:${c.phone}`); }} />
            {c.hasWhatsapp ? (
              <Button label={t('guestHome.whatsapp')} icon="✉" variant="secondary" onPress={() => { void Linking.openURL(`https://wa.me/${c.phone.replace('+', '')}`); }} />
            ) : null}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
