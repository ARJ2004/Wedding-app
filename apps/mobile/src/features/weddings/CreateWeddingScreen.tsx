import React, { useState } from 'react';
import { useT } from '../../i18n/useT';
import { ApiError } from '../../lib/api';
import { Button, Screen, Text, TextField } from '../../ui';
import { useCreateWedding } from './hooks';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function CreateWeddingScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const create = useCreateWedding();
  const [form, setForm] = useState({ title: '', partnerOneName: '', partnerTwoName: '', startsOn: '', endsOn: '', cities: '' });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dateError = (v: string) => (v && !DATE.test(v) ? 'Use YYYY-MM-DD' : null);
  const valid = form.title.trim().length >= 2 && DATE.test(form.startsOn) && DATE.test(form.endsOn);
  const apiError = create.error instanceof ApiError ? create.error.message : create.error ? 'Could not create the wedding' : null;

  const submit = () =>
    create.mutate(
      {
        title: form.title.trim(),
        partnerOneName: form.partnerOneName.trim() || undefined,
        partnerTwoName: form.partnerTwoName.trim() || undefined,
        startsOn: form.startsOn,
        endsOn: form.endsOn,
        timezone: 'Asia/Kolkata',
        cities: form.cities.split(',').map((c) => c.trim()).filter(Boolean),
      },
      { onSuccess: onDone },
    );

  return (
    <Screen
      testID="screen-create-wedding"
      footer={<Button label={t('create.submit')} onPress={submit} disabled={!valid} loading={create.isPending} testID="submit-wedding" />}
    >
      <Text variant="headline">{t('create.title')}</Text>
      <TextField label={t('create.coupleTitle')} hint={t('create.coupleHint')} value={form.title} onChangeText={set('title')} testID="f-title" />
      <TextField label={t('create.partnerOne')} value={form.partnerOneName} onChangeText={set('partnerOneName')} />
      <TextField label={t('create.partnerTwo')} value={form.partnerTwoName} onChangeText={set('partnerTwoName')} />
      <TextField label={t('create.startsOn')} value={form.startsOn} onChangeText={set('startsOn')} error={dateError(form.startsOn)} testID="f-start" />
      <TextField label={t('create.endsOn')} value={form.endsOn} onChangeText={set('endsOn')} error={dateError(form.endsOn)} testID="f-end" />
      <TextField label={t('create.cities')} value={form.cities} onChangeText={set('cities')} />
      {apiError ? <Text tone="danger">{apiError}</Text> : null}
    </Screen>
  );
}
