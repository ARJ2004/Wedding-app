import { useQueryClient } from '@tanstack/react-query';
import type { MessageId } from '@mehfil/i18n';
import React from 'react';
import { Linking, View } from 'react-native';
import { formatInZone, useT } from '../../i18n/useT';
import { useEventStream } from '../../lib/realtime';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, EmptyState, ErrorState, ListRow, Loading, Screen, SectionLabel, Tag, Text } from '../../ui';
import { useWedding } from '../weddings';
import { msgKeys, useFailedDeliveries, useMessage, useMessageSummary, useRetryFailed } from './hooks';

const ERROR_KEY: Record<string, MessageId> = {
  not_on_whatsapp: 'msg.error.not_on_whatsapp',
  rate_limited: 'msg.error.rate_limited',
  outside_window: 'msg.error.outside_window',
  meta_limited: 'msg.error.meta_limited',
  opted_out: 'msg.error.opted_out',
  unclear: 'msg.error.unclear',
  no_phone: 'msg.error.no_phone',
};

function Count({ label, value, testID }: { label: string; value: number; testID?: string }) {
  const s = useStyles((t) => ({ box: { flex: 1, alignItems: 'center', gap: t.spacing.xxs } }));
  return (
    <View style={s.box} testID={testID}>
      <Text variant="headline" tone="primary">
        {String(value)}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}

/**
 * Message detail (MSG-06): live delivery counts over SSE, the failures list with call and
 * WhatsApp buttons (numbers masked for planners), and "Send failed again".
 */
export function MessageDetailScreen({ messageId, onBack }: { messageId: string; onBack: () => void }) {
  const t = useT();
  const weddingId = useSession((st) => st.weddingId)!;
  const wedding = useWedding(weddingId).data;
  const message = useMessage(weddingId, messageId);
  const summary = useMessageSummary(weddingId, messageId);
  const failed = useFailedDeliveries(weddingId, messageId);
  const retry = useRetryFailed(weddingId, messageId);
  const qc = useQueryClient();
  const live = useEventStream(weddingId, ['messages'], {
    onEvent: (e) => {
      if ((e.payload as { messageId?: string }).messageId === messageId) {
        qc.invalidateQueries({ queryKey: msgKeys.one(weddingId, messageId) }).catch(() => undefined);
      }
    },
    onReset: () => {
      qc.invalidateQueries({ queryKey: msgKeys.one(weddingId, messageId) }).catch(() => undefined);
    },
  });
  const s = useStyles((th) => ({
    counts: { flexDirection: 'row' },
    bar: { height: 8, borderRadius: th.radii.pill, backgroundColor: th.colors.border, overflow: 'hidden' },
    fill: { height: 8, backgroundColor: th.colors.success },
    row: { flexDirection: 'row', gap: th.spacing.sm, flexWrap: 'wrap' },
    tags: { flexDirection: 'row', gap: th.spacing.xs },
  }));

  if (message.isLoading || summary.isLoading) return <Screen><Loading /></Screen>;
  if (!message.data || !summary.data) return <Screen><ErrorState message={t('common.loadFailed')} onRetry={() => { void summary.refetch(); }} /></Screen>;
  const m = message.data;
  const c = summary.data.whatsapp;
  // The summary is the fresh source; the message row may be the composer's cached draft.
  const status = summary.data.status as typeof m.status;
  const sentAt = summary.data.sentAt ?? summary.data.sendingStartedAt;
  const canRetry = wedding?.myRole !== 'desk_staff' && (failed.data?.length ?? 0) > 0;

  return (
    <Screen testID="screen-message-detail" footer={<Button label={t('common.back')} variant="secondary" onPress={onBack} testID="msg-detail-back" />}>
      <View style={s.tags}>
        <Tag label={t(`msg.status.${status}`)} tone={status === 'sent' ? 'success' : 'warning'} />
        {live === 'live' ? <Tag label={t('home.live')} tone="success" /> : null}
      </View>
      <Text variant="headline">{m.title || t('msg.untitled')}</Text>
      <Text tone="muted">{m.bodyText}</Text>
      {sentAt && wedding ? (
        <Text variant="caption" tone="muted">
          {t('msg.sentAt', { when: formatInZone(sentAt, wedding.timezone, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) })}
        </Text>
      ) : null}

      <Card>
        <Text variant="title">{t('msg.deliveredPct', { pct: summary.data.deliveredPct })}</Text>
        <View style={s.bar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: summary.data.deliveredPct }}>
          <View style={[s.fill, { width: `${summary.data.deliveredPct}%` }]} />
        </View>
        <View style={s.counts}>
          <Count label={t('msg.count.sent')} value={c.sent ?? 0} />
          <Count label={t('msg.count.delivered')} value={c.delivered ?? 0} testID="count-delivered" />
          <Count label={t('msg.count.read')} value={c.read ?? 0} />
          <Count label={t('msg.count.failed')} value={c.failed ?? 0} testID="count-failed" />
        </View>
        {(c.queued ?? 0) + (c.sending ?? 0) > 0 ? <Text tone="muted">{t('msg.stillSending', { count: (c.queued ?? 0) + (c.sending ?? 0) })}</Text> : null}
        {(c.unknown ?? 0) > 0 ? <Text variant="caption" tone="muted">{t('msg.unknownNote', { count: c.unknown ?? 0 })}</Text> : null}
      </Card>

      <SectionLabel>{t('msg.failures')}</SectionLabel>
      {failed.data?.length === 0 ? <EmptyState title={t('msg.noFailures')} /> : null}
      {(failed.data ?? []).map((d) => (
        <Card key={d.deliveryId}>
          <ListRow title={d.guestName} subtitle={`${d.partyLabel} · ${t(ERROR_KEY[d.errorLabel ?? ''] ?? 'msg.error.provider_error')}`} testID={`failed-${d.guestId}`} />
          {d.phone ? (
            <View style={s.row}>
              <Text variant="caption" tone="muted">
                {d.phone}
              </Text>
              {!d.phoneMasked ? (
                <>
                  <Button label={t('msg.call')} variant="secondary" onPress={() => { void Linking.openURL(`tel:${d.phone}`); }} />
                  <Button label="WhatsApp" variant="text" onPress={() => { void Linking.openURL(`https://wa.me/${d.phone!.replace(/\D/g, '')}`); }} />
                </>
              ) : null}
            </View>
          ) : null}
        </Card>
      ))}
      {canRetry ? <Button label={t('msg.retryFailed', { count: failed.data!.length })} onPress={() => retry.mutate()} loading={retry.isPending} testID="msg-retry" /> : null}
      {retry.isError ? <Text tone="danger">{t('msg.retryFailedError')}</Text> : null}
    </Screen>
  );
}
