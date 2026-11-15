import { PALETTE_NAMES } from '@mehfil/design-tokens';
import type { MessageId } from '@mehfil/i18n';
import React, { useState } from 'react';
import { Image, View } from 'react-native';
import { PaletteCard } from '../../components';
import { useT } from '../../i18n/useT';
import { pickImage } from '../../lib/file-picker';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { Button, Card, Chip, ChipRow, ListRow, Loading, Screen, SectionLabel, Text, TextField } from '../../ui';
import { useWedding } from './hooks';
import { useAddContact, useContacts, useSetCover, useUpdateSettings, useWeddingSettings } from './settings-hooks';

const SHOT_LIMITS = [12, 24, 36, 50];
const REVEALS = ['instant', 'next_morning', 'after_wedding'] as const;
const LANGS = ['en', 'hi', 'kn'] as const;
const SIDES = ['both', 'bride', 'groom'] as const;

/** SET-05 + SET-06: cover, camera, guest language, wedding palette, key contacts. */
export function WeddingSettingsScreen({ onBack }: { onBack: () => void }) {
  const t = useT();
  const weddingId = useSession((s) => s.weddingId)!;
  const wedding = useWedding(weddingId);
  const settings = useWeddingSettings(weddingId);
  const update = useUpdateSettings(weddingId);
  const cover = useSetCover(weddingId);
  const contacts = useContacts(weddingId);
  const addContact = useAddContact(weddingId);
  const [draft, setDraft] = useState({ side: 'both' as (typeof SIDES)[number], label: '', name: '', phone: '' });
  const s = useStyles((th) => ({
    cover: { width: '100%', aspectRatio: 16 / 9, borderRadius: th.radii.md, backgroundColor: th.colors.border },
    coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  }));
  if (!settings.data || !wedding.data) return <Screen><Loading /></Screen>;
  const st = settings.data;
  const patch = (p: Record<string, unknown>) => update.mutate(p);

  const chooseCover = async () => {
    const file = await pickImage();
    if (file) cover.mutate(file);
  };

  return (
    <Screen testID="screen-wedding-settings" footer={<Button label={t('common.done')} variant="text" onPress={onBack} testID="settings-done" />}>
      <Text variant="headline">{t('settings.title')}</Text>

      <SectionLabel>{t('settings.cover')}</SectionLabel>
      {wedding.data.coverUrl ? (
        <Image source={{ uri: wedding.data.coverUrl }} style={s.cover} accessibilityLabel={t('settings.cover')} testID="cover-image" />
      ) : (
        <View style={[s.cover, s.coverEmpty]}>
          <Text tone="muted">{wedding.data.title}</Text>
        </View>
      )}
      <Button
        label={wedding.data.coverUrl ? t('settings.coverChange') : t('settings.coverPick')}
        variant="secondary"
        loading={cover.isPending}
        onPress={() => { void chooseCover(); }}
        testID="pick-cover"
      />
      {cover.error ? <Text tone="danger">{(cover.error as Error).message}</Text> : null}

      <SectionLabel>{t('settings.camera')}</SectionLabel>
      <Card>
        <Text variant="bodyStrong">{t('settings.shotLimit')}</Text>
        <ChipRow>
          {SHOT_LIMITS.map((n) => (
            <Chip key={n} label={String(n)} selected={st.camera.shotLimit === n} onPress={() => patch({ camera: { shotLimit: n } })} testID={`shots-${n}`} />
          ))}
        </ChipRow>
        <Text variant="bodyStrong">{t('settings.reveal')}</Text>
        <ChipRow>
          {REVEALS.map((r) => (
            <Chip key={r} label={t(`settings.reveal.${r}` as MessageId)} selected={st.camera.revealMode === r} onPress={() => patch({ camera: { revealMode: r } })} />
          ))}
        </ChipRow>
      </Card>

      <SectionLabel>{t('settings.language')}</SectionLabel>
      <ChipRow>
        {LANGS.map((l) => (
          <Chip key={l} label={t(`lang.${l}` as MessageId)} selected={st.language.default === l} onPress={() => patch({ language: { default: l } })} />
        ))}
      </ChipRow>

      <SectionLabel>{t('settings.palette')}</SectionLabel>
      <Text variant="caption" tone="muted">
        {t('settings.paletteBody')}
      </Text>
      {PALETTE_NAMES.map((name) => (
        <PaletteCard
          key={name}
          name={name}
          selected={(st.branding.palette ?? 'maroonMarigold') === name}
          onPress={() => patch({ branding: { palette: name } })}
          testID={`wedding-palette-${name}`}
        />
      ))}

      <SectionLabel>{t('contacts.title')}</SectionLabel>
      <Text variant="caption" tone="muted">
        {t('contacts.body')}
      </Text>
      {(contacts.data ?? []).map((c) => (
        <ListRow key={c.id} title={`${c.name} · ${c.label}`} subtitle={`${t(`contacts.side.${c.side}` as MessageId)} · ${c.phone}`} />
      ))}
      <Card>
        <ChipRow>
          {SIDES.map((side) => (
            <Chip key={side} label={t(`contacts.side.${side}` as MessageId)} selected={draft.side === side} onPress={() => setDraft((d) => ({ ...d, side }))} />
          ))}
        </ChipRow>
        <TextField label={t('contacts.label')} value={draft.label} onChangeText={(label) => setDraft((d) => ({ ...d, label }))} testID="contact-label" />
        <TextField label={t('contacts.name')} value={draft.name} onChangeText={(name) => setDraft((d) => ({ ...d, name }))} testID="contact-name" />
        <TextField label={t('contacts.phone')} value={draft.phone} keyboardType="phone-pad" onChangeText={(phone) => setDraft((d) => ({ ...d, phone }))} testID="contact-phone" />
        {addContact.error ? <Text tone="danger">{(addContact.error as Error).message}</Text> : null}
        <Button
          label={t('contacts.add')}
          disabled={!draft.label.trim() || !draft.name.trim() || draft.phone.trim().length < 5}
          loading={addContact.isPending}
          onPress={() => addContact.mutate(draft, { onSuccess: () => setDraft({ side: 'both', label: '', name: '', phone: '' }) })}
          testID="add-contact"
        />
      </Card>
    </Screen>
  );
}
