import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { WeddingParams } from '../weddings/schemas';
import type { Actor, TravelService } from './service';

const Uuid = z.string().uuid();
const Direction = z.enum(['arrival', 'departure']);
const Mode = z.enum(['flight', 'train', 'car', 'bus', 'other']);
const LegFields = {
  mode: Mode,
  carrierCode: z.string().trim().max(3).nullish(),
  serviceNumber: z.string().trim().max(20).nullish(),
  originCity: z.string().trim().max(80).nullish(),
  pointId: Uuid.nullish(),
  scheduledAt: z.string().datetime({ offset: true }),
  needsPickup: z.boolean().default(false),
  notes: z.string().trim().max(500).nullish(),
  guestIds: z.array(Uuid).min(1).max(30),
};
const CreateLeg = z.object({ direction: Direction, ...LegFields }).openapi('CreateTravelLeg');
const PatchLeg = z.object(LegFields).partial().openapi('UpdateTravelLeg');

const Point = z
  .object({ id: z.string(), kind: z.enum(['airport', 'station', 'bus_stand', 'other']), name: z.string(), code: z.string().nullable(), isActive: z.boolean(), pickupBufferMinutes: z.number().int(), transferMinutes: z.number().int() })
  .openapi('TravelPoint');
const Leg = z
  .object({
    id: z.string(),
    partyId: z.string(),
    version: z.number().int(),
    direction: Direction,
    mode: Mode,
    carrierCode: z.string().nullable(),
    serviceNumber: z.string().nullable(),
    originCity: z.string().nullable(),
    scheduledAt: z.string(),
    point: z.object({ id: z.string(), name: z.string(), kind: z.string() }).nullable(),
    needsPickup: z.boolean(),
    notes: z.string().nullable(),
    source: z.string(),
    guests: z.array(z.object({ id: z.string(), fullName: z.string() })),
    updatedAt: z.string(),
  })
  .openapi('TravelLeg');
const PartyTravel = z
  .object({
    status: z.enum(['pending', 'partial', 'submitted', 'not_travelling']),
    members: z.array(z.object({ id: z.string(), fullName: z.string() })),
    legs: z.array(Leg),
    points: z.array(Point),
  })
  .openapi('PartyTravel');

/** If-Match: "3" or W/"3" → 3; missing → null (the service answers 428). */
const ifMatch = (req: Request) => {
  const m = /(\d+)/.exec(req.header('if-match') ?? '');
  return m ? Number(m[1]) : null;
};
const guestActor = (req: Request): Actor => ({ type: 'guest', guestId: req.guest!.guestId });
const hostActor = (req: Request): Actor => ({ type: 'user', userId: req.principal!.userId, role: req.membership!.role });

