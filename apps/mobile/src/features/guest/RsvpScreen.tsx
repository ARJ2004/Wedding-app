import type { MessageId } from '@mehfil/i18n';
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useGuestSession } from '../../lib/guest-session';
import { useOutbox } from '../../lib/outbox';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, Loading, Screen, SectionLabel, Text } from '../../ui';
import { useGuestRsvp, useSaveRsvp } from './hooks';

type Status = 'attending' | 'declined' | 'maybe';
type Diet = 'veg' | 'jain' | 'vegan' | 'eggetarian' | 'non_veg';
const STATUSES: { s: Status; icon: string }[] = [
  { s: 'attending', icon: '✓' },
  { s: 'declined', icon: '✕' },
  { s: 'maybe', icon: '?' },
];
const DIETS: Diet[] = ['veg', 'jain', 'vegan', 'eggetarian', 'non_veg'];

/** RSV-01a: one screen for the whole family; answers are saved together. */
export function RsvpScreen() {
  const t = useT();
  const rsvp = useGuestRsvp();
  const save = useSaveRsvp();
  const tz = useGuestSession((s) => s.session?.wedding.timezone ?? 'Asia/Kolkata');
  const [answers, setAnswers] = useState<Record<string, Status>>({});
  const [diets, setDiets] = useState<Record<string, Diet | null>>({});
  const [saved, setSaved] = useState<boolean | 'queued'>(false);
  const queued = useOutbox((o) => o.items.filter((i) => i.path === '/v1/guest/rsvp').length);
  const s = useStyles((th) => ({ member: { gap: th.spacing.xs, paddingVertical: th.spacing.xs } }));

  const current = useMemo(() => {
    const m: Record<string, Status | null> = {};
    for (const e of rsvp.data?.events ?? []) for (const a of e.answers) m[`${e.eventId}:${a.guestId}`] = a.status;
    return m;
  }, [rsvp.data]);
  if (!rsvp.data) return <Screen><Loading /></Screen>;
  const changes = Object.keys(answers).length + Object.keys(diets).length;
  const nameOf = (id: string) => rsvp.data!.members.find((m) => m.guestId === id)?.fullName ?? '';

  const submit = () =>
    save.mutate(
      {
        answers: Object.entries(answers).map(([k, status]) => {
          const [eventId, guestId] = k.split(':') as [string, string];
          return { eventId, guestId, status };
        }),
        diets: Object.entries(diets).map(([guestId, diet]) => ({ guestId, diet, allergies: [] })),
      },
      {
        onSuccess: (res) => {
          setAnswers({});
          setDiets({});
          setSaved(res === 'queued' ? 'queued' : true);
        },
      },
    );

  return (
    <Screen
      testID="screen-rsvp"
      footer={
        <View>
          {changes ? (
            <Text variant="caption" tone="muted">{t('rsvp.unsaved', { count: changes })}</Text>
          ) : queued ? (
            <Text variant="caption" tone="default" testID="rsvp-queued">{t('rsvp.queued')}</Text>
          ) : saved ? (
            <Text variant="caption" tone="success">{t('rsvp.saved')}</Text>
          ) : null}
          <Button label={t('rsvp.save')} disabled={!changes} loading={save.isPending} onPress={submit} testID="rsvp-save" />
        </View>
      }
    >
      <Text variant="headline">{t('rsvp.title')}</Text>
      <Text tone="muted">{t('rsvp.body')}</Text>
      <Card>
        <Button
          label={t('rsvp.allYes')}
          icon="✓"
          variant="secondary"
          testID="rsvp-all-yes"
          onPress={() => {
            const all: Record<string, Status> = {};
            for (const e of rsvp.data!.events) if (e.rsvpEnabled && !e.closed) for (const a of e.answers) all[`${e.eventId}:${a.guestId}`] = 'attending';
            setAnswers(all);
          }}
        />
        <Text variant="caption" tone="muted">
          {t('rsvp.allYesHint')}
        </Text>
      </Card>
      {save.error ? <Text tone="danger">{(save.error as Error).message}</Text> : null}
      {rsvp.data.events
        .filter((e) => e.rsvpEnabled)
        .map((e) => (
          <Card key={e.eventId} testID={`rsvp-${e.name}`}>
            <Text variant="title">{e.name}</Text>
            <Text variant="caption" tone="muted">
              {formatInZone(e.startsAt, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
            </Text>
            {e.closed ? <Text tone="danger">{t('rsvp.closed')}</Text> : null}
            {e.answers.map((a) => {
              const key = `${e.eventId}:${a.guestId}`;
              const value = answers[key] ?? current[key];
              return (
                <View key={key} style={s.member}>
                  <Text variant="bodyStrong">{nameOf(a.guestId)}</Text>
                  <ChipRow>
                    {STATUSES.map(({ s: st, icon }) => (
                      <Chip
                        key={st}
                        label={`${icon} ${t(`rsvp.${st}` as MessageId)}`}
                        selected={value === st}
                        onPress={e.closed ? undefined : () => setAnswers((x) => ({ ...x, [key]: st }))}
                        testID={`rsvp-${e.name}-${nameOf(a.guestId)}-${st}`}
                      />
                    ))}
                  </ChipRow>
                </View>
              );
            })}
          </Card>
        ))}
      <SectionLabel>{t('rsvp.food')}</SectionLabel>
      {rsvp.data.members.map((m) => (
        <Card key={m.guestId}>
          <Text variant="bodyStrong">{m.fullName}</Text>
          <ChipRow>
            {DIETS.map((d) => (
              <Chip key={d} label={t(`rsvp.diet.${d}` as MessageId)} selected={(diets[m.guestId] ?? m.diet) === d} onPress={() => setDiets((x) => ({ ...x, [m.guestId]: d }))} />
            ))}
          </ChipRow>
        </Card>
      ))}
    </Screen>
  );
}
