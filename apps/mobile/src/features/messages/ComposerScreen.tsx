import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useT } from '../../i18n/useT';
import { ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, ErrorState, Loading, Screen, SectionLabel, Text, TextField } from '../../ui';
import { useEvents } from '../events';
import { useGroups } from '../guests';
import { useComposerDraft } from './draft';
import { useAudiencePreview, useMessage, useMessagePreview, useMessageTemplates, useSaveDraft, useSendMessage, useSendTest, type AudienceSpec } from './hooks';

type Mode = 'everyone' | 'groups' | 'events';
const modeOf = (a: AudienceSpec): Mode => (a.events?.length || a.rsvp ? 'events' : a.groups?.length ? 'groups' : 'everyone');
const toggle = (list: string[] | undefined, id: string) => (list?.includes(id) ? list.filter((x) => x !== id) : [...(list ?? []), id]);

/**
 * Announcement composer (MSG-03, 07-msg §6): template → text → audience (live count) → preview
 * and a test to the host's own WhatsApp. Sending to guests arrives with the fan-out (MSG-05).
 */
export function ComposerScreen({ messageId, onDone }: { messageId: string | null; onDone: () => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const { draft, open, update, clear } = useComposerDraft();
  useEffect(() => {
    open(weddingId, messageId);
  }, [open, weddingId, messageId]);

  const templates = useMessageTemplates(weddingId);
  const groups = useGroups(weddingId);
  const events = useEvents(weddingId);
  const saved = useMessage(weddingId, draft?.messageId ?? null);
  const save = useSaveDraft(weddingId);
  const sendTest = useSendTest(weddingId);
  const send = useSendMessage(weddingId);
  const [confirming, setConfirming] = useState(false);
  const preview = useMessagePreview(weddingId, saved.data);
  const audience = useMemo(() => draft?.audience ?? {}, [draft?.audience]);
  const count = useAudiencePreview(weddingId, audience, draft?.templateKey ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const s = useStyles((th) => ({
    bubble: { backgroundColor: th.colors.background, borderWidth: 1, borderColor: th.colors.border, borderRadius: th.radii.md, padding: th.spacing.md, gap: th.spacing.xs },
    row: { flexDirection: 'row', gap: th.spacing.sm, flexWrap: 'wrap' },
    stats: { gap: th.spacing.xxs },
  }));

  if (!draft) return <Screen><Loading /></Screen>;
  const mode = modeOf(audience);
  const tpl = templates.data?.find((x) => x.key === draft.templateKey);
  const max = tpl?.params.find((p) => p.name === 'text')?.max ?? 1024;
  const dirty =
    !saved.data ||
    saved.data.bodyText !== draft.bodyText ||
    (saved.data.title ?? '') !== draft.title ||
    saved.data.templateKey !== draft.templateKey ||
    JSON.stringify(saved.data.audience) !== JSON.stringify(audience);
  const setAudience = (a: AudienceSpec) => update({ audience: a });
  const rsvpEvent = audience.rsvp?.eventId ?? (audience.events?.length === 1 ? audience.events[0] : undefined);

  const onSave = () => {
    setNotice(null);
    save.mutate(
      { fields: { templateKey: draft.templateKey, title: draft.title.trim(), bodyText: draft.bodyText.trim(), audience }, idempotencyKey: draft.idempotencyKey, existing: saved.data ?? null },
      {
        onSuccess: (m) => {
          update({ messageId: m.id });
          setNotice(t('msg.saved'));
        },
        onError: (e) => setNotice(e instanceof ApiError && e.code === 'MSG_VERSION_CONFLICT' ? t('msg.conflict') : t('msg.saveFailed')),
      },
    );
  };
  const onSend = () => {
    if (!saved.data) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    send.mutate(
      { messageId: saved.data.id, idempotencyKey: `${draft.idempotencyKey}-send` },
      {
        onSuccess: () => {
          clear();
          onDone();
        },
        onError: (e) => {
          setConfirming(false);
          setNotice(e instanceof ApiError && e.code === 'MSG_AUDIENCE_EMPTY' ? t('msg.audienceEmpty') : t('msg.sendFailed'));
        },
      },
    );
  };
  const onTest = () => {
    if (!saved.data) return;
    sendTest.mutate(saved.data.id, {
      onSuccess: (r) => setNotice(t('msg.testSent', { to: r.sentTo })),
      onError: (e) => setNotice(e instanceof ApiError && e.code === 'MSG_NO_PHONE_ON_ACCOUNT' ? t('msg.noPhone') : t('msg.testFailed')),
    });
  };

  return (
    <Screen
      testID="screen-composer"
      footer={
        <View style={s.row}>
          <Button label={t('common.back')} variant="secondary" onPress={onDone} testID="msg-back" />
          <Button label={dirty ? t('msg.saveDraft') : t('msg.savedShort')} onPress={onSave} loading={save.isPending} disabled={!dirty || !draft.bodyText.trim()} testID="msg-save" />
        </View>
      }
    >
      <Text variant="headline">{t('msg.composeTitle')}</Text>

      <SectionLabel>{t('msg.template')}</SectionLabel>
      {templates.isError ? <ErrorState message={t('common.loadFailed')} onRetry={() => { void templates.refetch(); }} /> : null}
      <ChipRow>
        {(templates.data ?? []).map((x) => (
          <Chip key={x.key} label={x.description ?? x.key} selected={x.key === draft.templateKey} onPress={() => update({ templateKey: x.key })} testID={`msg-tpl-${x.key}`} />
        ))}
      </ChipRow>

      <TextField label={t('msg.titleLabel')} value={draft.title} onChangeText={(v) => update({ title: v })} maxLength={80} hint={t('msg.titleHint')} testID="msg-title" />
      <TextField
        label={t('msg.bodyLabel')}
        value={draft.bodyText}
        onChangeText={(v) => update({ bodyText: v })}
        multiline
        maxLength={max}
        hint={t('msg.chars', { used: draft.bodyText.length, max })}
        testID="msg-body"
      />

      <SectionLabel>{t('msg.audience')}</SectionLabel>
      <ChipRow>
        <Chip label={t('msg.everyone')} selected={mode === 'everyone'} onPress={() => setAudience({})} testID="aud-everyone" />
        <Chip label={t('msg.byGroup')} selected={mode === 'groups'} onPress={() => setAudience({ groups: groups.data?.slice(0, 1).map((g) => g.id) ?? [] })} testID="aud-groups" />
        <Chip label={t('msg.byEvent')} selected={mode === 'events'} onPress={() => setAudience({ events: events.data?.slice(0, 1).map((e) => e.id) ?? [] })} testID="aud-events" />
      </ChipRow>
      {mode === 'groups' ? (
        <ChipRow>
          {(groups.data ?? []).map((g) => (
            <Chip key={g.id} label={g.name} selected={!!audience.groups?.includes(g.id)} onPress={() => setAudience({ groups: toggle(audience.groups, g.id) })} testID={`aud-group-${g.name}`} />
          ))}
        </ChipRow>
      ) : null}
      {mode === 'events' ? (
        <>
          <ChipRow>
            {(events.data ?? []).map((e) => (
              <Chip key={e.id} label={e.name} selected={!!audience.events?.includes(e.id) || audience.rsvp?.eventId === e.id} onPress={() => setAudience({ events: toggle(audience.events ?? (audience.rsvp ? [audience.rsvp.eventId] : []), e.id) })} testID={`aud-event-${e.name}`} />
            ))}
          </ChipRow>
          {rsvpEvent ? (
            <ChipRow>
              <Chip label={t('msg.allInvited')} selected={!audience.rsvp} onPress={() => setAudience({ events: [rsvpEvent] })} />
              <Chip label={t('msg.notAnswered')} selected={!!audience.rsvp?.statuses.includes('pending')} onPress={() => setAudience({ events: [rsvpEvent], rsvp: { eventId: rsvpEvent, statuses: ['pending'] } })} testID="aud-pending" />
              <Chip label={t('msg.attending')} selected={!!audience.rsvp?.statuses.includes('attending')} onPress={() => setAudience({ events: [rsvpEvent], rsvp: { eventId: rsvpEvent, statuses: ['attending'] } })} testID="aud-attending" />
            </ChipRow>
          ) : null}
        </>
      ) : null}
      <Card>
        {count.data ? (
          <View style={s.stats} testID="aud-count">
            <Text variant="title" tone="primary">
              {t('msg.recipients', { count: count.data.recipients })}
            </Text>
            <Text tone="muted">{t('msg.whatsappCount', { count: count.data.byChannel.whatsapp })}</Text>
            {count.data.suppressed.noPhone + count.data.suppressed.optedOut + count.data.suppressed.duplicatePhone > 0 ? (
              <Text variant="caption" tone="muted">
                {t('msg.suppressed', { noPhone: count.data.suppressed.noPhone, optedOut: count.data.suppressed.optedOut, shared: count.data.suppressed.duplicatePhone })}
              </Text>
            ) : null}
          </View>
        ) : (
          <Loading />
        )}
      </Card>

      <SectionLabel>{t('msg.preview')}</SectionLabel>
      {saved.data && !dirty && preview.data ? (
        <View style={s.bubble} testID="msg-preview">
          <Text variant="caption" tone="muted">
            WhatsApp
          </Text>
          <Text>{preview.data.whatsapp.text}</Text>
        </View>
      ) : (
        <Text tone="muted">{t('msg.previewHint')}</Text>
      )}
      {saved.data && !dirty ? (
        <View style={s.row}>
          <Button label={t('msg.sendTest')} variant="secondary" onPress={onTest} loading={sendTest.isPending} testID="msg-test" />
          <Button
            label={t('msg.discard')}
            variant="text"
            onPress={() => {
              clear();
              onDone();
            }}
          />
        </View>
      ) : null}
      {saved.data && !dirty ? (
        <Button
          label={confirming ? t('msg.confirmSend', { count: count.data?.byChannel.whatsapp ?? 0 }) : t('msg.sendNow')}
          variant={confirming ? 'danger' : 'primary'}
          onPress={onSend}
          loading={send.isPending}
          testID="msg-send"
        />
      ) : null}
      {notice ? (
        <Text tone="primary" testID="msg-notice">
          {notice}
        </Text>
      ) : null}
    </Screen>
  );
}
