import React, { useState } from 'react';
import { View } from 'react-native';
import { useT } from '../../i18n/useT';
import { config } from '../../lib/config';
import { googleAvailable, googleIdToken } from '../../lib/google';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Screen, Text, TextField } from '../../ui';

export function WelcomeScreen({ onGuest }: { onGuest: () => void }) {
  const t = useT();
  const { signIn, error } = useSession();
  const [email, setEmail] = useState('owner@mehfil.local');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const s = useStyles((th) => ({
    hero: { paddingVertical: th.spacing.xxl, gap: th.spacing.sm },
    mark: {
      width: 64,
      height: 64,
      borderRadius: th.radii.lg,
      backgroundColor: th.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }));

  const run = async (getToken: () => Promise<string>) => {
    setBusy(true);
    setLocalError(null);
    try {
      await signIn(await getToken());
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="screen-welcome">
      <View style={s.hero}>
        <View style={s.mark}>
          <Text variant="headline" tone="onPrimary">
            M
          </Text>
        </View>
        <Text variant="headline">{t('app.name')}</Text>
        <Text tone="muted">{t('app.tagline')}</Text>
      </View>

      <Card>
        <Text variant="title">{t('welcome.hostTitle')}</Text>
        <Button
          label={t('host.signIn.google')}
          icon="G"
          onPress={() => run(googleIdToken)}
          disabled={!googleAvailable() || busy}
          testID="google-sign-in"
        />
        {!googleAvailable() ? (
          <Text variant="caption" tone="muted">
            {t('welcome.googleUnavailable')}
          </Text>
        ) : null}
        {config.showDevSignIn ? (
          <>
            <TextField
              label={t('welcome.devEmail')}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              testID="dev-email"
            />
            <Button
              label={t('welcome.devButton')}
              variant="secondary"
              loading={busy}
              onPress={() => run(async () => `dev:${email.trim()}`)}
              testID="dev-sign-in"
            />
          </>
        ) : null}
        {error || localError ? (
          <Text tone="danger" accessibilityLiveRegion="polite">
            {error ?? localError}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="title">{t('welcome.guestTitle')}</Text>
        <Text tone="muted">{t('welcome.guestBody')}</Text>
        <Button label={t('welcome.guestButton')} variant="secondary" onPress={onGuest} testID="guest-entry" />
      </Card>
    </Screen>
  );
}
