import React, { useState } from 'react';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { Button, Chip, ChipRow, EmptyState, ErrorState, Loading, Screen, Text, TextField } from '../../ui';
import { useGroups, useParties } from './hooks';
import { PartyRow } from './PartyRow';

export function GuestsScreen({ onImport }: { onImport?: () => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const [q, setQ] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const groups = useGroups(weddingId);
  const parties = useParties(weddingId, q.trim(), groupId);

  return (
    <Screen testID="screen-guests" footer={onImport ? <Button label={t('guests.import')} variant="secondary" onPress={onImport} testID="open-import" /> : undefined}>
      <Text variant="headline">{t('guests.title')}</Text>
      <TextField label={t('guests.search')} value={q} onChangeText={setQ} autoCorrect={false} testID="guest-search" />
      <ChipRow>
        <Chip label={t('guests.all')} selected={groupId === null} onPress={() => setGroupId(null)} />
        {(groups.data ?? []).map((g) => (
          <Chip key={g.id} label={`${g.name} · ${g.partyCount}`} selected={groupId === g.id} onPress={() => setGroupId(g.id)} />
        ))}
      </ChipRow>
      {parties.isLoading ? <Loading /> : null}
      {parties.error ? <ErrorState message={(parties.error as Error).message} onRetry={() => { void parties.refetch(); }} /> : null}
      {parties.data && parties.data.items.length === 0 ? <EmptyState title={t('guests.empty')} /> : null}
      {parties.data?.items.map((p) => <PartyRow key={p.id} party={p} />)}
    </Screen>
  );
}
