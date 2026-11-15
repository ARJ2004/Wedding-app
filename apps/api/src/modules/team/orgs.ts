import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { sha256 } from '../../common/auth/tokens';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { writeAudit } from '../audit';

const Uuid = z.string().uuid();
const OrgRole = z.enum(['org_owner', 'org_admin', 'org_member']);
const OrgParams = z.object({ organizationId: Uuid });
const MemberParams = z.object({ organizationId: Uuid, userId: Uuid });

const OrgSchema = z
  .object({ id: Uuid, name: z.string(), kind: z.enum(['family', 'planner', 'venue']), myRole: OrgRole, weddingCount: z.number().int() })
  .openapi('Organization');
const SeatSchema = z.object({ userId: Uuid, email: z.string(), name: z.string().nullable(), orgRole: OrgRole }).openapi('OrgSeat');
const InviteSchema = z
  .object({ id: Uuid, email: z.string(), orgRole: z.enum(['org_admin', 'org_member']), expiresAt: z.string(), inviteUrl: z.string().optional() })
  .openapi('OrgInvitation');

const INVITE_BASE = 'https://mehfil.app/i/';

/**
 * ROL-04b: planner agencies (10-rol §4). Seats: org_owner/org_admin manage seats and get implicit
 * planner_member on every org wedding; org_member sees only weddings they are added to. Only an
 * org_owner may grant or change org_admin/owner seats; the last org_owner cannot leave.
 */
