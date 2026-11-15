import type { PrismaClient } from '@prisma/client';
import { EVENT_PRESETS } from '@mehfil/domain';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { z } from '../../common/openapi';
import { weddingsForUser } from '../auth';
import {
  BulkPresetsSchema,
  CreateEventSchema,
  CreateVenueSchema,
  CreateWeddingSchema,
  EventOrderSchema,
  EventParams,
  EventPresetSchema,
  EventSchema,
  UpdateEventSchema,
  UpdateVenueSchema,
  UpdateWeddingSchema,
  VenueParams,
  VenueSchema,
  WeddingParams,
  WeddingSchema,
} from './schemas';
import { WeddingsService, type Actor } from './service';

const actor = (req: Request): Actor => ({ userId: req.principal!.userId, role: req.membership?.role, requestId: String(req.id) });

export function weddingRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const svc = new WeddingsService(deps.prisma);
  const W = '/v1/weddings/:weddingId';

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings',
    summary: 'Weddings I can open, with my role',
    tags: ['weddings'],
    auth: 'host',
    response: {
      status: 200,
      schema: z.object({ items: z.array(z.object({ id: z.string().uuid(), title: z.string(), role: WeddingSchema.shape.myRole })) }),
    },
    handler: async ({ req }) => ({ items: await weddingsForUser(deps.prisma, req.principal!.userId) }),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/weddings',
    summary: 'Create a wedding; the caller becomes owner and built-in groups are added',
    tags: ['weddings'],
    auth: 'host',
    errors: [403],
    request: { body: CreateWeddingSchema },
    response: { status: 201, schema: WeddingSchema },
    handler: ({ req, body }) => svc.create(actor(req), body),
  });

  defineRoute(ctx, {
    method: 'get',
    path: W,
    summary: 'A wedding',
    tags: ['weddings'],
    auth: 'host',
    permission: 'wedding.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: WeddingSchema },
    handler: ({ req, params }) => svc.get(params.weddingId, req.membership!.role),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: W,
    summary: 'Edit names, title, dates, timezone, cities',
    tags: ['weddings'],
    auth: 'host',
    permission: 'wedding.update',
    request: { params: WeddingParams, body: UpdateWeddingSchema },
    response: { status: 200, schema: WeddingSchema },
    handler: ({ req, params, body }) => svc.update(actor(req), params.weddingId, body),
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/event-presets',
    summary: 'Event preset catalogue (Haldi, Mehendi, Sangeet, Baraat, Pheras, Reception)',
    tags: ['events'],
    auth: 'host',
    response: { status: 200, schema: z.object({ items: z.array(EventPresetSchema) }) },
    handler: () => ({ items: [...EVENT_PRESETS] }),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/events`,
    summary: 'Live events in display order',
    tags: ['events'],
    auth: 'host',
    permission: 'event.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.object({ items: z.array(EventSchema) }) },
    handler: async ({ params }) => ({ items: await svc.listEvents(params.weddingId) }),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/events`,
    summary: 'Create an event (from a preset kind or custom)',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: WeddingParams, body: CreateEventSchema },
    response: { status: 201, schema: EventSchema },
    handler: ({ req, params, body }) => svc.createEvent(actor(req), params.weddingId, body),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/events/bulk-from-presets`,
    summary: 'One-click add of presets on chosen dates (times in the wedding timezone)',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: WeddingParams, body: BulkPresetsSchema },
    response: { status: 201, schema: z.object({ items: z.array(EventSchema) }) },
    handler: async ({ req, params, body }) => ({ items: await svc.bulkFromPresets(actor(req), params.weddingId, body) }),
  });

  defineRoute(ctx, {
    method: 'put',
    path: `${W}/events/order`,
    summary: 'Reorder events (full ordered list of live event ids)',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: WeddingParams, body: EventOrderSchema },
    response: { status: 200, schema: z.object({ items: z.array(EventSchema) }) },
    handler: async ({ req, params, body }) => ({ items: await svc.reorderEvents(actor(req), params.weddingId, body.eventIds) }),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/events/:eventId`,
    summary: 'Edit an event',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: EventParams, body: UpdateEventSchema },
    response: { status: 200, schema: EventSchema },
    handler: ({ req, params, body }) => svc.updateEvent(actor(req), params.weddingId, params.eventId, body),
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/events/:eventId`,
    summary: 'Soft-delete an event (restorable)',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: EventParams },
    response: { status: 200, schema: EventSchema },
    handler: ({ req, params }) => svc.deleteEvent(actor(req), params.weddingId, params.eventId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/events/:eventId/restore`,
    summary: 'Undo an event delete',
    tags: ['events'],
    auth: 'host',
    permission: 'event.write',
    request: { params: EventParams },
    response: { status: 200, schema: EventSchema },
    handler: ({ req, params }) => svc.deleteEvent(actor(req), params.weddingId, params.eventId, true),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/venues`,
    summary: 'Venues',
    tags: ['venues'],
    auth: 'host',
    permission: 'event.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.object({ items: z.array(VenueSchema) }) },
    handler: async ({ params }) => ({ items: await svc.listVenues(params.weddingId) }),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/venues`,
    summary: 'Create a venue; a pasted Maps link fills the pin',
    tags: ['venues'],
    auth: 'host',
    permission: 'venue.write',
    request: { params: WeddingParams, body: CreateVenueSchema },
    response: { status: 201, schema: VenueSchema },
    handler: ({ req, params, body }) => svc.createVenue(actor(req), params.weddingId, body),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/venues/:venueId`,
    summary: 'Edit a venue',
    tags: ['venues'],
    auth: 'host',
    permission: 'venue.write',
    request: { params: VenueParams, body: UpdateVenueSchema },
    response: { status: 200, schema: VenueSchema },
    handler: ({ req, params, body }) => svc.updateVenue(actor(req), params.weddingId, params.venueId, body),
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/venues/:venueId`,
    summary: 'Delete a venue (its events keep their times, lose the venue)',
    tags: ['venues'],
    auth: 'host',
    permission: 'venue.write',
    request: { params: VenueParams },
    response: { status: 204 },
    handler: ({ req, params }) => svc.deleteVenue(actor(req), params.weddingId, params.venueId),
  });
}