export function travelRoutes(ctx: RouteContext, svc: TravelService) {
  // ── Guest ──
  defineRoute(ctx, {
    method: 'get',
    path: '/v1/guest/travel',
    summary: "My party's journeys, members and the arrival points to pick from",
    tags: ['guest'],
    auth: 'guest',
    response: { status: 200, schema: PartyTravel },
    handler: ({ req }) => svc.partyView(req.guest!.weddingId, req.guest!.partyId),
  });
  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/travel/legs',
    summary: 'Add an arrival or departure for some or all of the family',
    tags: ['guest'],
    auth: 'guest',
    request: { body: CreateLeg },
    response: { status: 201, schema: Leg },
    errors: [404, 409],
    handler: ({ req, body }) => svc.create(req.guest!.weddingId, req.guest!.partyId, body, guestActor(req)),
  });
  defineRoute(ctx, {
    method: 'patch',
    path: '/v1/guest/travel/legs/:legId',
    summary: 'Edit a journey (send If-Match with its version)',
    tags: ['guest'],
    auth: 'guest',
    request: { params: z.object({ legId: Uuid }), body: PatchLeg },
    response: { status: 200, schema: Leg },
    errors: [404, 409, 428],
    handler: ({ req, params, body }) => svc.update(req.guest!.weddingId, params.legId, ifMatch(req), body, guestActor(req), req.guest!.partyId),
  });
  defineRoute(ctx, {
    method: 'delete',
    path: '/v1/guest/travel/legs/:legId',
    summary: 'Remove a journey',
    tags: ['guest'],
    auth: 'guest',
    request: { params: z.object({ legId: Uuid }) },
    response: { status: 204 },
    errors: [404],
    handler: ({ req, params }) => svc.remove(req.guest!.weddingId, params.legId, guestActor(req), req.guest!.partyId),
  });
  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/travel/not-travelling',
    summary: "We live locally / aren't travelling",
    tags: ['guest'],
    auth: 'guest',
    response: { status: 204 },
    errors: [409],
    handler: ({ req }) => svc.notTravelling(req.guest!.weddingId, req.guest!.partyId, guestActor(req)),
  });

  // ── Host: points ──
  const W = '/v1/weddings/:weddingId';
  defineRoute(ctx, {
    method: 'get',
    path: `${W}/travel-points`,
    summary: 'Arrival points (airport, station, bus stand)',
    tags: ['travel'],
    auth: 'host',
    permission: 'event.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.object({ items: z.array(Point) }) },
    handler: async ({ params }) => ({ items: await svc.listPoints(params.weddingId) }),
  });
  const PointInput = z.object({
    kind: z.enum(['airport', 'station', 'bus_stand', 'other']),
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().max(5).nullish(),
    pickupBufferMinutes: z.number().int().min(0).max(180).optional(),
    transferMinutes: z.number().int().min(0).max(600).optional(),
  });
  defineRoute(ctx, {
    method: 'post',
    path: `${W}/travel-points`,
    summary: 'Add an arrival point',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: WeddingParams, body: PointInput },
    response: { status: 201, schema: z.object({ items: z.array(Point) }) },
    errors: [409],
    handler: async ({ params, body }) => ({ items: await svc.createPoint(params.weddingId, body) }),
  });
  const PointParams = WeddingParams.extend({ pointId: Uuid });
  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/travel-points/:pointId`,
    summary: 'Edit or hide an arrival point',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: PointParams, body: PointInput.omit({ kind: true }).partial().extend({ isActive: z.boolean().optional() }) },
    response: { status: 200, schema: z.object({ items: z.array(Point) }) },
    errors: [404],
    handler: async ({ params, body }) => ({ items: await svc.updatePoint(params.weddingId, params.pointId, body) }),
  });
  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/travel-points/:pointId`,
    summary: 'Remove an arrival point (hidden if journeys use it)',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: PointParams },
    response: { status: 204 },
    errors: [404],
    handler: ({ params }) => svc.deletePoint(params.weddingId, params.pointId),
  });

  // ── Host: legs on behalf of a party ──
  defineRoute(ctx, {
    method: 'get',
    path: `${W}/travel/legs`,
    summary: 'Journeys for the wedding (or one party)',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.read',
    request: { params: WeddingParams, query: z.object({ direction: Direction.optional(), partyId: Uuid.optional() }) },
    response: { status: 200, schema: z.object({ items: z.array(Leg) }) },
    handler: async ({ params, query }) => ({ items: await svc.hostLegs(params.weddingId, query) }),
  });
  defineRoute(ctx, {
    method: 'post',
    path: `${W}/travel/legs`,
    summary: "Add a journey for a party (e.g. they phoned it in)",
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: WeddingParams, body: CreateLeg.extend({ partyId: Uuid }) },
    response: { status: 201, schema: Leg },
    errors: [404, 409],
    handler: async ({ params, body, req }) => {
      const { partyId, ...input } = body;
      const ok = await svc.partyInWedding(params.weddingId, partyId);
      if (!ok) return svc.notFoundParty();
      return svc.create(params.weddingId, partyId, input, hostActor(req));
    },
  });
  const LegParams = WeddingParams.extend({ legId: Uuid });
  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/travel/legs/:legId`,
    summary: 'Edit a journey (send If-Match with its version)',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: LegParams, body: PatchLeg },
    response: { status: 200, schema: Leg },
    errors: [404, 409, 428],
    handler: ({ params, body, req }) => svc.update(params.weddingId, params.legId, ifMatch(req), body, hostActor(req)),
  });
  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/travel/legs/:legId`,
    summary: 'Remove a journey',
    tags: ['travel'],
    auth: 'host',
    permission: 'travel.write',
    request: { params: LegParams },
    response: { status: 204 },
    errors: [404],
    handler: ({ params, req }) => svc.remove(params.weddingId, params.legId, hostActor(req)),
  });
}
