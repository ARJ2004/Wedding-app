import type { GuestGroup, Party } from '@mehfil/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../lib/api';
import { config } from '../../lib/config';
import { useSession } from '../../lib/session';
import { shareTextFile } from '../../lib/share-text-file';

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

function useInvalidateGuests(weddingId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['parties', weddingId] });
    void qc.invalidateQueries({ queryKey: guestKeys.groups(weddingId) });
  };
}

export function useCreateGroup(weddingId: string) {
  const invalidate = useInvalidateGuests(weddingId);
  return useMutation({
    mutationFn: async (name: string) => unwrap(await api.POST('/v1/weddings/{weddingId}/groups', { params: { path: { weddingId } }, body: { name } })),
    onSuccess: invalidate,
  });
}

export function useAssignGroup(weddingId: string) {
  const invalidate = useInvalidateGuests(weddingId);
  return useMutation({
    mutationFn: async ({ groupId, partyIds }: { groupId: string; partyIds: string[] }) =>
      unwrap(
        await api.POST('/v1/weddings/{weddingId}/groups/{groupId}/parties', {
          params: { path: { weddingId, groupId } },
          body: { op: 'add', partyIds },
        }),
      ),
    onSuccess: invalidate,
  });
}

/** GST-07a: fetch the CSV with the session token and hand it to the share sheet / download. */
export function useExportGuests(weddingId: string) {
  return useMutation({
    mutationFn: async () => {
      const token = useSession.getState().accessToken;
      const res = await fetch(`${config.apiUrl}/v1/weddings/${weddingId}/parties/export.csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError('EXPORT_FAILED', 'Could not export the guest list', res.status);
      await shareTextFile('guest-list.csv', 'text/csv', await res.text());
    },
  });
}
