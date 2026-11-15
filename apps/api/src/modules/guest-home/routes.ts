import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { readSettings } from '@mehfil/domain';
import { defineRoute, type RouteContext } from '../../common/define-route';
import type { ObjectStore } from '../../common/object-store';
import { z } from '../../common/openapi';
import type { RsvpService } from '../rsvp';
import { listInvitedEvents } from '../weddings/visibility';

const Venue = z.object({ name: z.string(), address: z.string().nullable(), mapsUrl: z.string().nullable(), lat: z.number().nullable(), lng: z.number().nullable(), parkingNotes: z.string().nullable() });

const GuestHome = z
  .object({
    wedding: z.object({ title: z.string(), startsOn: z.string(), endsOn: z.string(), timezone: z.string(), cities: z.array(z.string()), coverUrl: z.string().nullable(), palette: z.string().nullable() }),
    me: z.object({ guestId: z.string().uuid(), fullName: z.string() }),
    party: z.object({ label: z.string(), memberCount: z.number().int() }),
    events: z.array(
      z.object({
        id: z.string().uuid(),
        kind: z.string(),
        name: z.string(),
        startsAt: z.string(),
        endsAt: z.string().nullable(),
        dressCode: z.string().nullable(),
        notes: z.string().nullable(),
        venue: Venue.nullable(),
        rsvp: z.object({ enabled: z.boolean(), closed: z.boolean(), answered: z.number().int(), attending: z.number().int(), total: z.number().int() }),
      }),
    ),
    contacts: z.array(z.object({ side: z.string(), label: z.string(), name: z.string(), phone: z.string(), hasWhatsapp: z.boolean() })),
    rsvpPending: z.number().int(),
  })
  .openapi('GuestHome');

/**
 * GH-02: one aggregate for the guest home and schedule (11-gh §4), built from the owners'
 * exports. ETag/If-None-Match → 304 so a phone on venue Wi-Fi re-downloads nothing unchanged.
 */
export function guestHomeRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; objectStore: ObjectStore; rsvp: RsvpService }) {
  const { prisma } = deps;

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/guest/home',
    summary: 'Everything the guest home needs, for my party (ETag supported)',
    tags: ['guest'],
    auth: 'guest',
    response: { status: 200, schema: GuestHome },
    handler: async ({ req, res }) => {
      const g = req.guest!;
      const [wedding, me, party, events, rsvp, contacts] = await Promise.all([
        prisma.weddings.findUniqueOrThrow({ where: { id: g.weddingId } }),
        prisma.guests.findUniqueOrThrow({ where: { id: g.guestId }, select: { id: true, full_name: true } }),
        prisma.parties.findUniqueOrThrow({ where: { id: g.partyId }, select: { label: true, _count: { select: { guests: { where: { deleted_at: null } } } } } }),
        listInvitedEvents(prisma, g.partyId),
        deps.rsvp.partyState(g.partyId),
        prisma.wedding_contacts.findMany({ where: { wedding_id: g.weddingId }, orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] }),
      ]);
      let coverUrl: string | null = null;
      if (wedding.cover_media_id) {
        const m = await prisma.media_objects.findUnique({ where: { id: wedding.cover_media_id } });
        if (m && (m.status === 'uploaded' || m.status === 'processed')) coverUrl = await deps.objectStore.presignGet(m.s3_key, { bucket: m.s3_bucket, expiresInSeconds: 3600 });
      }
      const rsvpByEvent = new Map(rsvp.events.map((e) => [e.eventId, e]));
      const body = {
        wedding: {
          title: wedding.title,
          startsOn: wedding.starts_on.toISOString().slice(0, 10),
          endsOn: wedding.ends_on.toISOString().slice(0, 10),
          timezone: wedding.timezone,
          cities: wedding.cities,
          coverUrl,
          palette: readSettings(wedding.settings).branding.palette,
        },
        me: { guestId: me.id, fullName: me.full_name },
        party: { label: party.label, memberCount: party._count.guests },
        events: events.map((e) => {
          const r = rsvpByEvent.get(e.id)!;
          return {
            id: e.id,
            kind: e.kind,
            name: e.name,
            startsAt: e.startsAt.toISOString(),
            endsAt: e.endsAt?.toISOString() ?? null,
            dressCode: e.dressCode,
            notes: e.notes,
            venue: e.venue,
            rsvp: {
              enabled: e.rsvpEnabled,
              closed: r.closed,
              answered: r.answers.filter((a) => a.status).length,
              attending: r.answers.filter((a) => a.status === 'attending').length,
              total: r.answers.length,
            },
          };
        }),
        contacts: contacts.map((c) => ({ side: c.side, label: c.label, name: c.name, phone: c.phone_e164, hasWhatsapp: c.has_whatsapp })),
        rsvpPending: rsvp.events.filter((e) => e.rsvpEnabled && !e.closed).reduce((n, e) => n + e.answers.filter((a) => !a.status).length, 0),
      };
      // Cover URLs are re-signed per request; leave them out of the ETag so it stays stable.
      const etag = `"${createHash('sha256').update(JSON.stringify({ ...body, wedding: { ...body.wedding, coverUrl: wedding.cover_media_id } })).digest('base64url').slice(0, 27)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      if (req.header('if-none-match') === etag) {
        res.status(304).end();
        return;
      }
      return body;
    },
  });
}
