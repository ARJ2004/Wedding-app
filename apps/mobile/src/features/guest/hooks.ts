import type { components } from '@mehfil/api-client';
import { isPaletteName } from '@mehfil/design-tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, unwrap } from '../../lib/api';
import { useGuestSession } from '../../lib/guest-session';
import { isNetworkError, useOutbox } from '../../lib/outbox';
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
  return useQuery({ queryKey: keys.rsvp(pid), queryFn: async (): Promise<PartyRsvp> => unwrap(await api.GET('/v1/guest/rsvp')), meta: { persist: true } });
}

export function useSaveRsvp() {
  const qc = useQueryClient();
  return useMutation({
    // Run even when the OS says offline: the outbox, not TanStack's pause, owns offline writes.
    networkMode: 'always',
    mutationFn: async (body: {
      answers: { eventId: string; guestId: string; status: 'attending' | 'declined' | 'maybe' }[];
      diets: { guestId: string; diet: 'veg' | 'jain' | 'vegan' | 'eggetarian' | 'non_veg' | null; allergies: [] }[];
    }): Promise<PartyRsvp | 'queued'> => {
      try {
        return unwrap(await api.PUT('/v1/guest/rsvp', { body }));
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        // No signal at the venue: keep the answers on the phone and send them when back online.
        useOutbox.getState().enqueue({ identity: 'guest', method: 'PUT', path: '/v1/guest/rsvp', body, label: 'RSVP' });
        return 'queued';
      }
    },
    onSuccess: (data, body) => {
      if (data !== 'queued') {
        qc.setQueryData(keys.rsvp(party()), data);
        void qc.invalidateQueries({ queryKey: keys.home(party()) });
        return;
      }
      // Queued offline: show the family's answers as given; the server confirms on reconnect.
      qc.setQueryData<PartyRsvp>(keys.rsvp(party()), (old) =>
        old && {
          ...old,
          events: old.events.map((e) => ({
            ...e,
            answers: e.answers.map((a) => ({ ...a, status: body.answers.find((x) => x.eventId === e.eventId && x.guestId === a.guestId)?.status ?? a.status })),
          })),
          members: old.members.map((m) => ({ ...m, diet: body.diets.find((d) => d.guestId === m.guestId)?.diet ?? m.diet })),
        },
      );
    },
  });
}
