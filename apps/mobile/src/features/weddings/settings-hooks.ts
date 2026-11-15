import type { components } from '@mehfil/api-client';
import { isPaletteName } from '@mehfil/design-tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, unwrap } from '../../lib/api';
import { uploadFile } from '../../lib/upload';
import type { PickedFile } from '../../lib/file-picker';
import { useAppearance } from '../../theme/preferences';
import { weddingKeys } from './hooks';

export type WeddingSettings = components['schemas']['WeddingSettings'];
export type KeyContact = components['schemas']['KeyContact'];

const keys = {
  settings: (w: string) => ['wedding', w, 'settings'] as const,
  contacts: (w: string) => ['contacts', w] as const,
};

export function useWeddingSettings(weddingId: string) {
  return useQuery({
    queryKey: keys.settings(weddingId),
    queryFn: async (): Promise<WeddingSettings> => unwrap(await api.GET('/v1/weddings/{weddingId}/settings', { params: { path: { weddingId } } })),
  });
}

/** Applies the open wedding's palette to the app theme (device choice still wins). */
export function useApplyWeddingPalette(weddingId: string) {
  const settings = useWeddingSettings(weddingId);
  const setWeddingPalette = useAppearance((s) => s.setWeddingPalette);
  const p = settings.data?.branding.palette ?? null;
  useEffect(() => {
    setWeddingPalette(p && isPaletteName(p) ? p : null);
  }, [p, setWeddingPalette]);
}

export function useUpdateSettings(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      unwrap(await api.PATCH('/v1/weddings/{weddingId}/settings', { params: { path: { weddingId } }, body: patch })),
    onSuccess: (data) => qc.setQueryData(keys.settings(weddingId), data),
  });
}

export function useSetCover(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: PickedFile) => {
      const mediaId = await uploadFile(weddingId, 'cover', file);
      return unwrap(await api.PATCH('/v1/weddings/{weddingId}', { params: { path: { weddingId } }, body: { coverMediaId: mediaId } }));
    },
    onSuccess: (w) => qc.setQueryData(weddingKeys.one(weddingId), w),
  });
}

export function useContacts(weddingId: string) {
  return useQuery({
    queryKey: keys.contacts(weddingId),
    queryFn: async (): Promise<KeyContact[]> => unwrap(await api.GET('/v1/weddings/{weddingId}/contacts', { params: { path: { weddingId } } })).items,
  });
}

export function useAddContact(weddingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { side: 'bride' | 'groom' | 'both'; label: string; name: string; phone: string }) =>
      unwrap(await api.POST('/v1/weddings/{weddingId}/contacts', { params: { path: { weddingId } }, body: { ...body, hasWhatsapp: true } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.contacts(weddingId) });
    },
  });
}
