import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useT } from '../../i18n/useT';
import { api, unwrap } from '../../lib/api';
import { parseInviteToken, useGuestSession, type LinkStart, type OtpChallenge } from '../../lib/guest-session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Screen, Text, TextField } from '../../ui';

/**
 * ACC-02a in the app: invite link → "Who are you?" → 6-digit code. The link alone shows only
 * first names and masked phones; everything else waits for the code (05-acc §2).
 */
export function GuestEntryFlow({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const { pendingToken, start, sendOtp, verify } = useGuestSession();
  const [link, setLink] = useState('');
  const [invite, setInvite] = useState<LinkStart | null>(null);
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useStyles((th) => ({ member: { gap: th.spacing.xs }, codeInput: { letterSpacing: 8 } }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const details = (e as { details?: { attemptsLeft?: number } }).details;
      setError(details?.attemptsLeft !== undefined ? `${(e as Error).message}. ${t('guestEntry.attemptsLeft', { count: details.attemptsLeft })}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (raw: string) =>
    run(async () => {
      const token = parseInviteToken(raw);
      if (!token) throw new Error(t('guestEntry.badLink'));
      setInvite(await start(token));
    });

  useEffect(() => {
    if (pendingToken && !invite) void open(pendingToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingToken]);

  if (challenge) {
    return (
      <Screen
        testID="screen-guest-otp"
        footer={<Button label={t('guestEntry.verify')} disabled={code.length !== 6} loading={busy} onPress={() => { void run(() => verify(challenge.challengeId, code)); }} testID="otp-verify" />}
      >
        <Text variant="headline">{t('guestEntry.codeTitle')}</Text>
        <Text tone="muted">{t('guest.otp.sent', { maskedPhone: challenge.maskedPhone })}</Text>
        {challenge.channel === 'dev' ? <Card><Text>{t('guestEntry.devHint')}</Text></Card> : null}
        <TextField
          label={t('guestEntry.codeLabel')}
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={6}
          autoFocus
          testID="otp-code"
        />
        {error ? <Text tone="danger" accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button label={t('guestEntry.resend')} variant="text" onPress={() => setChallenge(null)} />
      </Screen>
    );
  }

  if (invite) {
    return (
      <Screen testID="screen-guest-pick">
        <Text variant="caption" tone="muted">
          {invite.wedding.title}
        </Text>
        <Text variant="headline">{t('guestEntry.whoAreYou')}</Text>
        <Text tone="muted">{t('guestEntry.whoBody')}</Text>
        {invite.members.map((m) => (
          <Card
            key={m.guestId}
            onPress={m.canReceiveCode ? () => { void run(async () => setChallenge(await sendOtp(invite.linkTicket, m.guestId))); } : undefined}
            accessibilityLabel={m.firstName}
            testID={`pick-${m.firstName}`}
          >
            <View style={s.member}>
              <Text variant="title">{m.firstName}</Text>
              <Text variant="caption" tone="muted">
                {m.maskedPhone ?? t('guestEntry.noPhone')}
              </Text>
            </View>
          </Card>
        ))}
        {error ? <Text tone="danger">{error}</Text> : null}
        <Button label={t('common.cancel')} variant="text" onPress={onCancel} />
      </Screen>
    );
  }

  return (
    <Screen testID="screen-guest-entry" footer={<Button label={t('guestEntry.open')} disabled={!link.trim()} loading={busy} onPress={() => { void open(link); }} testID="open-invite" />}>
      <Text variant="headline">{t('guestEntry.title')}</Text>
      <Text tone="muted">{t('guestEntry.body')}</Text>
      <TextField label={t('guestEntry.paste')} value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} testID="invite-link" />
      {error ? <Text tone="danger">{error}</Text> : null}
      <Button label={t('common.cancel')} variant="text" onPress={onCancel} />
    </Screen>
  );
}

export function ConsentScreen() {
  const t = useT();
  const signOut = useGuestSession((st) => st.signOut);
  const setSession = useGuestSession((st) => st.setSession);
  const notice = useNotice();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (!notice) return;
    setBusy(true);
    try {
      setSession(unwrap(await api.PUT('/v1/guest/consents/{purpose}', { params: { path: { purpose: 'core' } }, body: { noticeVersion: notice.version, locale: 'en' } })));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="screen-consent" footer={<Button label={t('consent.accept')} loading={busy} disabled={!notice} onPress={() => { void accept(); }} testID="consent-accept" />}>
      <Text variant="headline">{notice?.title ?? ''}</Text>
      {notice?.bodyMd.split(/\n{2,}/).map((para, i) => <Markdownish key={i} text={para} />)}
      <Button label={t('consent.notNow')} variant="text" onPress={() => { void signOut(); }} />
    </Screen>
  );
}

/** Paragraphs with **bold** lead-ins: enough for the notice without a markdown library. */
function Markdownish({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text>
      {parts.map((p, i) => (p.startsWith('**') ? <Text key={i} variant="bodyStrong">{p.slice(2, -2)}</Text> : p))}
    </Text>
  );
}

function useNotice() {
  const [notice, setNotice] = useState<{ version: string; title: string; bodyMd: string } | null>(null);
  useEffect(() => {
    void (async () => {
      setNotice(unwrap(await api.GET('/v1/guest/privacy-notice', { params: { query: { locale: 'en' } } })));
    })();
  }, []);
  return notice;
}

