import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { writeAudit } from '../audit';
import { WeddingParams } from '../weddings/schemas';
import { GroupSchema } from './schemas';
import type { GuestsService } from './service';

const GroupParams = z.object({ weddingId: z.string().uuid(), groupId: z.string().uuid() });
const Colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');

/** GST-06: custom groups/tags and bulk assignment. Built-in groups can be renamed but not deleted. */
export function groupRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; guests: GuestsService }) {
  const { prisma } = deps;
  const W = '/v1/weddings/:weddingId/groups';
  const actor = (req: Request) => ({ type: 'user' as const, id: req.principal!.userId, role: req.membership!.role });

  const load = async (weddingId: string, groupId: string) => {
    const g = await prisma.guest_groups.findFirst({ where: { id: groupId, wedding_id: weddingId } });
    if (!g) throw new AppError('GST_GROUP_NOT_FOUND', 'Group not found', 404);
    return g;
  };
  const view = async (weddingId: string, groupId: string) => (await deps.guests.groups(weddingId)).find((g) => g.id === groupId)!;
  const nameTaken = (e: unknown) => {
    if ((e as { code?: string }).code === 'P2002') throw new AppError('GST_GROUP_NAME_TAKEN', 'A group with that name exists', 409);
    throw e;
  };

  defineRoute(ctx, {
    method: 'post',
    path: W,
    summary: 'Create a custom group',
    tags: ['guests'],
    auth: 'host',
    permission: 'group.write',
    errors: [409],
    request: { params: WeddingParams, body: z.object({ name: z.string().trim().min(1).max(40), colour: Colour.optional() }) },
    response: { status: 201, schema: GroupSchema },
    handler: async ({ req, params, body }) => {
      const max = await prisma.guest_groups.aggregate({ where: { wedding_id: params.weddingId }, _max: { sort_order: true } });
      const g = await prisma.guest_groups
        .create({ data: { wedding_id: params.weddingId, name: body.name, colour: body.colour, sort_order: (max._max.sort_order ?? 0) + 1 } })
        .catch(nameTaken);
      await writeAudit(prisma, { weddingId: params.weddingId, actor: actor(req), action: 'group.create', entityType: 'group', entityId: g.id, after: { name: g.name }, requestId: String(req.id) });
      return view(params.weddingId, g.id);
    },
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/:groupId`,
    summary: 'Rename or recolour a group',
    tags: ['guests'],
    auth: 'host',
    permission: 'group.write',
    errors: [404, 409],
    request: { params: GroupParams, body: z.object({ name: z.string().trim().min(1).max(40).optional(), colour: Colour.nullable().optional() }) },
    response: { status: 200, schema: GroupSchema },
    handler: async ({ req, params, body }) => {
      const before = await load(params.weddingId, params.groupId);
      await prisma.guest_groups.update({ where: { id: params.groupId }, data: { name: body.name, colour: body.colour } }).catch(nameTaken);
      await writeAudit(prisma, {
        weddingId: params.weddingId,
        actor: actor(req),
        action: 'group.update',
        entityType: 'group',
        entityId: params.groupId,
        before: { name: before.name, colour: before.colour },
        after: body,
        requestId: String(req.id),
      });
      return view(params.weddingId, params.groupId);
    },
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/:groupId`,
    summary: 'Delete a custom group (parties stay; built-in groups cannot be deleted)',
    tags: ['guests'],
    auth: 'host',
    permission: 'group.write',
    errors: [404, 409],
    request: { params: GroupParams },
    response: { status: 204 },
    handler: async ({ req, params }) => {
      const g = await load(params.weddingId, params.groupId);
      if (g.system_key) throw new AppError('GST_GROUP_BUILTIN', 'Built-in groups cannot be deleted', 409);
      await prisma.guest_groups.delete({ where: { id: g.id } });
      await writeAudit(prisma, { weddingId: params.weddingId, actor: actor(req), action: 'group.delete', entityType: 'group', entityId: g.id, before: { name: g.name }, requestId: String(req.id) });
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:groupId/parties`,
    summary: 'Add or remove up to 500 parties to/from a group',
    tags: ['guests'],
    auth: 'host',
    permission: 'group.write',
    errors: [404],
    request: {
      params: GroupParams,
      body: z.object({ op: z.enum(['add', 'remove']), partyIds: z.array(z.string().uuid()).min(1).max(500) }),
    },
    response: { status: 200, schema: z.object({ changed: z.number().int(), group: GroupSchema }) },
    handler: async ({ req, params, body }) => {
      await load(params.weddingId, params.groupId);
      const parties = await prisma.parties.findMany({
        where: { id: { in: body.partyIds }, wedding_id: params.weddingId, deleted_at: null },
        select: { id: true },
      });
      if (parties.length !== new Set(body.partyIds).size) throw new AppError('GST_PARTY_NOT_FOUND', 'Some parties are not in this wedding', 404);
      const changed =
        body.op === 'add'
          ? (await prisma.party_groups.createMany({ data: parties.map((p) => ({ party_id: p.id, group_id: params.groupId })), skipDuplicates: true })).count
          : (await prisma.party_groups.deleteMany({ where: { group_id: params.groupId, party_id: { in: body.partyIds } } })).count;
      await writeAudit(prisma, {
        weddingId: params.weddingId,
        actor: actor(req),
        action: `group.bulk_${body.op}`,
        entityType: 'group',
        entityId: params.groupId,
        after: { parties: body.partyIds.length, changed },
        requestId: String(req.id),
      });
      return { changed, group: await view(params.weddingId, params.groupId) };
    },
  });
}
