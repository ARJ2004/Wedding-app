import { can } from '@mehfil/domain';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, EmptyState, ErrorState, Loading, Screen, Text, TextField } from '../../ui';
import { useWedding } from '../weddings';
import { useAssignGroup, useCreateGroup, useExportGuests, useGroups, useParties } from './hooks';
import { PartyRow } from './PartyRow';

export function GuestsScreen({ onImport }: { onImport?: () => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const role = useWedding(weddingId).data?.myRole;
  const canWrite = role ? can(role, 'group.write') : false;
  const canExport = role ? can(role, 'guest.export') : false;
  const [q, setQ] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const groups = useGroups(weddingId);
  const parties = useParties(weddingId, q.trim(), groupId);
  const createGroup = useCreateGroup(weddingId);
  const assign = useAssignGroup(weddingId);
  const exportCsv = useExportGuests(weddingId);
  const s = useStyles((th) => ({
    actions: { flexDirection: 'row', gap: th.spacing.sm, flexWrap: 'wrap' },
    selectRow: { flexDirection: 'row', alignItems: 'center', gap: th.spacing.md },
    check: {
      width: 28,
      height: 28,
      borderRadius: th.radii.sm,
      borderWidth: 2,
      borderColor: th.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checked: { backgroundColor: th.colors.primary },
    rowBody: { flex: 1 },
  }));

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addSelectedTo = (gid: string, name: string) =>
    assign.mutate(
      { groupId: gid, partyIds: [...selected] },
      {
        onSuccess: () => {
          setNotice(t('guests.added', { group: name }));
          setSelected(new Set());
          setSelecting(false);
        },
      },
    );

  const footer = selecting ? (
    <View>
      <Text variant="bodyStrong">{t('guests.selected', { count: selected.size })}</Text>
      <Text variant="caption" tone="muted">
        {t('guests.addToGroup')}
      </Text>
      <ChipRow>
        {(groups.data ?? []).map((g) => (
          <Chip key={g.id} label={g.name} onPress={selected.size ? () => addSelectedTo(g.id, g.name) : undefined} testID={`assign-${g.name}`} />
        ))}
      </ChipRow>
    </View>
  ) : onImport && canWrite ? (
    <Button label={t('guests.import')} variant="secondary" onPress={onImport} testID="open-import" />
  ) : undefined;

  return (
    <Screen testID="screen-guests" footer={footer}>
      <Text variant="headline">{t('guests.title')}</Text>
      <View style={s.actions}>
        {canWrite ? (
          <Chip
            label={selecting ? t('guests.doneSelecting') : t('guests.select')}
            selected={selecting}
            onPress={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
            testID="toggle-select"
          />
        ) : null}
        {canExport ? <Chip label={t('guests.export')} onPress={() => exportCsv.mutate()} testID="export-csv" /> : null}
      </View>
      {notice ? <Text tone="success">{notice}</Text> : null}
      <TextField label={t('guests.search')} value={q} onChangeText={setQ} autoCorrect={false} testID="guest-search" />
      <ChipRow>
        <Chip label={t('guests.all')} selected={groupId === null} onPress={() => setGroupId(null)} />
        {(groups.data ?? []).map((g) => (
          <Chip key={g.id} label={`${g.name} · ${g.partyCount}`} selected={groupId === g.id} onPress={() => setGroupId(g.id)} />
        ))}
        {canWrite ? <Chip label={t('guests.newGroup')} onPress={() => setNewGroup('')} testID="new-group" /> : null}
      </ChipRow>
      {newGroup !== null ? (
        <Card>
          <TextField label={t('guests.groupName')} value={newGroup} onChangeText={setNewGroup} autoFocus testID="group-name" />
          <Button
            label={t('guests.createGroup')}
            disabled={!newGroup.trim()}
            loading={createGroup.isPending}
            onPress={() => createGroup.mutate(newGroup.trim(), { onSuccess: () => setNewGroup(null) })}
            testID="create-group"
          />
          {createGroup.error ? <Text tone="danger">{(createGroup.error as Error).message}</Text> : null}
          <Button label={t('common.cancel')} variant="text" onPress={() => setNewGroup(null)} />
        </Card>
      ) : null}
      {parties.isLoading ? <Loading /> : null}
      {parties.error ? <ErrorState message={(parties.error as Error).message} onRetry={() => { void parties.refetch(); }} /> : null}
      {parties.data && parties.data.items.length === 0 ? <EmptyState title={t('guests.empty')} /> : null}
      {parties.data?.items.map((p) =>
        selecting ? (
          <Pressable
            key={p.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected.has(p.id) }}
            accessibilityLabel={p.label}
            onPress={() => toggle(p.id)}
            style={s.selectRow}
            testID={`select-${p.label}`}
          >
            <View style={[s.check, selected.has(p.id) && s.checked]}>{selected.has(p.id) ? <Text tone="onPrimary">✓</Text> : null}</View>
            <View style={s.rowBody}>
              <PartyRow party={p} />
            </View>
          </Pressable>
        ) : (
          <PartyRow key={p.id} party={p} />
        ),
      )}
    </Screen>
  );
}
