import type { AuthResponse, Me } from '@mehfil/api-client';
import { create } from 'zustand';
import { config } from './config';
import { newDeviceId } from './device-id';
import { googleSignOut } from './google';
import { secureStore } from './secure-store';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface Persisted {
  refreshToken: string;
  deviceId: string;
}

interface SessionState {
  status: Status;
  user: Me | null;
  accessToken: string | null;
  deviceId: string | null;
  weddingId: string | null;
  error: string | null;
  restore(): Promise<void>;
  signIn(idToken: string): Promise<void>;
  refresh(): Promise<string | null>;
  signOut(): Promise<void>;
  selectWedding(id: string | null): void;
  setUser(user: Me): void;
}

let persisted: Persisted | null = null;

async function readPersisted(): Promise<Persisted | null> {
  const raw = await secureStore.get();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown, accessToken?: string): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  return { ok: res.ok, status: res.status, data };
}

const errorMessage = (data: unknown) =>
  (data as { error?: { message?: string } } | undefined)?.error?.message ?? 'Something went wrong. Please try again.';

/**
 * Host session (Google SSO or dev bypass). Access token in memory; refresh token + device id in
 * the keychain. Refresh is single-flight so parallel 401s rotate once.
 */
export const useSession = create<SessionState>((set, get) => {
  let inflight: Promise<string | null> | null = null;

  const accept = async (auth: AuthResponse, deviceId: string) => {
    persisted = { refreshToken: auth.refreshToken, deviceId };
    await secureStore.set(JSON.stringify(persisted));
    const keep = get().weddingId;
    const stillMember = keep && auth.user.weddings.some((w) => w.id === keep);
    set({
      status: 'signedIn',
      user: auth.user,
      accessToken: auth.accessToken,
      deviceId,
      error: null,
      weddingId: stillMember ? keep : auth.user.weddings.length === 1 ? auth.user.weddings[0]!.id : null,
    });
  };

  return {
    status: 'loading',
    user: null,
    accessToken: null,
    deviceId: null,
    weddingId: null,
    error: null,

    async restore() {
      persisted = await readPersisted();
      if (!persisted) {
        set({ status: 'signedOut' });
        return;
      }
      const token = await get().refresh();
      if (!token) set({ status: 'signedOut' });
    },

    async signIn(idToken) {
      const deviceId = persisted?.deviceId ?? newDeviceId();
      set({ error: null });
      const res = await post<AuthResponse>('/v1/auth/google', { idToken, deviceId });
      if (!res.ok) {
        set({ error: errorMessage(res.data) });
        return;
      }
      await accept(res.data, deviceId);
    },

    refresh() {
      if (inflight) return inflight;
      inflight = (async () => {
        if (!persisted) return null;
        try {
          const res = await post<AuthResponse>('/v1/auth/refresh', persisted);
          if (!res.ok) {
            await secureStore.clear();
            persisted = null;
            set({ status: 'signedOut', user: null, accessToken: null });
            return null;
          }
          await accept(res.data, persisted.deviceId);
          return res.data.accessToken;
        } catch {
          // Offline: keep the stored session; screens show cached data and retry later.
          return null;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    async signOut() {
      const token = get().accessToken;
      if (token) await post('/v1/auth/logout', {}, token).catch(() => undefined);
      await secureStore.clear();
      await googleSignOut();
      persisted = null;
      set({ status: 'signedOut', user: null, accessToken: null, weddingId: null });
    },

    selectWedding(id) {
      set({ weddingId: id });
    },

    setUser(user) {
      set({ user });
    },
  };
});
