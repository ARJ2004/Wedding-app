import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, EmptyState, ErrorState, Loading, Screen, SectionLabel, Tag, Text } from '../../ui';
import { useWedding } from '../weddings';
import { useLiveHeadcount, type EventHeadcount, type Headcount } from './hooks';

function Breakdown({ title, data }: { title: string; data?: Record<string, number> }) {
  const t = useT();
  const s = useStyles((th) => ({ row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: th.spacing.xxs } }));
  const entries = Object.entries(data ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <View>
      <Text variant="caption" tone="muted">
        {title}
      </Text>
      {entries.map(([k, n]) => (
        <View key={k} style={s.row}>
          <Text>{t(`hc.label.${k}` as never)}</Text>
          <Text variant="title">{String(n)}</Text>
        </View>
      ))}
    </View>
  );
}

function EventCardHc({ e, timezone, detail }: { e: EventHeadcount; timezone: string; detail: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const s = useStyles((th) => ({
    top: { flexDirection: 'row', alignItems: 'baseline', gap: th.spacing.sm },
    bar: { height: 8, borderRadius: th.radii.pill, backgroundColor: th.colors.border, overflow: 'hidden', flexDirection: 'row' },
    yes: { backgroundColor: th.colors.success },
    maybe: { backgroundColor: th.colors.warning },
    no: { backgroundColor: th.colors.danger },
    chips: { flexDirection: 'row', gap: th.spacing.xs, flexWrap: 'wrap' },
    detail: { gap: th.spacing.md, paddingTop: th.spacing.sm },
  }));
  const c = e.counts;
  const pct = (n: number) => (e.invited ? (n / e.invited) * 100 : 0);
  return (
    <Card>
      <Pressable onPress={() => detail && setOpen(!open)} accessibilityRole={detail ? 'button' : undefined} accessibilityState={{ expanded: open }} testID={`hc-${e.name}`}>
        <Text variant="title">{e.name}</Text>
        <Text variant="caption" tone="muted">
          {formatInZone(e.startsAt, timezone, { weekday: 'short', day: 'numeric', month: 'short' })}
        </Text>
        <View style={s.top}>
          <Text variant="headline" tone="primary">
            {String(c.attending)}
          </Text>
          <Text tone="muted">{t('hc.comingOf', { invited: e.invited })}</Text>
        </View>
        <View style={s.bar} accessibilityLabel={t('hc.a11yBar', { yes: c.attending, maybe: c.maybe, no: c.declined, waiting: c.pending })}>
          <View style={[s.yes, { width: `${pct(c.attending)}%` }]} />
          <View style={[s.maybe, { width: `${pct(c.maybe)}%` }]} />
          <View style={[s.no, { width: `${pct(c.declined)}%` }]} />
        </View>
        <View style={s.chips}>
          <Tag label={t('hc.maybe', { n: c.maybe })} tone="warning" />
          <Tag label={t('hc.declined', { n: c.declined })} tone="danger" />
          <Tag label={t('hc.pending', { n: c.pending })} />
        </View>
      </Pressable>
      {open ? (
        <View style={s.detail}>
          <Breakdown title={t('hc.bySide')} data={Object.fromEntries(Object.entries(e.bySide ?? {}).map(([k, v]) => [k, v.attending]))} />
          <Breakdown title={t('hc.diet')} data={e.diet} />
          <Breakdown title={t('hc.allergies')} data={e.allergies} />
          <Breakdown title={t('hc.age')} data={e.ageBand} />
        </View>
      ) : null}
    </Card>
  );
}

/** Host headcount (RSV-03): per event, live; tap a card for side, diet, allergy and age. */
export function HeadcountScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const weddingId = useSession((st) => st.weddingId)!;
  const wedding = useWedding(weddingId).data;
  const hc = useLiveHeadcount(weddingId);
  const events = (hc.data?.events ?? []).filter((e) => e.rsvpEnabled);
  return (
    <Screen testID="screen-headcount" footer={<Button label={t('common.back')} variant="secondary" onPress={onBack} />}>
      <View>
        <Text variant="headline">{t('hc.title')}</Text>
        {hc.live === 'live' ? <Tag label={t('home.live')} tone="success" testID="hc-live" /> : null}
      </View>
      {hc.data?.detail ? <Text tone="muted">{t('hc.tapHint')}</Text> : null}
      {hc.isLoading ? <Loading /> : null}
      {hc.isError && !hc.data ? <ErrorState message={t('common.loadFailed')} onRetry={() => { void hc.refetch(); }} /> : null}
      {hc.data && events.length === 0 ? <EmptyState title={t('hc.empty')} /> : null}
      {events.length ? <SectionLabel>{t('hc.events')}</SectionLabel> : null}
      {events.map((e) => (
        <EventCardHc key={e.eventId} e={e} timezone={wedding?.timezone ?? 'Asia/Kolkata'} detail={!!hc.data?.detail} />
      ))}
    </Screen>
  );
}

/** Small "who's coming" card for Host home. */
export function HeadcountSummaryCard({ data, onOpen }: { data: Headcount | undefined; onOpen: () => void }) {
  const t = useT();
  const events = (data?.events ?? []).filter((e) => e.rsvpEnabled);
  if (!events.length) return null;
  const answered = events.reduce((n, e) => n + e.invited - e.counts.pending, 0);
  const total = events.reduce((n, e) => n + e.invited, 0);
  return (
    <Card>
      <Text variant="title">{t('hc.cardTitle')}</Text>
      <Text tone="muted">{t('hc.answered', { pct: total ? Math.round((answered / total) * 100) : 0 })}</Text>
      {events.slice(0, 3).map((e) => (
        <Text key={e.eventId}>{t('hc.line', { name: e.name, n: e.counts.attending, waiting: e.counts.pending })}</Text>
      ))}
      <Button label={t('hc.open')} variant="secondary" onPress={onOpen} testID="hc-open" />
    </Card>
  );
}
