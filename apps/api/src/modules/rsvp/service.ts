import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors';
import { writeAudit } from '../audit';
import { rtPublish } from '../../common/sse';
import { listInvitedEvents } from '../weddings/visibility';

export type RsvpStatus = 'attending' | 'declined' | 'maybe';
export type Diet = 'veg' | 'jain' | 'vegan' | 'eggetarian' | 'non_veg';
export type Allergy = 'nuts' | 'gluten' | 'dairy' | 'shellfish' | 'egg' | 'soy' | 'other';

export interface GuestCtx {
  guestId: string;
  partyId: string;
  weddingId: string;
}

/** RSV-01a: per-event, per-member RSVPs for the guest's own party only (06-rsv §4). */
export class RsvpService {
  constructor(private readonly prisma: PrismaClient) {}

  /** For guest-home and the RSVP screen: invited events × members with status. */
  async partyState(partyId: string) {
    const [events, members, rsvps, diets] = await Promise.all([
      listInvitedEvents(this.prisma, partyId),
      this.prisma.guests.findMany({ where: { party_id: partyId, deleted_at: null }, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }] }),
      this.prisma.rsvps.findMany({ where: { party_id: partyId } }),
      this.prisma.guest_dietary.findMany({ where: { guests: { party_id: partyId } } }),
    ]);
    const byKey = new Map(rsvps.map((r) => [`${r.event_id}:${r.guest_id}`, r.status as RsvpStatus]));
    const now = new Date();
    return {
      members: members.map((m) => {
        const d = diets.find((x) => x.guest_id === m.id);
        return { guestId: m.id, fullName: m.full_name, ageBand: m.age_band as 'child' | 'adult' | 'senior' | null, diet: (d?.diet as Diet | null) ?? null, allergies: (d?.allergies as Allergy[]) ?? [] };
      }),
      events: events.map((e) => ({
        eventId: e.id,
        name: e.name,
        startsAt: e.startsAt.toISOString(),
        rsvpEnabled: e.rsvpEnabled,
        closed: Boolean(e.rsvpClosesAt && e.rsvpClosesAt < now),
        answers: members.map((m) => ({ guestId: m.id, status: byKey.get(`${e.id}:${m.id}`) ?? null })),
      })),
    };
  }

  async answer(g: GuestCtx, input: { answers: { eventId: string; guestId: string; status: RsvpStatus }[]; diets?: { guestId: string; diet: Diet | null; allergies: Allergy[] }[] }, source: 'app' | 'lite_web' = 'app') {
    const events = new Map((await listInvitedEvents(this.prisma, g.partyId)).map((e) => [e.id, e]));
    const memberIds = new Set((await this.prisma.guests.findMany({ where: { party_id: g.partyId, deleted_at: null }, select: { id: true } })).map((m) => m.id));
    const now = new Date();
    for (const a of input.answers) {
      const ev = events.get(a.eventId);
      if (!ev) throw new AppError('RSV_EVENT_NOT_INVITED', 'That event is not on your invite', 404);
      if (!memberIds.has(a.guestId)) throw new AppError('RSV_GUEST_NOT_IN_PARTY', 'That person is not on your invite', 404);
      if (!ev.rsvpEnabled) throw new AppError('RSV_DISABLED', `${ev.name} does not need an RSVP`, 409);
      if (ev.rsvpClosesAt && ev.rsvpClosesAt < now) throw new AppError('RSV_CLOSED', `RSVPs for ${ev.name} are closed. Please call the family.`, 409);
    }
    for (const d of input.diets ?? []) if (!memberIds.has(d.guestId)) throw new AppError('RSV_GUEST_NOT_IN_PARTY', 'That person is not on your invite', 404);

    await this.prisma.$transaction(async (tx) => {
      for (const a of input.answers) {
        await tx.rsvps.upsert({
          where: { event_id_guest_id: { event_id: a.eventId, guest_id: a.guestId } },
          create: { wedding_id: g.weddingId, event_id: a.eventId, party_id: g.partyId, guest_id: a.guestId, status: a.status, source, responded_by_guest_id: g.guestId },
          update: { status: a.status, source, responded_by_guest_id: g.guestId, responded_by_user_id: null, host_note: null, updated_at: now },
        });
      }
      for (const d of input.diets ?? []) {
        await tx.guest_dietary.upsert({
          where: { guest_id: d.guestId },
          create: { guest_id: d.guestId, wedding_id: g.weddingId, diet: d.diet, allergies: d.allergies },
          update: { diet: d.diet, allergies: d.allergies, updated_at: now },
        });
      }
      await writeAudit(tx, {
        weddingId: g.weddingId,
        actor: { type: 'guest', id: g.guestId },
        action: 'rsvp.answer',
        entityType: 'party',
        entityId: g.partyId,
        after: { answers: input.answers.length, diets: input.diets?.length ?? 0, source },
      });
      // Live headcount (RSV-03) refetches on this; ids only, never names or answers.
      await rtPublish(tx, g.weddingId, 'headcount', 'rsvp.changed', {
        partyId: g.partyId,
        eventIds: [...new Set(input.answers.map((a) => a.eventId))],
      });
    });
    return this.partyState(g.partyId);
  }
}
