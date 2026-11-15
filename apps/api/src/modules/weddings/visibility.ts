import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { writeAudit } from '../audit';
import { EventParams } from './schemas';

export interface InvitedEvent {
  id: string;
  kind: string;
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  dressCode: string | null;
  notes: string | null;
  sortOrder: number;
  rsvpEnabled: boolean;
  rsvpClosesAt: Date | null;
  venue: { name: string; address: string | null; mapsUrl: string | null; lat: number | null; lng: number | null; parkingNotes: string | null } | null;
}

/** SET-04 source of truth for "which events can this party see" (party_invited_events view). */
export async function listInvitedEvents(prisma: PrismaClient, partyId: string): Promise<InvitedEvent[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string; kind: string; name: string; starts_at: Date; ends_at: Date | null; dress_code: string | null; notes: string | null;
      sort_order: number; rsvp_enabled: boolean; rsvp_closes_at: Date | null;
      v_name: string | null; v_address: string | null; v_maps_url: string | null; v_lat: number | null; v_lng: number | null; v_parking: string | null;
    }[]
  >`SELECT e.id, e.kind, e.name, e.starts_at, e.ends_at, e.dress_code, e.notes, e.sort_order, e.rsvp_enabled, e.rsvp_closes_at,
           v.name AS v_name, v.address AS v_address, v.maps_url AS v_maps_url, v.lat AS v_lat, v.lng AS v_lng, v.parking_notes AS v_parking
    FROM party_invited_events pie
    JOIN events e ON e.id = pie.event_id
    LEFT JOIN venues v ON v.id = e.venue_id
    WHERE pie.party_id = ${partyId}::uuid
    ORDER BY e.starts_at, e.sort_order`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    dressCode: r.dress_code,
    notes: r.notes,
    sortOrder: r.sort_order,
    rsvpEnabled: r.rsvp_enabled,
    rsvpClosesAt: r.rsvp_closes_at,
    venue: r.v_name ? { name: r.v_name, address: r.v_address, mapsUrl: r.v_maps_url, lat: r.v_lat, lng: r.v_lng, parkingNotes: r.v_parking } : null,
  }));
}

export function visibilityRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  const audience = async (eventId: string) => {
    const [r] = await prisma.$queryRaw<{ parties: bigint; guests: bigint }[]>`
      SELECT count(DISTINCT pie.party_id) AS parties, count(g.id) AS guests
      FROM party_invited_events pie JOIN guests g ON g.party_id = pie.party_id AND g.deleted_at IS NULL
      WHERE pie.event_id = ${eventId}::uuid`;
    return { parties: Number(r?.parties ?? 0), guests: Number(r?.guests ?? 0) };
  };

  defineRoute(ctx, {
    method: 'put',
    path: '/v1/weddings/:weddingId/events/:eventId/groups',
    summary: 'Who sees this event: everyone, or only parties in the chosen groups',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    errors: [404],
    request: {
      params: EventParams,
      body: z.object({ visibility: z.enum(['all', 'groups']), groupIds: z.array(z.string().uuid()).max(20).default([]) }),
    },
    response: { status: 200, schema: z.object({ visibility: z.enum(['all', 'groups']), groupIds: z.array(z.string().uuid()), audience: z.object({ parties: z.number(), guests: z.number() }) }) },
    handler: async ({ req, params, body }) => {
      const ev = await prisma.events.findFirst({ where: { id: params.eventId, wedding_id: params.weddingId, deleted_at: null } });
      if (!ev) throw new AppError('SET_EVENT_NOT_FOUND', 'Event not found', 404);
      if (body.visibility === 'groups' && body.groupIds.length === 0) {
        throw new AppError('SET_VISIBILITY_EMPTY', 'Pick at least one group, or show the event to everyone', 400);
      }
      const ids = body.visibility === 'groups' ? [...new Set(body.groupIds)] : [];
      if (ids.length && (await prisma.guest_groups.count({ where: { id: { in: ids }, wedding_id: params.weddingId } })) !== ids.length) {
        throw new AppError('SET_GROUP_NOT_FOUND', 'Group not found in this wedding', 400);
      }
      await prisma.$transaction(async (tx) => {
        await tx.events.update({ where: { id: ev.id }, data: { visibility: body.visibility, updated_by: (req as Request).principal!.userId } });
        await tx.event_groups.deleteMany({ where: { event_id: ev.id } });
        if (ids.length) await tx.event_groups.createMany({ data: ids.map((group_id) => ({ event_id: ev.id, group_id })) });
        await writeAudit(tx, {
          weddingId: params.weddingId,
          actor: { type: 'user', id: req.principal!.userId, role: req.membership!.role },
          action: 'event.visibility.update',
          entityType: 'event',
          entityId: ev.id,
          before: { visibility: ev.visibility },
          after: { visibility: body.visibility, groupIds: ids },
          requestId: String(req.id),
        });
      });
      return { visibility: body.visibility, groupIds: ids, audience: await audience(ev.id) };
    },
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/events/:eventId/audience',
    summary: 'How many parties and guests can see this event',
    tags: ['events'],
    auth: 'host',
    permission: 'event.read',
    request: { params: EventParams },
    response: { status: 200, schema: z.object({ parties: z.number(), guests: z.number() }) },
    handler: async ({ params }) => {
      const ev = await prisma.events.findFirst({ where: { id: params.eventId, wedding_id: params.weddingId, deleted_at: null } });
      if (!ev) throw new AppError('SET_EVENT_NOT_FOUND', 'Event not found', 404);
      return audience(ev.id);
    },
  });
}
