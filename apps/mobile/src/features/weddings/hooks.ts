import type { CreateWedding, EventPreset, Wedding } from '@mehfil/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../lib/api';
import { useSession } from '../../lib/session';

export const weddingKeys = {
  all: ['weddings'] as const,
  one: (id: string) => ['weddings', id] as const,
  presets: ['event-presets'] as const,
};

export function useWeddings() {
  return useQuery({
    queryKey: weddingKeys.all,
    queryFn: async () => unwrap(await api.GET('/v1/weddings')).items,
  });
}

export function useWedding(weddingId: string) {
  return useQuery({
    queryKey: weddingKeys.one(weddingId),
    queryFn: async (): Promise<Wedding> => unwrap(await api.GET('/v1/weddings/{weddingId}', { params: { path: { weddingId } } })),
  });
}

export function useCreateWedding() {
  const qc = useQueryClient();
  const select = useSession((s) => s.selectWedding);
  return useMutation({
    mutationFn: async (body: CreateWedding) => unwrap(await api.POST('/v1/weddings', { body })),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: weddingKeys.all });
      select(w.id);
    },
  });
}

export function useEventPresets() {
  return useQuery({
    queryKey: weddingKeys.presets,
    staleTime: Infinity,
    queryFn: async (): Promise<EventPreset[]> => unwrap(await api.GET('/v1/event-presets')).items,
  });
}
