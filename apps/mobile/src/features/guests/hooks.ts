import type { GuestGroup, Party } from '@mehfil/api-client';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../lib/api';

export const guestKeys = {
  parties: (weddingId: string, q: string, groupId: string | null) => ['parties', weddingId, q, groupId] as const,
  groups: (weddingId: string) => ['groups', weddingId] as const,
};

export function useParties(weddingId: string, q: string, groupId: string | null) {
  return useQuery({
    queryKey: guestKeys.parties(weddingId, q, groupId),
    queryFn: async (): Promise<{ items: Party[]; nextCursor: string | null }> =>
      unwrap(
        await api.GET('/v1/weddings/{weddingId}/parties', {
          params: { path: { weddingId }, query: { q: q || undefined, groupId: groupId ?? undefined, limit: 200 } },
        }),
      ),
  });
}

export function useGroups(weddingId: string) {
  return useQuery({
    queryKey: guestKeys.groups(weddingId),
    queryFn: async (): Promise<GuestGroup[]> => unwrap(await api.GET('/v1/weddings/{weddingId}/groups', { params: { path: { weddingId } } })).items,
  });
}
