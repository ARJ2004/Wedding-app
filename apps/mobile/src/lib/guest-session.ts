import type { components } from '@mehfil/api-client';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { config } from './config';
import { installId } from './install-id';
import { secureStore } from './secure-store';

export type GuestSession = components['schemas']['GuestSession'];
type GuestAuth = components['schemas']['GuestAuthResponse'];
export type LinkStart = components['schemas']['GuestLinkStart'];
export type OtpChallenge = components['schemas']['OtpChallenge'];

type Status = 'loading' | 'none' | 'signedIn';

interface State {
  status: Status;
  accessToken: string | null;
  session: GuestSession | null;
  /** Invite token from a deep link / pasted link, waiting for the member picker. */
  pendingToken: string | null;
  restore(): Promise<void>;
  setPendingToken(t: string | null): void;
  start(token: string): Promise<LinkStart>;
  sendOtp(linkTicket: string, guestId: string): Promise<OtpChallenge>;
  verify(challengeId: string, code: string): Promise<void>;
  refresh(): Promise<string | null>;
  setSession(s: GuestSession): void;
  signOut(): Promise<void>;
}

let refreshToken: string | null = null;

const platform = (): 'android' | 'ios' | 'web' => (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web');

/** Throws the API's own message so screens can show it as-is ("That code didn't match"). */
async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw Object.assign(new Error(e?.message ?? 'Something went wrong'), { code: e?.code, details: e?.details });
  }
  return data as T;
}

/** Extracts the invite token from "https://mehfil.app/g/<token>", "/g/<token>" or a bare token. */
export function parseInviteToken(input: string): string | null {
  const m = /(?:\/g\/)?([A-Za-z0-9_-]{22})(?:[/?#]|$)/.exec(input.trim());
  return m ? m[1]! : null;
}

/**
 * Guest identity (ACC, APP-01b): kept apart from the host session so one phone can hold both
 * (a planner's own invite, a family phone). Refresh token in its own keychain entry.
 */
export const useGuestSession = create<State>((set, get) => {
  let inflight: Promise<string | null> | null = null;

  const accept = async (auth: GuestAuth) => {
    refreshToken = auth.refreshToken;
    await secureStore.set(auth.refreshToken, 'guest');
    set({ status: 'signedIn', accessToken: auth.accessToken, session: auth.session, pendingToken: null });
  };

  return {
    status: 'loading',
    accessToken: null,
    session: null,
    pendingToken: null,

    async restore() {
      refreshToken = await secureStore.get('guest');
      if (!refreshToken) {
        set({ status: 'none' });
        return;
      }
      const t = await get().refresh();
      if (!t) set({ status: 'none' });
    },

    setPendingToken(t) {
      set({ pendingToken: t });
    },

    async start(token) {
      return post<LinkStart>('/v1/guest/auth/start', { token, installId: await installId(), platform: platform() });
    },

    async sendOtp(linkTicket, guestId) {
      return post<OtpChallenge>('/v1/guest/auth/otp', { linkTicket, guestId, channel: 'whatsapp' });
    },

    async verify(challengeId, code) {
      await accept(await post<GuestAuth>('/v1/guest/auth/verify', { challengeId, code, installId: await installId() }));
    },

    refresh() {
      if (inflight) return inflight;
      inflight = (async () => {
        if (!refreshToken) return null;
        try {
          const auth = await post<GuestAuth>('/v1/guest/auth/refresh', { refreshToken, installId: await installId() });
          await accept(auth);
          return auth.accessToken;
        } catch (e) {
          if ((e as { code?: string }).code) {
            refreshToken = null;
            await secureStore.clear('guest');
            set({ status: 'none', accessToken: null, session: null });
          }
          return null; // offline: keep the stored session and cached screens
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    setSession(s) {
      set({ session: s });
    },

    async signOut() {
      const token = get().accessToken;
      if (token) await post('/v1/guest/auth/logout', {}, token).catch(() => undefined);
      refreshToken = null;
      await secureStore.clear('guest');
      set({ status: 'none', accessToken: null, session: null });
    },
  };
});

/** Which identity the app is showing when both exist. */
export const useMode = create<{ mode: 'host' | 'guest'; setMode(m: 'host' | 'guest'): void }>((set) => ({
  mode: 'host',
  setMode: (mode) => set({ mode }),
}));
