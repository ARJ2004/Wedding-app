import React, { useMemo, useState } from 'react';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { Button, Card, Chip, ChipRow, EmptyState, ErrorState, Loading, Screen, Text, TextField } from '../../ui';
import { useEventPresets, useWedding } from '../weddings';
import { EventCard } from './EventCard';
import { useAddPresets, useEvents, useVenues } from './hooks';

type PresetKind = 'haldi' | 'mehendi' | 'sangeet' | 'baraat' | 'pheras' | 'reception';

export function EventsScreen() {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const wedding = useWedding(weddingId);
  const events = useEvents(weddingId);
  const venues = useVenues(weddingId);
  const presets = useEventPresets();
  const add = useAddPresets(weddingId);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<PresetKind[]>([]);
  const [date, setDate] = useState('');
  const venueName = useMemo(() => new Map((venues.data ?? []).map((v) => [v.id, v.name])), [venues.data]);
  const tz = wedding.data?.timezone ?? 'Asia/Kolkata';

  const toggle = (k: PresetKind) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const submit = () =>
    add.mutate(picked.map((kind) => ({ kind, date: date || wedding.data!.startsOn })), {
      onSuccess: () => {
        setAdding(false);
        setPicked([]);
      },
    });

  return (
    <Screen testID="screen-events" footer={!adding ? <Button label={t('events.addPresets')} onPress={() => setAdding(true)} testID="add-events" /> : undefined}>
      <Text variant="headline">{t('events.title')}</Text>
      {adding ? (
        <Card>
          <Text variant="title">{t('events.presetsTitle')}</Text>
          <ChipRow>
            {(presets.data ?? []).map((p) => (
              <Chip key={p.kind} label={p.defaultName} selected={picked.includes(p.kind as PresetKind)} onPress={() => toggle(p.kind as PresetKind)} />
            ))}
          </ChipRow>
          <TextField label={t('events.presetsDate')} value={date} placeholder={wedding.data?.startsOn} onChangeText={setDate} />
          <Button label={t('events.addSelected', { count: picked.length })} disabled={picked.length === 0} loading={add.isPending} onPress={submit} />
          <Button label={t('common.cancel')} variant="text" onPress={() => setAdding(false)} />
        </Card>
      ) : null}
      {events.isLoading ? <Loading /> : null}
      {events.error ? <ErrorState message={(events.error as Error).message} onRetry={() => { void events.refetch(); }} /> : null}
      {events.data && events.data.length === 0 && !adding ? <EmptyState title={t('events.empty')} body={t('events.emptyBody')} /> : null}
      {events.data?.map((e) => <EventCard key={e.id} event={e} timezone={tz} venueName={e.venueId ? venueName.get(e.venueId) : undefined} />)}
    </Screen>
  );
}
