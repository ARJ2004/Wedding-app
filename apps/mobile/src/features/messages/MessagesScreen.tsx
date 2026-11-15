import { can } from '@mehfil/domain';
import React from 'react';
import { formatInZone, useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { Button, EmptyState, ErrorState, ListRow, Loading, Screen, SectionLabel, Tag, Text } from '../../ui';
import { useWedding } from '../weddings';
import { useMessages, type Message } from './hooks';

const TONE: Record<Message['status'], 'neutral' | 'success' | 'warning' | 'danger' | 'primary'> = {
  draft: 'neutral',
  scheduled: 'primary',
  resolving: 'warning',
  sending: 'warning',
  sent: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

/** "52 of 70 delivered" from the stats the worker keeps on the message. */
function deliveredLine(m: Message, t: ReturnType<typeof useT>) {
  const c = (m.stats as { whatsapp?: Record<string, number> }).whatsapp;
  if (!c) return null;
  const total = Object.entries(c).reduce((n, [k, v]) => (k === 'cancelled' ? n : n + v), 0);
  return total ? t('msg.deliveredOf', { done: (c.delivered ?? 0) + (c.read ?? 0), total }) : null;
}

/** Host Messages list (MSG-03): drafts first, then everything sent, newest first. */
export function MessagesScreen({ onCompose, onOpen }: { onCompose: () => void; onOpen: (id: string, draft: boolean) => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const wedding = useWedding(weddingId).data;
  const messages = useMessages(weddingId);
  const canSend = wedding ? can(wedding.myRole, 'message.send') : false;

  return (
    <Screen testID="screen-messages" footer={canSend ? <Button label={t('msg.new')} onPress={onCompose} testID="msg-new" /> : undefined}>
      <Text variant="headline">{t('msg.title')}</Text>
      <Text tone="muted">{t('msg.subtitle')}</Text>
      {messages.isLoading ? <Loading /> : null}
      {messages.isError ? <ErrorState message={t('common.loadFailed')} onRetry={() => { void messages.refetch(); }} /> : null}
      {messages.data?.length === 0 ? <EmptyState title={t('msg.empty')} body={t('msg.emptyBody')} /> : null}
      {messages.data?.length ? <SectionLabel>{t('msg.recent')}</SectionLabel> : null}
      {(messages.data ?? []).map((m) => (
        <ListRow
          key={m.id}
          testID={`msg-row-${m.id}`}
          title={m.title || m.bodyText || t('msg.untitled')}
          subtitle={[
            wedding ? formatInZone(m.updatedAt, wedding.timezone, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null,
            deliveredLine(m, t),
          ]
            .filter(Boolean)
            .join(' · ')}
          trailing={<Tag label={t(`msg.status.${m.status}`)} tone={TONE[m.status]} />}
          onPress={() => onOpen(m.id, m.status === 'draft')}
        />
      ))}
    </Screen>
  );
}
