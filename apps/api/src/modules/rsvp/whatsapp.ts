import type { PrismaClient } from '@prisma/client';
import { rtPublish } from '../../common/sse';
import { writeAudit } from '../audit';
import type { InboundReplyCommand, InboundReplyHandler, InboundReplyResult } from '../messaging';
import { listInvitedEvents } from '../weddings/visibility';

const STATUS: Record<string, 'attending' | 'declined' | 'maybe'> = { 'rsv.attend': 'attending', 'rsv.decline': 'declined', 'rsv.maybe': 'maybe' };
const WORD = { attending: 'Attending', declined: 'Not attending', maybe: 'Not sure yet' } as const;

/**
 * One-tap WhatsApp RSVP (RSV-02, 06-rsv §4). MSG-11 resolves who replied; this applies the
 * answer to the events the invite named (context.eventIds) or, if none, every open RSVP event
 * the party is invited to. The responder's answer is set; family members without an answer get
 * the same one (a host can split per person later). Idempotent: the same tap twice → already_done.
 */
export class RsvpReplyHandler implements InboundReplyHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly linkForParty: (partyId: string, version: number) => string,
  ) {}

  async handle(cmd: InboundReplyCommand): Promise<InboundReplyResult> {
    const status = STATUS[cmd.action];
    if (!status) return { outcome: 'rejected' };
    const party = await this.prisma.parties.findFirst({ where: { id: cmd.partyId, wedding_id: cmd.weddingId, deleted_at: null }, select: { link_version: true, link_revoked_at: true } });
    if (!party) return { outcome: 'rejected' };
    const wedding = await this.prisma.weddings.findUniqueOrThrow({ where: { id: cmd.weddingId }, select: { title: true } });
    const link = party.link_revoked_at ? '' : this.linkForParty(cmd.partyId, party.link_version);
    const named = Array.isArray(cmd.context.eventIds) ? new Set(cmd.context.eventIds as string[]) : null;
    const now = new Date();
    const invited = (await listInvitedEvents(this.prisma, cmd.partyId)).filter((e) => e.rsvpEnabled && (!named || named.has(e.id)));
    const open = invited.filter((e) => !e.rsvpClosesAt || e.rsvpClosesAt > now);
    if (invited.length > 0 && open.length === 0) {
      return { outcome: 'rejected', reply: { templateKey: 'rsvp_closed', params: { link } } };
    }
    if (open.length === 0) return { outcome: 'rejected' };

    const members = await this.prisma.guests.findMany({ where: { party_id: cmd.partyId, deleted_at: null }, select: { id: true } });
    const changed = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.rsvps.findMany({ where: { party_id: cmd.partyId, event_id: { in: open.map((e) => e.id) } }, select: { event_id: true, guest_id: true, status: true } });
      const have = new Map(existing.map((r) => [`${r.event_id}:${r.guest_id}`, r.status]));
      const touched = new Set<string>();
      for (const e of open) {
        for (const m of members) {
          const cur = have.get(`${e.id}:${m.id}`);
          const isResponder = m.id === cmd.guestId;
          if (cur === status || (!isResponder && cur !== undefined)) continue; // never overwrite a family member's own answer
          await tx.rsvps.upsert({
            where: { event_id_guest_id: { event_id: e.id, guest_id: m.id } },
            create: { wedding_id: cmd.weddingId, event_id: e.id, party_id: cmd.partyId, guest_id: m.id, status, source: 'whatsapp', responded_by_guest_id: cmd.guestId },
            update: { status, source: 'whatsapp', responded_by_guest_id: cmd.guestId, responded_by_user_id: null, host_note: null, updated_at: now },
          });
          touched.add(e.id);
        }
      }
      if (touched.size === 0) return [];
      await writeAudit(tx, {
        weddingId: cmd.weddingId,
        actor: { type: 'guest', id: cmd.guestId },
        action: 'rsvp.answer',
        entityType: 'party',
        entityId: cmd.partyId,
        after: { status, events: [...touched], source: 'whatsapp', inboundId: cmd.inboundId },
      });
      await rtPublish(tx, cmd.weddingId, 'headcount', 'rsvp.changed', { partyId: cmd.partyId, eventIds: [...touched] });
      return [...touched];
    });
    if (changed.length === 0) return { outcome: 'already_done' };
    const names = open.filter((e) => changed.includes(e.id)).map((e) => e.name);
    return {
      outcome: 'ok',
      reply: { templateKey: 'rsvp_confirmation', params: { wedding: wedding.title, summary: `${WORD[status]}: ${names.join(', ')}`.slice(0, 300), link } },
    };
  }
}
