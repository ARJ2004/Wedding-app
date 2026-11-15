import { REALTIME_CHANNELS, type RealtimeChannel, type RealtimeMessage } from '@mehfil/domain';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import EventSource from 'react-native-sse';
import { config } from './config';
import { useGuestSession } from './guest-session';
import { useSession } from './session';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'retrying';

const baseUrl = () => config.apiUrl || (typeof window !== 'undefined' ? window.location.origin : '');
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Follows a wedding's realtime channels over SSE (FND-14). Sends the bearer token, resumes with
 * Last-Event-ID, refreshes the token on 401, backs off on network errors, and pauses while the
 * app is in the background. `onReset` fires when the server says the gap was too large: refetch.
 */
export function useEventStream(
  weddingId: string | null | undefined,
  channels: RealtimeChannel[],
  handlers: { onEvent(msg: RealtimeMessage): void; onReset?(): void },
  identity: 'host' | 'guest' = 'host',
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const ref = useRef(handlers);
  ref.current = handlers;
  const key = [...channels].sort().join(',');

  useEffect(() => {
    if (!weddingId || !key) return;
    const session = identity === 'guest' ? useGuestSession : useSession;
    const kinds = key.split(',').flatMap((c) => Object.keys(REALTIME_CHANNELS[c as RealtimeChannel].kinds));
    let es: EventSource<string> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastId: string | null = null;
    let attempt = 0;
    let stopped = false;

    const teardown = () => {
      clearTimeout(timer);
      es?.removeAllEventListeners();
      es?.close();
      es = null;
    };
    const retry = (ms: number) => {
      teardown();
      if (stopped) return;
      setStatus('retrying');
      timer = setTimeout(connect, ms);
    };

    function connect() {
      teardown();
      const token = session.getState().accessToken;
      if (!token) return retry(BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]!);
      setStatus('connecting');
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (lastId) headers['Last-Event-ID'] = lastId;
      const url = `${baseUrl()}/v1/weddings/${weddingId}/stream?channels=${encodeURIComponent(key)}`;
      const src = new EventSource<string>(url, { headers, pollingInterval: 0 });
      es = src;
      src.addEventListener('open', () => {
        attempt = 0;
        setStatus('live');
      });
      for (const kind of kinds) {
        src.addEventListener(kind, (e) => {
          if (e.type === 'open' || e.type === 'error' || e.type === 'close' || !('data' in e) || !e.data) return;
          if (e.lastEventId) lastId = e.lastEventId;
          try {
            ref.current.onEvent(JSON.parse(e.data) as RealtimeMessage);
          } catch {
            /* malformed event: ignore */
          }
        });
      }
      src.addEventListener('reset', (e) => {
        if ('lastEventId' in e && e.lastEventId) lastId = e.lastEventId;
        ref.current.onReset?.();
      });
      src.addEventListener('error', (e) => {
        const code = 'xhrStatus' in e ? e.xhrStatus : 0;
        if (code === 401) {
          void session
            .getState()
            .refresh()
            .then((t) => (t ? retry(0) : (teardown(), setStatus('idle'))));
          return;
        }
        if (code === 403 || code === 404 || code === 400) {
          teardown();
          setStatus('idle');
          return;
        }
        retry(BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]!);
      });
      // The server closes each stream after an hour; reconnect straight away with a fresh token.
      src.addEventListener('close', () => retry(0));
    }

    connect();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && !es) connect();
      if (st === 'background') {
        clearTimeout(timer);
        teardown();
        setStatus('idle');
      }
    });
    return () => {
      stopped = true;
      sub.remove();
      teardown();
      setStatus('idle');
    };
  }, [weddingId, key, identity]);

  return status;
}
