import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useEffect, useMemo } from 'react';
import { WelcomeScreen } from '../features/auth-host';
import { EventsScreen } from '../features/events';
import { GuestEntryScreen } from '../features/guest-entry';
import { GuestsScreen, ImportScreen } from '../features/guests';
import { MoreScreen } from '../features/settings';
import { CreateWeddingScreen, HostHomeScreen, WeddingPickerScreen } from '../features/weddings';
import { useT } from '../i18n/useT';
import { useSession } from '../lib/session';
import { useTheme } from '../theme/ThemeProvider';
import { Loading, Screen, Text } from '../ui';

type WelcomeStack = { Welcome: undefined; GuestEntry: undefined };
type PickerStack = { Picker: undefined; CreateWedding: undefined };
type HostTabs = { Home: undefined; Events: undefined; Guests: undefined; More: undefined };
type GuestsStack = { GuestList: undefined; Import: undefined };

const Welcome = createNativeStackNavigator<WelcomeStack>();
const Picker = createNativeStackNavigator<PickerStack>();
const Tabs = createBottomTabNavigator<HostTabs>();
const Guests = createNativeStackNavigator<GuestsStack>();

function GuestsNavigator() {
  return (
    <Guests.Navigator screenOptions={{ headerShown: false }}>
      <Guests.Screen name="GuestList">{({ navigation }) => <GuestsScreen onImport={() => navigation.navigate('Import')} />}</Guests.Screen>
      <Guests.Screen name="Import">{({ navigation }) => <ImportScreen onDone={() => navigation.goBack()} />}</Guests.Screen>
    </Guests.Navigator>
  );
}

const TAB_GLYPH: Record<keyof HostTabs, string> = { Home: '⌂', Events: '◷', Guests: '☺', More: '≡' };

function WelcomeNavigator() {
  return (
    <Welcome.Navigator screenOptions={{ headerShown: false }}>
      <Welcome.Screen name="Welcome">{({ navigation }) => <WelcomeScreen onGuest={() => navigation.navigate('GuestEntry')} />}</Welcome.Screen>
      <Welcome.Screen name="GuestEntry">{({ navigation }) => <GuestEntryScreen onBack={() => navigation.goBack()} />}</Welcome.Screen>
    </Welcome.Navigator>
  );
}

function PickerNavigator() {
  return (
    <Picker.Navigator screenOptions={{ headerShown: false }}>
      <Picker.Screen name="Picker">{({ navigation }) => <WeddingPickerScreen onCreate={() => navigation.navigate('CreateWedding')} />}</Picker.Screen>
      <Picker.Screen name="CreateWedding">{({ navigation }) => <CreateWeddingScreen onDone={() => navigation.popToTop()} />}</Picker.Screen>
    </Picker.Navigator>
  );
}

/** Host mode tabs (25-app §6). Desk-staff tab set arrives with ARR (S6). */
function HostNavigator() {
  const t = useT();
  const theme = useTheme();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border, minHeight: theme.minTouchTarget + 12 },
        tabBarLabelStyle: { fontSize: theme.type.caption.fontSize },
        tabBarIcon: ({ color }) => (
          <Text variant="title" style={{ color }}>
            {TAB_GLYPH[route.name]}
          </Text>
        ),
      })}
    >
      <Tabs.Screen name="Home" component={HostHomeScreen} options={{ title: t('tabs.home'), tabBarButtonTestID: 'tab-home' }} />
      <Tabs.Screen name="Events" component={EventsScreen} options={{ title: t('tabs.events'), tabBarButtonTestID: 'tab-events' }} />
      <Tabs.Screen name="Guests" component={GuestsNavigator} options={{ title: t('tabs.guests'), tabBarButtonTestID: 'tab-guests' }} />
      <Tabs.Screen name="More" component={MoreScreen} options={{ title: t('tabs.more'), tabBarButtonTestID: 'tab-more' }} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const theme = useTheme();
  const { status, weddingId, restore } = useSession();
  useEffect(() => {
    void restore();
  }, [restore]);

  const navTheme: NavTheme = useMemo(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.primary,
        background: theme.colors.background,
        card: theme.colors.surface,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.accent,
      },
    };
  }, [theme]);

  if (status === 'loading') {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }
  return (
    <NavigationContainer theme={navTheme}>
      {status === 'signedOut' ? <WelcomeNavigator /> : weddingId ? <HostNavigator /> : <PickerNavigator />}
    </NavigationContainer>
  );
}
