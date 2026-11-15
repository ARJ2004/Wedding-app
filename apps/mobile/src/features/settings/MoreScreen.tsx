import { PALETTE_NAMES } from '@mehfil/design-tokens';
import React from 'react';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { defaultPalette, useAppearance, type SchemePreference } from '../../theme/preferences';
import { PaletteCard } from '../../components';
import { Button, Card, Chip, ChipRow, Screen, SectionLabel, Text, ToggleRow } from '../../ui';

export function MoreScreen({ onWeddingSettings }: { onWeddingSettings?: () => void }) {
  const t = useT();
  const { user, signOut, selectWedding } = useSession();
  const appearance = useAppearance();
  const current = appearance.palette ?? appearance.weddingPalette ?? defaultPalette();
  const schemes: SchemePreference[] = ['system', 'light', 'dark'];

  return (
    <Screen testID="screen-more">
      <Text variant="headline">{t('more.title')}</Text>
      {user ? <Text tone="muted">{user.email}</Text> : null}

      <SectionLabel>{t('more.appearance')}</SectionLabel>
      <Card>
        <Text variant="bodyStrong">{t('more.scheme')}</Text>
        <ChipRow>
          {schemes.map((sc) => (
            <Chip key={sc} label={t(`more.scheme.${sc}`)} selected={appearance.scheme === sc} onPress={() => appearance.set({ scheme: sc })} testID={`scheme-${sc}`} />
          ))}
        </ChipRow>
        <ToggleRow title={t('more.largeText')} value={appearance.largeText} onChange={(v) => appearance.set({ largeText: v })} testID="toggle-large-text" />
        <ToggleRow title={t('more.highContrast')} value={appearance.highContrast} onChange={(v) => appearance.set({ highContrast: v })} />
      </Card>

      <SectionLabel>{t('more.palette')}</SectionLabel>
      {PALETTE_NAMES.map((name) => (
        <PaletteCard key={name} name={name} selected={current === name} onPress={() => appearance.set({ palette: name })} testID={`palette-${name}`} />
      ))}

      <SectionLabel>{t('more.wedding')}</SectionLabel>
      {onWeddingSettings ? <Button label={t('settings.title')} variant="secondary" onPress={onWeddingSettings} testID="open-wedding-settings" /> : null}
      <Button label={t('more.switchWedding')} variant="secondary" onPress={() => selectWedding(null)} />
      <Button label={t('more.signOut')} variant="text" onPress={() => { void signOut(); }} testID="sign-out" />
    </Screen>
  );
}
