import { PALETTES, PALETTE_NAMES } from '@mehfil/design-tokens';
import React from 'react';
import { View } from 'react-native';
import { useT } from '../../i18n/useT';
import { useSession } from '../../lib/session';
import { useStyles } from '../../theme/ThemeProvider';
import { defaultPalette, useAppearance, type SchemePreference } from '../../theme/preferences';
import { Button, Card, Chip, ChipRow, Screen, SectionLabel, Text, ToggleRow } from '../../ui';

function Swatches({ name }: { name: (typeof PALETTE_NAMES)[number] }) {
  const p = PALETTES[name].light;
  const s = useStyles((t) => ({
    row: { flexDirection: 'row', gap: t.spacing.xs },
    dot: { width: 20, height: 20, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.colors.border },
  }));
  return (
    <View style={s.row}>
      {[p.primary, p.accent, p.background].map((c) => (
        <View key={c} style={[s.dot, { backgroundColor: c }]} />
      ))}
    </View>
  );
}

export function MoreScreen() {
  const t = useT();
  const { user, signOut, selectWedding } = useSession();
  const appearance = useAppearance();
  const current = appearance.palette ?? defaultPalette();
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
        <Card key={name} onPress={() => appearance.set({ palette: name })} accessibilityLabel={PALETTES[name].label} testID={`palette-${name}`}>
          <Text variant="bodyStrong" tone={current === name ? 'primary' : 'default'}>
            {current === name ? '● ' : ''}
            {PALETTES[name].label}
          </Text>
          <Text variant="caption" tone="muted">
            {PALETTES[name].description}
          </Text>
          <Swatches name={name} />
        </Card>
      ))}

      <SectionLabel>{t('more.wedding')}</SectionLabel>
      <Button label={t('more.switchWedding')} variant="secondary" onPress={() => selectWedding(null)} />
      <Button label={t('more.signOut')} variant="text" onPress={() => { void signOut(); }} testID="sign-out" />
    </Screen>
  );
}
