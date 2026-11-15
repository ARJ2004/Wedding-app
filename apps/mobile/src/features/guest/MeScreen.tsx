import React from 'react';
import { useT } from '../../i18n/useT';
import { api } from '../../lib/api';
import { useGuestSession, useMode } from '../../lib/guest-session';
import { useSession } from '../../lib/session';
import { Button, Card, ListRow, Screen, SectionLabel, Text } from '../../ui';

export function GuestMeScreen() {
  const t = useT();
  const { session, signOut } = useGuestSession();
  const hostSignedIn = useSession((s) => s.status === 'signedIn');
  const setMode = useMode((s) => s.setMode);
  if (!session) return null;
  const withdraw = async () => {
    await api.DELETE('/v1/guest/consents/{purpose}', { params: { path: { purpose: 'core' } } });
    await signOut();
  };
  return (
    <Screen testID="screen-guest-me">
      <Text variant="headline">{session.guest.fullName}</Text>
      <Text tone="muted">{session.wedding.title}</Text>
      <SectionLabel>{t('me.party')}</SectionLabel>
      <Card>
        <Text variant="bodyStrong">{session.party.label}</Text>
        {session.party.members.map((m) => (
          <ListRow key={m.id} title={m.fullName} subtitle={m.isPrimary ? '★' : undefined} />
        ))}
      </Card>
      {hostSignedIn ? <Button label={t('me.switchToHost')} variant="secondary" onPress={() => setMode('host')} /> : null}
      <SectionLabel>{t('me.privacy')}</SectionLabel>
      <Button label={t('me.withdraw')} variant="text" onPress={() => { void withdraw(); }} />
      <Button label={t('me.signOut')} variant="secondary" onPress={() => { void signOut(); }} testID="guest-sign-out" />
    </Screen>
  );
}
