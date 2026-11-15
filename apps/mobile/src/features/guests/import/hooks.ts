import type { components } from '@mehfil/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../../lib/api';
import type { PickedFile } from '../../../lib/file-picker';
import { uploadFile } from '../../../lib/upload';

export type GuestImport = components['schemas']['GuestImport'];
export type ImportMappingBody = components['schemas']['GuestImport']['mapping'];
const WORKING = new Set(['parsing', 'validating', 'committing']);

export const importKeys = { one: (w: string, id: string) => ['import', w, id] as const, rows: (w: string, id: string) => ['import-rows', w, id] as const };

export function useImport(weddingId: string, importId: string | null) {
  return useQuery({
    queryKey: importKeys.one(weddingId, importId ?? 'none'),
    enabled: Boolean(importId),
    queryFn: async (): Promise<GuestImport> =>
      unwrap(await api.GET('/v1/weddings/{weddingId}/imports/{importId}', { params: { path: { weddingId, importId: importId! } } })),
    // Poll every second while a background job is working (04-gst §5: no SSE for a 10–30 s job).
    refetchInterval: (q) => (q.state.data && WORKING.has(q.state.data.status) ? 1000 : false),
  });
}

export function useImportProblems(weddingId: string, importId: string, enabled: boolean) {
  return useQuery({
    queryKey: importKeys.rows(weddingId, importId),
    enabled,
    queryFn: async () => {
      const all = await Promise.all(
        (['error', 'warning', 'duplicate'] as const).map(async (status) =>
          unwrap(await api.GET('/v1/weddings/{weddingId}/imports/{importId}/rows', { params: { path: { weddingId, importId }, query: { status, limit: 50 } } })).items,
        ),
      );
      return all.flat().sort((a, b) => a.rowNumber - b.rowNumber);
    },
  });
}

export function useStartImport(weddingId: string) {
  return useMutation({
    mutationFn: async (file: PickedFile) => {
      const mediaId = await uploadFile(weddingId, 'import', file);
      return unwrap(await api.POST('/v1/weddings/{weddingId}/imports', { params: { path: { weddingId } }, body: { mediaId } }));
    },
  });
}

export function useSubmitMapping(weddingId: string, importId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { columns: Record<string, string>; partyMode: 'row_is_party' | 'group_by_column' }) =>
      unwrap(
        await api.PUT('/v1/weddings/{weddingId}/imports/{importId}/mapping', {
          params: { path: { weddingId, importId } },
          body: body as never,
        }),
      ),
    onSuccess: (data) => qc.setQueryData(importKeys.one(weddingId, importId), data),
  });
}

export function useCommitImport(weddingId: string, importId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/v1/weddings/{weddingId}/imports/{importId}/commit', {
          params: { path: { weddingId, importId }, header: { 'Idempotency-Key': `commit-${importId}` } as never },
        }),
      ),
    onSuccess: (data) => {
      qc.setQueryData(importKeys.one(weddingId, importId), data);
      void qc.invalidateQueries({ queryKey: ['parties', weddingId] });
      void qc.invalidateQueries({ queryKey: ['groups', weddingId] });
    },
  });
}
