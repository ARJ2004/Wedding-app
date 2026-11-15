import { z } from 'zod';
import type { Action, Role } from './permissions';
import { can } from './permissions';

/**
 * Realtime channel catalogue (FND-14, 01-fnd §5). One place for the API and the app:
 * channel name → who may subscribe (any of the actions) → payload schema per event kind.
 * Payloads carry only fields every subscriber may see (no phones, no ID data) and stay ≤ 4 kB.
 * ARR, RSV and QZ add channels here.
 */
export const REALTIME_CHANNELS = {
  'debug.ping': {
    actions: ['wedding.read'] as Action[],
    guest: false,
    kinds: { 'debug.ping': z.object({ at: z.string() }) },
  },
  headcount: {
    actions: ['rsvp.read', 'rsvp.headcount'] as Action[],
    guest: false,
    kinds: { 'rsvp.changed': z.object({ partyId: z.string().uuid(), eventIds: z.array(z.string().uuid()) }) },
  },
  /** MSG-06: send progress for the host message-detail screen (counts only, no names or phones). */
  messages: {
    actions: ['message.read'] as Action[],
    guest: false,
    kinds: {
      'msg.progress': z.object({ messageId: z.string().uuid(), status: z.string(), counts: z.record(z.string(), z.number().int()) }),
    },
  },
} as const;

export type RealtimeChannel = keyof typeof REALTIME_CHANNELS;
export const isRealtimeChannel = (name: string): name is RealtimeChannel => Object.hasOwn(REALTIME_CHANNELS, name);

/** May this role subscribe to the channel? Guests only where the channel opts in. */
export function canSubscribe(role: Role, channel: RealtimeChannel): boolean {
  const def = REALTIME_CHANNELS[channel];
  if (role === 'guest') return def.guest;
  return def.actions.some((a) => can(role, a));
}

/** The one SSE message shape both sides agree on. */
export interface RealtimeMessage {
  id: string;
  channel: string;
  kind: string;
  payload: unknown;
}