export function orgRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const { prisma } = deps;
  const actorId = (req: Request) => req.principal!.userId;

  async function seatOf(organizationId: string, userId: string) {
    const seat = await prisma.organization_members.findUnique({
      where: { organization_id_user_id: { organization_id: organizationId, user_id: userId } },
    });
    if (!seat) throw new AppError('ORG_NOT_FOUND', 'Organisation not found', 404);
    return seat.org_role as z.infer<typeof OrgRole>;
  }
  const manager = async (organizationId: string, userId: string) => {
    const role = await seatOf(organizationId, userId);
    if (role === 'org_member') throw new AppError('ROL_FORBIDDEN', 'Only org owners and admins manage seats', 403);
    return role;
  };

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/organizations',
    summary: 'Organisations I hold a seat in',
    tags: ['organizations'],
    auth: 'host',
    response: { status: 200, schema: z.object({ items: z.array(OrgSchema) }) },
    handler: async ({ req }) => {
      const rows = await prisma.$queryRaw<{ id: string; name: string; kind: string; org_role: string; wedding_count: bigint }[]>`
        SELECT o.id, o.name, o.kind, om.org_role,
               (SELECT count(*) FROM weddings w WHERE w.organization_id = o.id AND w.deleted_at IS NULL) AS wedding_count
        FROM organization_members om JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = ${actorId(req)}::uuid ORDER BY o.name`;
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind as 'family' | 'planner' | 'venue',
          myRole: r.org_role as z.infer<typeof OrgRole>,
          weddingCount: Number(r.wedding_count),
        })),
      };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/organizations',
    summary: 'Create a planner or venue organisation; the caller becomes org_owner',
    tags: ['organizations'],
    auth: 'host',
    request: { body: z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(['planner', 'venue']).default('planner') }) },
    response: { status: 201, schema: OrgSchema },
    handler: async ({ req, body }) =>
      prisma.$transaction(async (tx) => {
        const org = await tx.organizations.create({ data: { name: body.name, kind: body.kind, created_by: actorId(req) } });
        await tx.organization_members.create({ data: { organization_id: org.id, user_id: actorId(req), org_role: 'org_owner' } });
        await writeAudit(tx, {
          organizationId: org.id,
          actor: { type: 'user', id: actorId(req), role: 'org_owner' },
          action: 'org.create',
          entityType: 'organization',
          entityId: org.id,
          after: { name: org.name, kind: org.kind },
          requestId: String(req.id),
        });
        return { id: org.id, name: org.name, kind: body.kind, myRole: 'org_owner' as const, weddingCount: 0 };
      }),
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/organizations/:organizationId/members',
    summary: 'Seats and open invitations',
    tags: ['organizations'],
    auth: 'host',
    errors: [403, 404],
    request: { params: OrgParams },
    response: { status: 200, schema: z.object({ seats: z.array(SeatSchema), invitations: z.array(InviteSchema) }) },
    handler: async ({ req, params }) => {
      await manager(params.organizationId, actorId(req));
      const seats = await prisma.organization_members.findMany({
        where: { organization_id: params.organizationId },
        include: { users: { select: { email: true, name: true } } },
        orderBy: { created_at: 'asc' },
      });
      const invites = await prisma.team_invitations.findMany({
        where: { organization_id: params.organizationId, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } },
        orderBy: { created_at: 'asc' },
      });
      return {
        seats: seats.map((s) => ({ userId: s.user_id, email: s.users.email, name: s.users.name, orgRole: s.org_role as z.infer<typeof OrgRole> })),
        invitations: invites.map((i) => ({ id: i.id, email: i.email, orgRole: i.org_role as 'org_admin' | 'org_member', expiresAt: i.expires_at.toISOString() })),
      };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/organizations/:organizationId/invitations',
    summary: 'Invite someone to a seat; the invite URL is returned once (share it from the phone)',
    tags: ['organizations'],
    auth: 'host',
    errors: [403, 404, 409],
    request: { params: OrgParams, body: z.object({ email: z.string().trim().toLowerCase().email(), orgRole: z.enum(['org_admin', 'org_member']) }) },
    response: { status: 201, schema: InviteSchema },
    handler: async ({ req, params, body }) => {
      const myRole = await manager(params.organizationId, actorId(req));
      if (body.orgRole === 'org_admin' && myRole !== 'org_owner') {
        throw new AppError('ROL_ROLE_NOT_ASSIGNABLE', 'Only an org owner can add admins', 403);
      }
      const existingSeat = await prisma.organization_members.findFirst({
        where: { organization_id: params.organizationId, users: { email: body.email } },
      });
      if (existingSeat) throw new AppError('ROL_ALREADY_MEMBER', 'That person already has a seat', 409);
      const open = await prisma.team_invitations.findFirst({
        where: { organization_id: params.organizationId, email: body.email, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } },
      });
      if (open) throw new AppError('ROL_INVITE_EXISTS', 'An invitation is already open for that email', 409);
      const token = randomBytes(16).toString('base64url');
      const invite = await prisma.$transaction(async (tx) => {
        const inv = await tx.team_invitations.create({
          data: { organization_id: params.organizationId, email: body.email, org_role: body.orgRole, token_hash: sha256(token), invited_by: actorId(req) },
        });
        await writeAudit(tx, {
          organizationId: params.organizationId,
          actor: { type: 'user', id: actorId(req), role: myRole },
          action: 'org.invite',
          entityType: 'team_invitation',
          entityId: inv.id,
          after: { email: body.email, orgRole: body.orgRole },
          requestId: String(req.id),
        });
        return inv;
      });
      return { id: invite.id, email: invite.email, orgRole: body.orgRole, expiresAt: invite.expires_at.toISOString(), inviteUrl: `${INVITE_BASE}${token}` };
    },
  });

  defineRoute(ctx, {
    method: 'patch',
    path: '/v1/organizations/:organizationId/members/:userId',
    summary: 'Change a seat',
    tags: ['organizations'],
    auth: 'host',
    errors: [403, 404, 409],
    request: { params: MemberParams, body: z.object({ orgRole: OrgRole }) },
    response: { status: 200, schema: SeatSchema },
    handler: async ({ req, params, body }) => {
      const myRole = await manager(params.organizationId, actorId(req));
      const target = await seatOf(params.organizationId, params.userId).catch(() => {
        throw new AppError('ORG_SEAT_NOT_FOUND', 'Seat not found', 404);
      });
      const touchesPrivileged = body.orgRole !== 'org_member' || target !== 'org_member';
      if (touchesPrivileged && myRole !== 'org_owner') {
        throw new AppError('ROL_ROLE_NOT_ASSIGNABLE', 'Only an org owner can change owner or admin seats', 403);
      }
      return prisma.$transaction(async (tx) => {
        if (target === 'org_owner' && body.orgRole !== 'org_owner') {
          const owners = await tx.organization_members.count({ where: { organization_id: params.organizationId, org_role: 'org_owner' } });
          if (owners <= 1) throw new AppError('ROL_LAST_ORG_OWNER', 'An organisation needs at least one owner', 409);
        }
        const seat = await tx.organization_members.update({
          where: { organization_id_user_id: { organization_id: params.organizationId, user_id: params.userId } },
          data: { org_role: body.orgRole },
          include: { users: { select: { email: true, name: true } } },
        });
        await writeAudit(tx, {
          organizationId: params.organizationId,
          actor: { type: 'user', id: actorId(req), role: myRole },
          action: 'org.seat_change',
          entityType: 'organization_member',
          entityId: params.userId,
          before: { orgRole: target },
          after: { orgRole: body.orgRole },
          requestId: String(req.id),
        });
        return { userId: seat.user_id, email: seat.users.email, name: seat.users.name, orgRole: body.orgRole };
      });
    },
  });

  defineRoute(ctx, {
    method: 'delete',
    path: '/v1/organizations/:organizationId/members/:userId',
    summary: "Remove a seat; also removes their membership of the org's weddings",
    tags: ['organizations'],
    auth: 'host',
    errors: [403, 404, 409],
    request: { params: MemberParams },
    response: { status: 204 },
    handler: async ({ req, params }) => {
      const self = params.userId === actorId(req);
      const myRole = self ? await seatOf(params.organizationId, actorId(req)) : await manager(params.organizationId, actorId(req));
      const target = self ? myRole : await seatOf(params.organizationId, params.userId).catch(() => {
        throw new AppError('ORG_SEAT_NOT_FOUND', 'Seat not found', 404);
      });
      if (!self && target !== 'org_member' && myRole !== 'org_owner') {
        throw new AppError('ROL_ROLE_NOT_ASSIGNABLE', 'Only an org owner can remove owners or admins', 403);
      }
      await prisma.$transaction(async (tx) => {
        if (target === 'org_owner') {
          const owners = await tx.organization_members.count({ where: { organization_id: params.organizationId, org_role: 'org_owner' } });
          if (owners <= 1) throw new AppError('ROL_LAST_ORG_OWNER', 'An organisation needs at least one owner', 409);
        }
        await tx.organization_members.delete({
          where: { organization_id_user_id: { organization_id: params.organizationId, user_id: params.userId } },
        });
        const removed = await tx.$executeRaw`
          DELETE FROM wedding_members wm USING weddings w
          WHERE wm.wedding_id = w.id AND w.organization_id = ${params.organizationId}::uuid
            AND wm.user_id = ${params.userId}::uuid AND wm.role <> 'owner'`;
        await writeAudit(tx, {
          organizationId: params.organizationId,
          actor: { type: 'user', id: actorId(req), role: myRole },
          action: 'org.seat_remove',
          entityType: 'organization_member',
          entityId: params.userId,
          before: { orgRole: target },
          after: { weddingMembershipsRemoved: removed },
          requestId: String(req.id),
        });
      });
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/invitations/:token/accept',
    summary: 'Accept an organisation (or wedding) invitation by link',
    tags: ['organizations'],
    auth: 'host',
    errors: [403, 404, 409, 410],
    request: { params: z.object({ token: z.string().min(16).max(64) }) },
    response: { status: 200, schema: z.object({ organizationId: Uuid.nullable(), weddingId: Uuid.nullable() }) },
    handler: async ({ req, params }) =>
      prisma.$transaction(async (tx) => {
        const inv = await tx.team_invitations.findUnique({ where: { token_hash: sha256(params.token) } });
        if (!inv) throw new AppError('ROL_INVITE_NOT_FOUND', 'Invitation not found', 404);
        if (inv.accepted_at || inv.revoked_at) throw new AppError('ROL_INVITE_USED', 'This invitation was already used', 409);
        if (inv.expires_at < new Date()) throw new AppError('ROL_INVITE_EXPIRED', 'This invitation has expired', 410);
        const user = await tx.users.findUniqueOrThrow({ where: { id: actorId(req) } });
        if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
          throw new AppError('ROL_INVITE_EMAIL_MISMATCH', `Sign in as ${inv.email} to accept`, 403);
        }
        if (inv.organization_id) {
          await tx.organization_members.upsert({
            where: { organization_id_user_id: { organization_id: inv.organization_id, user_id: user.id } },
            update: {},
            create: { organization_id: inv.organization_id, user_id: user.id, org_role: inv.org_role! },
          });
        } else if (inv.wedding_id) {
          await tx.wedding_members.upsert({
            where: { wedding_id_user_id: { wedding_id: inv.wedding_id, user_id: user.id } },
            update: {},
            create: { wedding_id: inv.wedding_id, user_id: user.id, role: inv.role!, invited_by: inv.invited_by },
          });
        }
        await tx.team_invitations.update({ where: { id: inv.id }, data: { accepted_at: new Date(), accepted_by: user.id } });
        await writeAudit(tx, {
          organizationId: inv.organization_id,
          weddingId: inv.wedding_id,
          actor: { type: 'user', id: user.id },
          action: 'invite.accept',
          entityType: 'team_invitation',
          entityId: inv.id,
          requestId: String(req.id),
        });
        return { organizationId: inv.organization_id, weddingId: inv.wedding_id };
      }),
  });
}
