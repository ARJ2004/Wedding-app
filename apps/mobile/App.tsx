import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import React, { useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PERSIST_MAX_AGE, persister, queryClient } from './src/lib/api';
import { initKv } from './src/lib/kv';
import { startOutbox, useOutbox } from './src/lib/outbox';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

function ThemedStatusBar() {
  const t = useTheme();
  return <StatusBar barStyle={t.scheme === 'dark' ? 'light-content' : 'dark-content'} />;
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void initKv().then(() => setReady(true));
  }, []);
  return ready ? <AppReady /> : null;
}

function AppReady() {
  useEffect(() => {
    // After a queued write lands, refetch so screens show the server's truth.
    useOutbox.setState({ onApplied: () => { void queryClient.invalidateQueries(); } });
    return startOutbox();
  }, []);
  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST_MAX_AGE,
          dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' && q.meta?.persist === true },
        }}
      >
        <ThemeProvider>
          <ThemedStatusBar />
          <RootNavigator />
        </ThemeProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
