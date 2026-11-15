import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { z } from '../../common/openapi';
import { WeddingParams } from '../weddings/schemas';
import {
  AddGuestSchema,
  CreatePartySchema,
  GroupSchema,
  GuestParams,
  ListPartiesQuery,
  PartyParams,
  PartySchema,
  UpdateGuestSchema,
  UpdatePartySchema,
} from './schemas';
import { groupRoutes } from './groups';
import { GuestsService, type Actor } from './service';

const actor = (req: Request): Actor => ({ userId: req.principal!.userId, role: req.membership!.role, requestId: String(req.id) });

export function guestRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const svc = new GuestsService(deps.prisma);
  const W = '/v1/weddings/:weddingId';

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/parties`,
    summary: 'Parties with members; search by name, label or last 4+ phone digits',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.read',
    request: { params: WeddingParams, query: ListPartiesQuery },
    response: { status: 200, schema: z.object({ items: z.array(PartySchema), nextCursor: z.string().uuid().nullable() }) },
    handler: ({ req, params, query }) => svc.list(params.weddingId, req.membership!.role, query),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/parties/export.csv`,
    summary: 'Guest list as CSV (one row per guest)',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.export',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.string() },
    handler: async ({ params, res }) => {
      const csv = await svc.exportCsv(params.weddingId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="guest-list.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/parties`,
    summary: 'Create a party with its members; phones are normalised',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: WeddingParams, body: CreatePartySchema },
    response: { status: 201, schema: PartySchema },
    handler: ({ req, params, body }) => svc.create(actor(req), params.weddingId, body),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/parties/:partyId`,
    summary: 'One party',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.read',
    request: { params: PartyParams },
    response: { status: 200, schema: PartySchema },
    handler: ({ req, params }) => svc.get(params.weddingId, req.membership!.role, params.partyId),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/parties/:partyId`,
    summary: 'Edit a party (label, plus-ones, groups, language…)',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: PartyParams, body: UpdatePartySchema },
    response: { status: 200, schema: PartySchema },
    handler: ({ req, params, body }) => svc.update(actor(req), params.weddingId, params.partyId, body),
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/parties/:partyId`,
    summary: 'Remove a party (soft delete; its guest link stops working)',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: PartyParams },
    response: { status: 204 },
    handler: ({ req, params }) => svc.remove(actor(req), params.weddingId, params.partyId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/parties/:partyId/guests`,
    summary: 'Add a member or plus-one to a party',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: PartyParams, body: AddGuestSchema },
    response: { status: 201, schema: PartySchema },
    handler: ({ req, params, body }) => svc.addGuest(actor(req), params.weddingId, params.partyId, body),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/guests/:guestId`,
    summary: 'Edit a guest',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: GuestParams, body: UpdateGuestSchema },
    response: { status: 200, schema: PartySchema },
    handler: ({ req, params, body }) => svc.updateGuest(actor(req), params.weddingId, params.guestId, body),
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/guests/:guestId`,
    summary: 'Remove a non-primary guest',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.write',
    request: { params: GuestParams },
    response: { status: 200, schema: PartySchema },
    handler: ({ req, params }) => svc.removeGuest(actor(req), params.weddingId, params.guestId),
  });

  groupRoutes(ctx, { prisma: deps.prisma, guests: svc });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/groups`,
    summary: 'Groups with party counts',
    tags: ['guests'],
    auth: 'host',
    permission: 'guest.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.object({ items: z.array(GroupSchema) }) },
    handler: async ({ params }) => ({ items: await svc.groups(params.weddingId) }),
  });
}
