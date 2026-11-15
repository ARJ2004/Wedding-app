import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStyles } from '../theme/ThemeProvider';

interface Props {
  children: React.ReactNode;
  scroll?: boolean;
  /** Pinned under the content, e.g. a primary action. */
  footer?: React.ReactNode;
  testID?: string;
}

export function Screen({ children, scroll = true, footer, testID }: Props) {
  const s = useStyles((t) => ({
    safe: { flex: 1, backgroundColor: t.colors.background },
    content: { padding: t.spacing.lg, gap: t.spacing.md, flexGrow: 1 },
    footer: { padding: t.spacing.lg, borderTopWidth: 1, borderTopColor: t.colors.border, backgroundColor: t.colors.surface },
  }));
  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']} testID={testID}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={s.content}>{children}</View>
      )}
      {footer ? <View style={s.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}
