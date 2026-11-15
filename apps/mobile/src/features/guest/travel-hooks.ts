import type { components } from '@mehfil/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../lib/api';
import { useGuestSession } from '../../lib/guest-session';

export type PartyTravel = components['schemas']['PartyTravel'];
export type TravelLeg = components['schemas']['TravelLeg'];
export type CreateTravelLeg = components['schemas']['CreateTravelLeg'];

const key = (pid: string) => ['guest-travel', pid] as const;

/** TRV-01: the family's journeys; cached for offline viewing. */
export function useGuestTravel() {
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  return useQuery({ queryKey: key(pid), queryFn: async (): Promise<PartyTravel> => unwrap(await api.GET('/v1/guest/travel')), meta: { persist: true } });
}

export function useSaveLeg() {
  const qc = useQueryClient();
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  return useMutation({
    mutationFn: async (input: { body: CreateTravelLeg; edit?: { id: string; version: number } }) => {
      if (input.edit) {
        const patch: Omit<CreateTravelLeg, 'direction'> & { direction?: unknown } = { ...input.body };
        delete patch.direction;
        return unwrap(
          await api.PATCH('/v1/guest/travel/legs/{legId}', {
            params: { path: { legId: input.edit.id } },
            headers: { 'If-Match': String(input.edit.version) },
            body: patch,
          }),
        );
      }
      return unwrap(await api.POST('/v1/guest/travel/legs', { body: input.body }));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(pid) });
    },
  });
}

export function useRemoveLeg() {
  const qc = useQueryClient();
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  return useMutation({
    mutationFn: async (legId: string) => {
      const r = await api.DELETE('/v1/guest/travel/legs/{legId}', { params: { path: { legId } } });
      if (r.error) unwrap(r);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(pid) });
    },
  });
}

export function useNotTravelling() {
  const qc = useQueryClient();
  const pid = useGuestSession((s) => s.session?.party.id ?? 'none');
  return useMutation({
    mutationFn: async () => {
      const r = await api.POST('/v1/guest/travel/not-travelling');
      if (r.error) unwrap(r);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(pid) });
    },
  });
}
