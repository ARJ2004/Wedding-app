import { AppState } from 'react-native';
import { create } from 'zustand';
import { config } from './config';
import { useGuestSession } from './guest-session';
import { kv } from './kv';
import { useSession } from './session';

/**
 * Offline mutation outbox (APP-04): writes made without network (RSVP, travel status, check-in)
 * are kept on the phone and replayed in order when the app is back online or reopened. Each item
 * carries an Idempotency-Key so a replay after a lost response never double-applies.
 */
export interface OutboxItem {
  id: string;
  identity: 'host' | 'guest';
  method: 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: unknown;
  label: string;
  createdAt: number;
  attempts: number;
}

const KEY = 'outbox.v1';
// Read lazily: the encrypted store is ready only after initKv().
const load = (): OutboxItem[] => {
  try {
    return JSON.parse(kv.getItem(KEY) ?? '[]') as OutboxItem[];
  } catch {
    return [];
  }
};

interface OutboxState {
  items: OutboxItem[];
  flushing: boolean;
  enqueue(item: Omit<OutboxItem, 'id' | 'createdAt' | 'attempts'>): void;
  flush(): Promise<void>;
  onApplied?: (item: OutboxItem) => void;
}

export const isNetworkError = (e: unknown) => e instanceof TypeError || (e as { code?: string }).code === 'NETWORK';

export const useOutbox = create<OutboxState>((set, get) => ({
  items: [],
  flushing: false,
  enqueue(item) {
    const items = [...get().items, { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), attempts: 0 }];
    kv.setItem(KEY, JSON.stringify(items));
    set({ items });
  },
  async flush() {
    if (get().flushing || get().items.length === 0) return;
    set({ flushing: true });
    try {
      let items = get().items;
      while (items.length) {
        const item = items[0]!;
        const token = item.identity === 'guest' ? useGuestSession.getState().accessToken : useSession.getState().accessToken;
        let res: Response;
        try {
          res = await fetch(`${config.apiUrl}${item.path}`, {
            method: item.method,
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `outbox-${item.id}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(item.body),
          });
        } catch {
          break; // still offline: keep everything, try later
        }
        if (res.status === 401) {
          const refreshed = item.identity === 'guest' ? await useGuestSession.getState().refresh() : await useSession.getState().refresh();
          if (refreshed) continue;
          break;
        }
        // 2xx applied; 4xx can never succeed (e.g. RSVP closed) — drop it, the screen refetches the truth.
        if (res.status < 500) {
          get().onApplied?.(item);
          items = items.slice(1);
        } else {
          items = [{ ...item, attempts: item.attempts + 1 }, ...items.slice(1)];
          break;
        }
        kv.setItem(KEY, JSON.stringify(items));
        set({ items });
      }
      kv.setItem(KEY, JSON.stringify(items));
      set({ items });
    } finally {
      set({ flushing: false });
    }
  },
}));

/** Flush when the app comes to the foreground and every 30 s while there is something queued. */
export function startOutbox() {
  useOutbox.setState({ items: load() });
  const sub = AppState.addEventListener('change', (st) => {
    if (st === 'active') void useOutbox.getState().flush();
  });
  const timer = setInterval(() => {
    if (useOutbox.getState().items.length) void useOutbox.getState().flush();
  }, 30_000);
  void useOutbox.getState().flush();
  return () => {
    sub.remove();
    clearInterval(timer);
  };
}
