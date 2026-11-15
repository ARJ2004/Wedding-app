import { zonedTimeToUtc } from '@mehfil/domain';
import React, { useState } from 'react';
import { View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { ApiError } from '../../lib/api';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, EmptyState, ErrorState, Loading, Screen, SectionLabel, Tag, Text, TextField, ToggleRow } from '../../ui';
import { useGuestHome } from './hooks';
import { useGuestTravel, useNotTravelling, useRemoveLeg, useSaveLeg, type TravelLeg } from './travel-hooks';

type Mode = 'flight' | 'train' | 'car' | 'bus' | 'other';
type Direction = 'arrival' | 'departure';
const MODES: Mode[] = ['flight', 'train', 'car', 'bus'];
const ICON: Record<Mode, string> = { flight: '✈', train: '🚆', car: '🚗', bus: '🚌', other: '•' };

interface Form {
  edit?: { id: string; version: number };
  direction: Direction;
  mode: Mode;
  serviceNumber: string;
  originCity: string;
  pointId: string | null;
  date: string;
  time: string;
  needsPickup: boolean;
  guestIds: string[];
}

/** Days around the wedding a guest can pick (wedding − 3 … end + 2), as YYYY-MM-DD. */
function dayChoices(startsOn: string, endsOn: string, direction: Direction) {
  const out: string[] = [];
  const start = Date.parse(`${startsOn}T00:00:00Z`) - (direction === 'arrival' ? 3 : 0) * 86_400_000;
  const end = Date.parse(`${endsOn}T00:00:00Z`) + (direction === 'arrival' ? 0 : 2) * 86_400_000;
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Guest travel (TRV-01, 08-trv §6): one card per journey, an inline form for arrival or departure
 * covering some or all of the family, and "we're not travelling" for local families.
 */
export function TravelScreen() {
  const t = useT();
  const home = useGuestHome();
  const travel = useGuestTravel();
  const save = useSaveLeg();
  const remove = useRemoveLeg();
  const local = useNotTravelling();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = useStyles((th) => ({
    row: { flexDirection: 'row', gap: th.spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  }));
  const w = home.data?.wedding;
  const tz = w?.timezone ?? 'Asia/Kolkata';
  const data = travel.data;

  const open = (direction: Direction, leg?: TravelLeg) => {
    setError(null);
    const taken = new Set((data?.legs ?? []).filter((l) => l.direction === direction && l.id !== leg?.id).flatMap((l) => l.guests.map((g) => g.id)));
    const day = leg ? formatInZone(leg.scheduledAt, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-') : w?.startsOn ?? '';
    setForm({
      edit: leg ? { id: leg.id, version: leg.version } : undefined,
      direction,
      mode: (leg?.mode as Mode) ?? 'flight',
      serviceNumber: leg?.serviceNumber ?? '',
      originCity: leg?.originCity ?? '',
      pointId: leg ? leg.point?.id ?? null : data?.points[0]?.id ?? null,
      date: day,
      time: leg ? formatInZone(leg.scheduledAt, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '',
      needsPickup: leg?.needsPickup ?? direction === 'arrival',
      guestIds: leg ? leg.guests.map((g) => g.id) : (data?.members ?? []).map((m) => m.id).filter((id) => !taken.has(id)),
    });
  };

  const submit = () => {
    if (!form) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return setError(t('trv.timeHint'));
    if (form.guestIds.length === 0) return setError(t('trv.pickPeople'));
    const at = zonedTimeToUtc(form.date, form.time, tz).toISOString();
    save.mutate(
      {
        edit: form.edit,
        body: {
          direction: form.direction,
          mode: form.mode,
          serviceNumber: form.serviceNumber.trim() || null,
          originCity: form.originCity.trim() || null,
          pointId: form.pointId,
          scheduledAt: at,
          needsPickup: form.needsPickup,
          guestIds: form.guestIds,
        },
      },
      {
        onSuccess: () => setForm(null),
        onError: (e) => setError(e instanceof ApiError ? e.message : t('trv.saveFailed')),
      },
    );
  };

  if (travel.isLoading || home.isLoading) return <Screen><Loading /></Screen>;
  if (!data || !w) return <Screen><ErrorState message={t('common.loadFailed')} onRetry={() => { void travel.refetch(); }} /></Screen>;

  if (form) {
    const days = dayChoices(w.startsOn, w.endsOn, form.direction);
    const set = (p: Partial<Form>) => setForm({ ...form, ...p });
    return (
      <Screen testID="screen-travel-form" footer={<View style={s.row}><Button label={t('common.cancel')} variant="secondary" onPress={() => setForm(null)} /><Button label={t('common.save')} onPress={submit} loading={save.isPending} testID="trv-save" /></View>}>
        <Text variant="headline">{form.direction === 'arrival' ? t('trv.arrivalTitle') : t('trv.departureTitle')}</Text>
        <SectionLabel>{t('trv.how')}</SectionLabel>
        <ChipRow>
          {MODES.map((m) => (
            <Chip key={m} label={`${ICON[m]} ${t(`trv.mode.${m}`)}`} selected={form.mode === m} onPress={() => set({ mode: m })} testID={`trv-mode-${m}`} />
          ))}
        </ChipRow>
        {form.mode === 'flight' || form.mode === 'train' ? (
          <TextField
            label={form.mode === 'flight' ? t('trv.flightNo') : t('trv.trainNo')}
            value={form.serviceNumber}
            onChangeText={(v) => set({ serviceNumber: v })}
            autoCapitalize="characters"
            hint={form.mode === 'flight' ? t('trv.flightHint') : undefined}
            testID="trv-number"
          />
        ) : null}
        <TextField label={form.direction === 'arrival' ? t('trv.fromCity') : t('trv.toCity')} value={form.originCity} onChangeText={(v) => set({ originCity: v })} testID="trv-city" />
        <SectionLabel>{form.direction === 'arrival' ? t('trv.arriveAt') : t('trv.leaveFrom')}</SectionLabel>
        <ChipRow>
          {data.points.map((p) => (
            <Chip key={p.id} label={p.name} selected={form.pointId === p.id} onPress={() => set({ pointId: p.id })} testID={`trv-point-${p.code ?? p.id}`} />
          ))}
          <Chip label={t('trv.direct')} selected={form.pointId === null} onPress={() => set({ pointId: null })} />
        </ChipRow>
        <SectionLabel>{t('trv.when')}</SectionLabel>
        <ChipRow>
          {days.map((d) => (
            <Chip key={d} label={formatInZone(`${d}T12:00:00Z`, 'UTC', { weekday: 'short', day: 'numeric', month: 'short' })} selected={form.date === d} onPress={() => set({ date: d })} testID={`trv-day-${d}`} />
          ))}
        </ChipRow>
        <TextField label={t('trv.time')} value={form.time} onChangeText={(v) => set({ time: v })} placeholder="10:40" keyboardType="numbers-and-punctuation" hint={t('trv.timeHint')} testID="trv-time" />
        <SectionLabel>{t('trv.who')}</SectionLabel>
        <ChipRow>
          {data.members.map((m) => (
            <Chip
              key={m.id}
              label={m.fullName}
              selected={form.guestIds.includes(m.id)}
              onPress={() => set({ guestIds: form.guestIds.includes(m.id) ? form.guestIds.filter((x) => x !== m.id) : [...form.guestIds, m.id] })}
            />
          ))}
        </ChipRow>
        {form.direction === 'arrival' ? <ToggleRow title={t('trv.pickup')} subtitle={t('trv.pickupHint')} value={form.needsPickup} onChange={(v) => set({ needsPickup: v })} testID="trv-pickup" /> : null}
        {error ? <Text tone="danger" testID="trv-error">{error}</Text> : null}
      </Screen>
    );
  }

  const arrivals = data.legs.filter((l) => l.direction === 'arrival');
  const departures = data.legs.filter((l) => l.direction === 'departure');
  const arrived = new Set(arrivals.flatMap((l) => l.guests.map((g) => g.id)));
  const left = new Set(departures.flatMap((l) => l.guests.map((g) => g.id)));
  const card = (l: TravelLeg) => (
    <Card key={l.id}>
      <View style={s.head}>
        <Text variant="title">
          {ICON[l.mode as Mode]} {l.serviceNumber ?? t(`trv.mode.${l.mode as Mode}`)}
        </Text>
        {l.needsPickup ? <Tag label={t('trv.pickupTag')} tone="primary" /> : null}
      </View>
      <Text>{formatInZone(l.scheduledAt, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</Text>
      <Text tone="muted">{[l.originCity, l.point?.name ?? t('trv.direct')].filter(Boolean).join(l.direction === 'arrival' ? ' → ' : ' ← ')}</Text>
      <Text variant="caption" tone="muted">{l.guests.map((g) => g.fullName).join(', ')}</Text>
      <View style={s.row}>
        <Button label={t('trv.edit')} variant="secondary" onPress={() => open(l.direction, l)} testID={`trv-edit-${l.id}`} />
        <Button label={t('trv.remove')} variant="text" onPress={() => remove.mutate(l.id)} />
      </View>
    </Card>
  );

  return (
    <Screen testID="screen-travel">
      <Text variant="headline">{t('trv.title')}</Text>
      <Tag label={t(`trv.status.${data.status}`)} tone={data.status === 'submitted' || data.status === 'not_travelling' ? 'success' : 'warning'} testID="trv-status" />
      <Text tone="muted">{t('trv.intro')}</Text>
      <SectionLabel>{t('trv.arrivals')}</SectionLabel>
      {arrivals.length === 0 ? <EmptyState title={data.status === 'not_travelling' ? t('trv.localTitle') : t('trv.noArrival')} /> : null}
      {arrivals.map(card)}
      {data.members.some((m) => !arrived.has(m.id)) ? <Button label={t('trv.addArrival')} onPress={() => open('arrival')} testID="trv-add-arrival" /> : null}
      <SectionLabel>{t('trv.departures')}</SectionLabel>
      {departures.map(card)}
      {data.members.some((m) => !left.has(m.id)) ? <Button label={t('trv.addDeparture')} variant="secondary" onPress={() => open('departure')} testID="trv-add-departure" /> : null}
      {arrivals.length === 0 && data.status !== 'not_travelling' ? (
        <Button label={t('trv.local')} variant="text" onPress={() => local.mutate()} loading={local.isPending} testID="trv-local" />
      ) : null}
    </Screen>
  );
}
