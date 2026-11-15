import React from 'react';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { Button, Card, EmptyState, ErrorState, Loading, Screen, Tag, Text } from '../../ui';
import { useWeddings } from './hooks';

export function WeddingPickerScreen({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  const select = useSession((s) => s.selectWedding);
  const { data, isLoading, error, refetch } = useWeddings();

  return (
    <Screen testID="screen-wedding-picker" footer={<Button label={t('picker.create')} onPress={onCreate} testID="create-wedding" />}>
      <Text variant="headline">{t('picker.title')}</Text>
      {isLoading ? <Loading /> : null}
      {error ? <ErrorState message={(error as Error).message} onRetry={() => { void refetch(); }} /> : null}
      {data && data.length === 0 ? <EmptyState title={t('picker.empty')} body={t('picker.emptyBody')} /> : null}
      {data?.map((w) => (
        <Card key={w.id} onPress={() => select(w.id)} accessibilityLabel={w.title} testID={`wedding-${w.title}`}>
          <Text variant="title">{w.title}</Text>
          <Tag label={t(`role.${w.role}`)} tone={w.role === 'owner' ? 'primary' : 'neutral'} />
        </Card>
      ))}
    </Screen>
  );
}
