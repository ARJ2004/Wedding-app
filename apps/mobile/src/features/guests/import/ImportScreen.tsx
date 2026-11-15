import type { MessageId } from '@mehfil/i18n';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useT } from '../../../i18n/useT';
import { pickSpreadsheet } from '../../../lib/file-picker';
import { useSession } from '../../../lib/session';
import { useStyles } from '../../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, ListRow, Loading, Screen, SectionLabel, Tag, Text } from '../../../ui';
import { useCommitImport, useImport, useImportProblems, useStartImport, useSubmitMapping } from './hooks';

const FIELDS = ['ignore', 'fullName', 'phone', 'partyLabel', 'side', 'members', 'children', 'adults', 'city', 'email', 'relation', 'groups'] as const;
type Field = (typeof FIELDS)[number];

function Stat({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const s = useStyles((t) => ({ box: { flex: 1, minWidth: '45%', gap: t.spacing.xxs } }));
  return (
    <View style={s.box}>
      <Text variant="headline" tone={tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'default'}>
        {String(value)}
      </Text>
      <Tag label={label} tone={tone} />
    </View>
  );
}

/**
 * GST-02b: one screen that follows the import's server status:
 * pick → upload/parse → mapping → validate → preview → commit → done.
 */
export function ImportScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const [importId, setImportId] = useState<string | null>(null);
  const start = useStartImport(weddingId);
  const imp = useImport(weddingId, importId);
  const submit = useSubmitMapping(weddingId, importId ?? '');
  const commit = useCommitImport(weddingId, importId ?? '');
  const [columns, setColumns] = useState<Record<string, Field>>({});
  const status = imp.data?.status;
  const problems = useImportProblems(weddingId, importId ?? '', status === 'preview');
  const s = useStyles((th) => ({ stats: { flexDirection: 'row', flexWrap: 'wrap', gap: th.spacing.md } }));

  useEffect(() => {
    const suggested = imp.data?.suggestedMapping as { columns?: Record<string, Field> } | null | undefined;
    if (status === 'mapping' && suggested?.columns && Object.keys(columns).length === 0) setColumns(suggested.columns);
  }, [status, imp.data, columns]);

  const pickAndStart = async () => {
    const file = await pickSpreadsheet();
    if (!file) return;
    const res = await start.mutateAsync(file);
    setImportId(res.id);
  };

  const working = start.isPending || status === 'parsing' || status === 'validating' || status === 'committing';
  const workingLabel: MessageId = start.isPending
    ? 'import.uploading'
    : status === 'parsing'
      ? 'import.reading'
      : status === 'validating'
        ? 'import.checking'
        : 'import.saving';
  const errorText = (start.error as Error | null)?.message ?? (status === 'failed' ? t('import.failed', { code: imp.data?.errorCode ?? '' }) : null);
  const hasName = Object.values(columns).includes('fullName');
  const partyMode = (imp.data?.suggestedMapping as { partyMode?: 'row_is_party' | 'group_by_column' } | null)?.partyMode ?? 'row_is_party';
  const stats = imp.data?.stats;
  const toImport = stats ? stats.ok + stats.warnings : 0;

  return (
    <Screen
      testID="screen-import"
      footer={
        !importId || status === 'failed' ? (
          <Button label={t('import.pick')} onPress={() => { void pickAndStart(); }} loading={start.isPending} testID="import-pick" />
        ) : status === 'mapping' ? (
          <Button label={t('import.continue')} disabled={!hasName} loading={submit.isPending} onPress={() => submit.mutate({ columns, partyMode })} testID="import-continue" />
        ) : status === 'preview' ? (
          <Button label={t('import.commit', { count: toImport })} disabled={toImport === 0} loading={commit.isPending} onPress={() => commit.mutate()} testID="import-commit" />
        ) : status === 'done' ? (
          <Button label={t('import.back')} onPress={onDone} testID="import-back" />
        ) : undefined
      }
    >
      <Text variant="headline">{t('import.title')}</Text>
      {!importId ? <Text tone="muted">{t('import.intro')}</Text> : null}
      {errorText ? <Text tone="danger">{errorText}</Text> : null}

      {working ? (
        <Card>
          <Loading />
          <Text align="center" tone="muted">
            {t(workingLabel)}
          </Text>
        </Card>
      ) : null}

      {status === 'mapping' && imp.data ? (
        <>
          <Text variant="title">{t('import.mappingTitle')}</Text>
          <Text tone="muted">{t('import.mappingBody')}</Text>
          {imp.data.headers.map((h) => (
            <Card key={h} testID={`map-${h}`}>
              <Text variant="bodyStrong">{h}</Text>
              {imp.data!.sample[0]?.[h] ? (
                <Text variant="caption" tone="muted">
                  {t('import.sampleValue', { value: imp.data!.sample[0]![h]! })}
                </Text>
              ) : null}
              <ChipRow>
                {/* the current choice first, so it is always visible without scrolling */}
                {[columns[h] ?? 'ignore', ...FIELDS.filter((f) => f !== (columns[h] ?? 'ignore'))].map((f) => (
                  <Chip key={f} label={t(`field.${f}` as MessageId)} selected={(columns[h] ?? 'ignore') === f} onPress={() => setColumns((c) => ({ ...c, [h]: f }))} />
                ))}
              </ChipRow>
            </Card>
          ))}
          {!hasName ? <Text tone="danger">{t('import.needName')}</Text> : null}
        </>
      ) : null}

      {status === 'preview' && stats ? (
        <>
          <Text variant="title">{t('import.previewTitle')}</Text>
          <Card>
            <View style={s.stats}>
              <Stat label={t('import.ok')} value={stats.ok} tone="success" />
              <Stat label={t('import.warnings')} value={stats.warnings} tone="warning" />
              <Stat label={t('import.duplicates')} value={stats.duplicates} tone="neutral" />
              <Stat label={t('import.errors')} value={stats.errors} tone="danger" />
            </View>
          </Card>
          {problems.data && problems.data.length > 0 ? <SectionLabel>{t('import.problems')}</SectionLabel> : null}
          {problems.data?.map((r) => (
            <ListRow
              key={r.rowNumber}
              title={`${r.rowNumber}. ${r.fullName || t('issue.NAME_MISSING')}`}
              subtitle={r.issues.map((code) => t(`issue.${code}` as MessageId)).join(' · ') || t('import.duplicates')}
              trailing={<Tag label={r.action === 'skip' ? t('import.errors') : t('import.warnings')} tone={r.action === 'skip' ? 'danger' : 'warning'} />}
            />
          ))}
        </>
      ) : null}

      {status === 'done' && stats ? (
        <Card testID="import-done">
          <Text variant="title">{t('import.doneTitle')}</Text>
          <Text>{t('import.doneBody', { imported: stats.imported, skipped: stats.skipped })}</Text>
        </Card>
      ) : null}
    </Screen>
  );
}
