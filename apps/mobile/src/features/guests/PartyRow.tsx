import type { Party } from '@mehfil/api-client';
import React from 'react';
import { View } from 'react-native';
import { useT } from '../../i18n/useT';
import { useStyles } from '../../theme/ThemeProvider';
import { Tag, Text } from '../../ui';

/** One invite. Phone tags appear only when the API sent phone fields (never for desk staff). */
export function PartyRow({ party }: { party: Party }) {
  const t = useT();
  const s = useStyles((th) => ({
    row: { paddingVertical: th.spacing.md, borderBottomWidth: 1, borderBottomColor: th.colors.border, gap: th.spacing.xs },
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: th.spacing.xs },
  }));
  const phoneIssues = party.members.filter((m) => m.phoneStatus === 'invalid').length;
  const noPhone = party.members.filter((m) => m.phoneStatus === 'missing' && m.ageBand !== 'child').length;
  return (
    <View style={s.row} testID={`party-${party.label}`}>
      <Text variant="bodyStrong">{party.label}</Text>
      <Text variant="caption" tone="muted">
        {party.members.map((m) => m.fullName).join(', ')}
      </Text>
      <View style={s.tags}>
        <Tag label={t('guests.members', { count: party.members.length })} />
        {party.isOutstation ? <Tag label={t('guests.outstation')} tone="primary" /> : null}
        {phoneIssues ? <Tag label={t('guests.badPhone')} tone="danger" /> : null}
        {noPhone ? <Tag label={t('guests.noPhone')} tone="warning" /> : null}
      </View>
    </View>
  );
}
