import React, { useState } from 'react';
import { useT } from '../../i18n/useT';
import { Button, Card, Screen, Text, TextField } from '../../ui';

/** Placeholder until ACC-01/02a (S4): link + OTP open Guest mode. */
export function GuestEntryScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [link, setLink] = useState('');
  return (
    <Screen testID="screen-guest-entry">
      <Text variant="headline">{t('guestEntry.title')}</Text>
      <Text tone="muted">{t('guestEntry.body')}</Text>
      <TextField label={t('guestEntry.paste')} value={link} onChangeText={setLink} autoCapitalize="none" />
      <Card>
        <Text>{t('guestEntry.comingSoon')}</Text>
      </Card>
      <Button label={t('common.cancel')} variant="text" onPress={onBack} />
    </Screen>
  );
}
