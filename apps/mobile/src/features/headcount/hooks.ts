import type { components } from '@mehfil/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api, unwrap } from '../../lib/api';
import { useEventStream } from '../../lib/realtime';

export type Headcount = components['schemas']['Headcount'];
export type EventHeadcount = components['schemas']['EventHeadcount'];
export const headcountKey = (w: string) => ['wedding', w, 'headcount'] as const;

/**
 * Headcount (RSV-03) kept live: any `headcount` stream event refetches, debounced so an invite
 * wave of answers costs one request a second, not one per answer. Cached for offline viewing.
 */
export function useLiveHeadcount(weddingId: string) {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      qc.invalidateQueries({ queryKey: headcountKey(weddingId) }).catch(() => undefined);
    }, 1000);
  };
  const live = useEventStream(weddingId, ['headcount'], { onEvent: refetch, onReset: refetch });
  const query = useQuery({
    queryKey: headcountKey(weddingId),
    queryFn: async (): Promise<Headcount> => unwrap(await api.GET('/v1/weddings/{weddingId}/rsvp/headcount', { params: { path: { weddingId } } })),
    meta: { persist: true },
  });
  return { ...query, live };
}
