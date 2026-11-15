import type { Event } from '@mehfil/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../lib/api';

export const eventKeys = { list: (weddingId: string) => ['events', weddingId] as const, venues: (w: string) => ['venues', w] as const };

export function useEvents(weddingId: string) {
  return useQuery({
    queryKey: eventKeys.list(weddingId),
    queryFn: async (): Promise<Event[]> => unwrap(await api.GET('/v1/weddings/{weddingId}/events', { params: { path: { weddingId } } })).items,
  });
}

export function useVenues(weddingId: string) {
  return useQuery({
    queryKey: eventKeys.venues(weddingId),
    queryFn: async () => unwrap(await api.GET('/v1/weddings/{weddingId}/venues', { params: { path: { weddingId } } })).items,
  });
}

export function useAddPresets(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: { kind: 'haldi' | 'mehendi' | 'sangeet' | 'baraat' | 'pheras' | 'reception'; date: string }[]) =>
      unwrap(await api.POST('/v1/weddings/{weddingId}/events/bulk-from-presets', { params: { path: { weddingId } }, body: { items } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: eventKeys.list(weddingId) });
    },
  });
}
