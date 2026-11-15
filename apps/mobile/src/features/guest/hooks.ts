import type { components } from '@mehfil/api-client';
import { isPaletteName } from '@mehfil/design-tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, unwrap } from '../../lib/api';
import { useGuestSession } from '../../lib/guest-session';
import { useAppearance } from '../../theme/preferences';

export type GuestHome = components['schemas']['GuestHome'];
export type PartyRsvp = components['schemas']['PartyRsvp'];

const keys = { home: (pid: string) => ['guest-home', pid] as const, rsvp: (pid: string) => ['guest-rsvp', pid] as const };
const party = () => useGuestSession.getState().session?.party.id ?? 'none';

/** GH-02: one aggregate for the home; kept 14 days for offline once APP-04's persister lands. */
export function useGuestHome() {
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  const q = useQuery({
    queryKey: keys.home(pid),
    queryFn: async (): Promise<GuestHome> => unwrap(await api.GET('/v1/guest/home')),
    gcTime: 14 * 86_400_000,
    meta: { persist: true },
  });
  const setWeddingPalette = useAppearance((s) => s.setWeddingPalette);
  const p = q.data?.wedding.palette ?? null;
  useEffect(() => {
    setWeddingPalette(p && isPaletteName(p) ? p : null);
  }, [p, setWeddingPalette]);
  return q;
}

export function useGuestRsvp() {
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  return useQuery({ queryKey: keys.rsvp(pid), queryFn: async (): Promise<PartyRsvp> => unwrap(await api.GET('/v1/guest/rsvp')) });
}

export function useSaveRsvp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      answers: { eventId: string; guestId: string; status: 'attending' | 'declined' | 'maybe' }[];
      diets: { guestId: string; diet: 'veg' | 'jain' | 'vegan' | 'eggetarian' | 'non_veg' | null; allergies: [] }[];
    }) => unwrap(await api.PUT('/v1/guest/rsvp', { body })),
    onSuccess: (data) => {
      qc.setQueryData(keys.rsvp(party()), data);
      void qc.invalidateQueries({ queryKey: keys.home(party()) });
    },
  });
}
