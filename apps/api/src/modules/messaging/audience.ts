import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { phoneHash } from './phone-hash';

const Uuid = z.string().uuid();

/**
 * Audience spec (07-msg §2): stored on the message, resolved at send time.
 * Dimensions given are intersected (groups ∩ invited-to-events ∩ RSVP status ∩ registered filters);
 * hand-picked parties/guests are added on top. An empty spec means every guest.
 */
export const AudienceSpec = z
  .object({
    groups: z.array(Uuid).max(50).optional(),
    events: z.array(Uuid).max(50).optional(),
    rsvp: z.object({ eventId: Uuid, statuses: z.array(z.enum(['attending', 'declined', 'maybe', 'pending'])).min(1) }).optional(),
    partyIds: z.array(Uuid).max(2000).optional(),
    guestIds: z.array(Uuid).max(2000).optional(),
    filters: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).max(5).optional(),
  })
  .openapi('AudienceSpec');
export type AudienceSpec = z.infer<typeof AudienceSpec>;

export type AudienceFilter = (weddingId: string, args: Record<string, unknown>) => Promise<string[]>;
const filters = new Map<string, AudienceFilter>();
/** Other modules (TRV, ARR) add filters like "arriving_on" at boot. */
export function registerAudienceFilter(name: string, fn: AudienceFilter) {
  filters.set(name, fn);
}

export interface AudienceMember {
  guestId: string;
  partyId: string;
  language: 'en' | 'hi' | 'kn';
  phoneE164: string | null;
  suppressed: 'no_phone' | 'opted_out' | 'duplicate_phone' | null;
}

export async function resolveAudience(prisma: PrismaClient, weddingId: string, spec: AudienceSpec, piiKey: string): Promise<AudienceMember[]> {
  const guests = await prisma.guests.findMany({
    where: { wedding_id: weddingId, deleted_at: null, parties: { deleted_at: null } },
    select: { id: true, party_id: true, phone_e164: true, phone_status: true, is_primary: true, parties: { select: { preferred_language: true } } },
    orderBy: [{ party_id: 'asc' }, { is_primary: 'desc' }, { created_at: 'asc' }],
  });
  let keep: Set<string> | null = null;
  const narrow = (ids: Iterable<string>) => {
    const next = new Set(ids);
    keep = keep ? new Set([...keep].filter((id) => next.has(id))) : next;
  };
  const byParty = (partyIds: Set<string>) => guests.filter((g) => partyIds.has(g.party_id)).map((g) => g.id);

  if (spec.groups?.length) {
    const rows = await prisma.party_groups.findMany({ where: { group_id: { in: spec.groups } }, select: { party_id: true } });
    narrow(byParty(new Set(rows.map((r) => r.party_id))));
  }
  if (spec.events?.length) {
    const rows = await prisma.$queryRaw<{ party_id: string }[]>`
      SELECT DISTINCT party_id FROM party_invited_events WHERE event_id = ANY(${spec.events}::uuid[])`;
    narrow(byParty(new Set(rows.map((r) => r.party_id))));
  }
  if (spec.rsvp) {
    const invited = await prisma.$queryRaw<{ party_id: string }[]>`
      SELECT party_id FROM party_invited_events WHERE event_id = ${spec.rsvp.eventId}::uuid`;
    const answers = await prisma.rsvps.findMany({ where: { event_id: spec.rsvp.eventId }, select: { guest_id: true, status: true } });
    const status = new Map(answers.map((a) => [a.guest_id, a.status]));
    const invitedParties = new Set(invited.map((r) => r.party_id));
    narrow(guests.filter((g) => invitedParties.has(g.party_id) && spec.rsvp!.statuses.includes((status.get(g.id) ?? 'pending') as never)).map((g) => g.id));
  }
  for (const f of spec.filters ?? []) {
    const fn = filters.get(f.name);
    if (!fn) throw new Error(`unknown audience filter ${f.name}`);
    narrow(await fn(weddingId, f.args));
  }
  const dims = spec.groups?.length || spec.events?.length || spec.rsvp || spec.filters?.length;
  const picked = spec.partyIds?.length || spec.guestIds?.length;
  const chosen = new Set<string>(dims ? (keep ?? []) : picked ? [] : guests.map((g) => g.id));
  for (const id of byParty(new Set(spec.partyIds ?? []))) chosen.add(id);
  const known = new Set(guests.map((g) => g.id));
  for (const id of spec.guestIds ?? []) if (known.has(id)) chosen.add(id);

  const members = guests.filter((g) => chosen.has(g.id));
  const phones = members.map((g) => (g.phone_status === 'valid' ? g.phone_e164 : null)).filter((p): p is string => !!p);
  const optedOut = new Set(
    (
      await prisma.messaging_opt_outs.findMany({
        where: { channel: 'whatsapp', phone_hash: { in: phones.map((p) => phoneHash(piiKey, p)) } },
        select: { phone_hash: true },
      })
    ).map((o) => Buffer.from(o.phone_hash).toString('hex')),
  );
  const seen = new Set<string>();
  return members.map((g) => {
    const phone = g.phone_status === 'valid' ? g.phone_e164 : null;
    let suppressed: AudienceMember['suppressed'] = null;
    if (!phone) suppressed = 'no_phone';
    else if (optedOut.has(phoneHash(piiKey, phone).toString('hex'))) suppressed = 'opted_out';
    else if (seen.has(phone)) suppressed = 'duplicate_phone'; // one family phone gets one message
    if (phone) seen.add(phone);
    const lang = g.parties.preferred_language;
    return { guestId: g.id, partyId: g.party_id, language: lang === 'hi' || lang === 'kn' ? lang : 'en', phoneE164: phone, suppressed };
  });
}
