import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useEffect, useMemo } from 'react';
import { Linking } from 'react-native';
import { WelcomeScreen } from '../features/auth-host';
import { EventsScreen } from '../features/events';
import { ConsentScreen, GuestEntryFlow, GuestHomeScreen, GuestMeScreen, RsvpScreen } from '../features/guest';
import { GuestsScreen, ImportScreen } from '../features/guests';
import { ComposerScreen, MessagesScreen } from '../features/messages';
import { can } from '@mehfil/domain';
import { MoreScreen } from '../features/settings';
import { CreateWeddingScreen, HostHomeScreen, useApplyWeddingPalette, useWedding, WeddingPickerScreen, WeddingSettingsScreen } from '../features/weddings';
import { useT } from '../i18n/useT';
import { parseInviteToken, useGuestSession, useMode } from '../lib/guest-session';
import { useSession } from '../lib/session';
import { useTheme } from '../theme/ThemeProvider';
import { Loading, Screen, Text } from '../ui';

type WelcomeStack = { Welcome: undefined };
type GuestTabsList = { GuestHome: undefined; Rsvp: undefined; Me: undefined };
type PickerStack = { Picker: undefined; CreateWedding: undefined };
type HostTabs = { Home: undefined; Events: undefined; Guests: undefined; Messages: undefined; More: undefined };
type MessagesStack = { MessageList: undefined; Composer: { messageId: string | null } };
type GuestsStack = { GuestList: undefined; Import: undefined };
type MoreStack = { MoreHome: undefined; WeddingSettings: undefined };

const Welcome = createNativeStackNavigator<WelcomeStack>();
const Picker = createNativeStackNavigator<PickerStack>();
const Tabs = createBottomTabNavigator<HostTabs>();
const Guests = createNativeStackNavigator<GuestsStack>();
const More = createNativeStackNavigator<MoreStack>();
const Msgs = createNativeStackNavigator<MessagesStack>();

function MessagesNavigator() {
  return (
    <Msgs.Navigator screenOptions={{ headerShown: false }}>
      <Msgs.Screen name="MessageList">
        {({ navigation }) => <MessagesScreen onCompose={() => navigation.navigate('Composer', { messageId: null })} onOpen={(id) => navigation.navigate('Composer', { messageId: id })} />}
      </Msgs.Screen>
      <Msgs.Screen name="Composer">{({ navigation, route }) => <ComposerScreen messageId={route.params.messageId} onDone={() => navigation.goBack()} />}</Msgs.Screen>
    </Msgs.Navigator>
  );
}

function MoreNavigator() {
  return (
    <More.Navigator screenOptions={{ headerShown: false }}>
      <More.Screen name="MoreHome">{({ navigation }) => <MoreScreen onWeddingSettings={() => navigation.navigate('WeddingSettings')} />}</More.Screen>
      <More.Screen name="WeddingSettings">{({ navigation }) => <WeddingSettingsScreen onBack={() => navigation.goBack()} />}</More.Screen>
    </More.Navigator>
  );
}

function GuestsNavigator() {
  return (
    <Guests.Navigator screenOptions={{ headerShown: false }}>
      <Guests.Screen name="GuestList">{({ navigation }) => <GuestsScreen onImport={() => navigation.navigate('Import')} />}</Guests.Screen>
      <Guests.Screen name="Import">{({ navigation }) => <ImportScreen onDone={() => navigation.goBack()} />}</Guests.Screen>
    </Guests.Navigator>
  );
}

const TAB_GLYPH: Record<keyof HostTabs, string> = { Home: '⌂', Events: '◷', Guests: '☺', Messages: '✉', More: '≡' };

const GuestTabs = createBottomTabNavigator<GuestTabsList>();
const GUEST_GLYPH: Record<keyof GuestTabsList, string> = { GuestHome: '⌂', Rsvp: '✓', Me: '☺' };

function WelcomeNavigator() {
  const setMode = useMode((st) => st.setMode);
  return (
    <Welcome.Navigator screenOptions={{ headerShown: false }}>
      <Welcome.Screen name="Welcome">{() => <WelcomeScreen onGuest={() => setMode('guest')} />}</Welcome.Screen>
    </Welcome.Navigator>
  );
}

/**
 * Guest mode (25-app §6). Tabs are Home · RSVP · Me until Travel (S6), Camera and Photos (S7)
 * exist; the final guest tab set is an open product decision.
 */
function GuestNavigator() {
  const t = useT();
  const theme = useTheme();
  return (
    <GuestTabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border, minHeight: theme.minTouchTarget + 16 },
        tabBarLabelStyle: { fontSize: theme.type.body.fontSize },
        tabBarIcon: ({ color }) => (
          <Text variant="title" style={{ color }}>
            {GUEST_GLYPH[route.name]}
          </Text>
        ),
      })}
    >
      <GuestTabs.Screen name="GuestHome" options={{ title: t('guestTabs.home'), tabBarButtonTestID: 'gtab-home' }}>
        {({ navigation }) => <GuestHomeScreen onRsvp={() => navigation.navigate('Rsvp')} />}
      </GuestTabs.Screen>
      <GuestTabs.Screen name="Rsvp" component={RsvpScreen} options={{ title: t('guestTabs.rsvp'), tabBarButtonTestID: 'gtab-rsvp' }} />
      <GuestTabs.Screen name="Me" component={GuestMeScreen} options={{ title: t('guestTabs.me'), tabBarButtonTestID: 'gtab-me' }} />
    </GuestTabs.Navigator>
  );
}

/** Invite links (https://mehfil.app/g/<token>) open Guest mode: on launch and while running. */
function useInviteLinks() {
  const setPendingToken = useGuestSession((st) => st.setPendingToken);
  const setMode = useMode((st) => st.setMode);
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      const token = url && /\/g\//.test(url) ? parseInviteToken(url) : null;
      if (token) {
        setPendingToken(token);
        setMode('guest');
      }
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [setPendingToken, setMode]);
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
  const weddingId = useSession((st) => st.weddingId)!;
  useApplyWeddingPalette(weddingId);
  const role = useWedding(weddingId).data?.myRole;
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
      {role && can(role, 'message.read') ? (
        <Tabs.Screen name="Messages" component={MessagesNavigator} options={{ title: t('tabs.messages'), tabBarButtonTestID: 'tab-messages' }} />
      ) : null}
      <Tabs.Screen name="More" component={MoreNavigator} options={{ title: t('tabs.more'), tabBarButtonTestID: 'tab-more' }} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const theme = useTheme();
  const { status, weddingId, restore } = useSession();
  const guest = useGuestSession();
  const { mode, setMode } = useMode();
  useInviteLinks();
  useEffect(() => {
    void restore();
    void guest.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore]);
  // A phone with only a guest session opens straight into Guest mode.
  useEffect(() => {
    if (status === 'signedOut' && guest.status === 'signedIn') setMode('guest');
  }, [status, guest.status, setMode]);

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

  if (status === 'loading' || guest.status === 'loading') {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }
  return (
    <NavigationContainer theme={navTheme}>
      {mode === 'guest' ? (
        guest.status === 'signedIn' && guest.session ? (
          guest.session.consentNeeded.length ? <ConsentScreen /> : <GuestNavigator />
        ) : (
          <GuestEntryFlow
            onCancel={() => {
              guest.setPendingToken(null);
              setMode('host');
            }}
          />
        )
      ) : status === 'signedOut' ? (
        <WelcomeNavigator />
      ) : weddingId ? (
        <HostNavigator />
      ) : (
        <PickerNavigator />
      )}
    </NavigationContainer>
  );
}
