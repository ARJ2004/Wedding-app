import type { PrismaClient } from '@prisma/client';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import type { IdTokenVerifier } from '../../common/auth/verifiers';
import type { TokenService } from '../../common/auth/tokens';
import { writeAudit } from '../audit';

const DeviceId = z.string().min(16).max(64).openapi({ example: '8f1c2a9e0b7d4c6fa1e2b3c4d5e6f708' });

const WeddingSummary = z
  .object({ id: z.string().uuid(), title: z.string(), role: z.enum(['owner', 'co_host', 'planner_member', 'desk_staff']) })
  .openapi('WeddingMembership');

export const MeSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    isOpsAdmin: z.boolean(),
    weddings: z.array(WeddingSummary),
  })
  .openapi('Me');

const AuthResponse = z
  .object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number().int(), user: MeSchema })
  .openapi('AuthResponse');

/** Weddings the user can open, with their role (explicit membership, else org-admin implicit). */
export async function weddingsForUser(prisma: PrismaClient, userId: string) {
  const rows = await prisma.$queryRaw<{ id: string; title: string; role: string }[]>`
    SELECT w.id, w.title, COALESCE(wm.role, 'planner_member') AS role
    FROM weddings w
    LEFT JOIN wedding_members wm ON wm.wedding_id = w.id AND wm.user_id = ${userId}::uuid
    LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ${userId}::uuid
    WHERE w.deleted_at IS NULL
      AND (wm.user_id IS NOT NULL OR om.org_role IN ('org_owner','org_admin'))
    ORDER BY w.starts_on, w.title`;
  return rows as { id: string; title: string; role: 'owner' | 'co_host' | 'planner_member' | 'desk_staff' }[];
}

export async function meFor(prisma: PrismaClient, userId: string, opsAdmins: string[]) {
  const user = await prisma.users.findFirst({ where: { id: userId, deleted_at: null } });
  if (!user) throw new AppError('AUTH_UNAUTHENTICATED', 'Sign in again', 401);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    isOpsAdmin: opsAdmins.includes(user.email.toLowerCase()),
    weddings: await weddingsForUser(prisma, user.id),
  };
}

export function authRoutes(
  ctx: RouteContext,
  deps: { prisma: PrismaClient; tokens: TokenService; verifiers: IdTokenVerifier[]; opsAdmins: string[] },
) {
  const { prisma, tokens } = deps;

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/auth/google',
    summary: 'Exchange a Google ID token (or dev:<email> with the dev bypass) for host tokens',
    tags: ['auth'],
    auth: 'public',
    errors: [401, 429, 503],
    request: { body: z.object({ idToken: z.string().min(5).max(4096), deviceId: DeviceId }) },
    response: { status: 200, schema: AuthResponse },
    handler: async ({ body, req }) => {
      const verifier = deps.verifiers.find((v) => v.accepts(body.idToken));
      if (!verifier) throw new AppError('AUTH_INVALID_GOOGLE_TOKEN', 'Unsupported sign-in token', 401);
      const identity = await verifier.verify(body.idToken);
      const user = await prisma.$transaction(async (tx) => {
        const existing = await tx.users.findUnique({ where: { google_sub: identity.sub } });
        if (existing?.deleted_at) throw new AppError('AUTH_ACCOUNT_DELETED', 'This account was deleted', 401);
        const u = await tx.users.upsert({
          where: { google_sub: identity.sub },
          update: { email: identity.email, name: identity.name ?? undefined, avatar_url: identity.picture, last_sign_in_at: new Date() },
          create: { google_sub: identity.sub, email: identity.email, name: identity.name, avatar_url: identity.picture, last_sign_in_at: new Date() },
        });
        await writeAudit(tx, {
          actor: { type: 'user', id: u.id, label: u.name ?? u.email },
          action: 'auth.sign_in',
          entityType: 'user',
          entityId: u.id,
          after: { provider: verifier.name },
          requestId: String(req.id),
        });
        return u;
      });
      const session = await tokens.issueHostSession(user.id, body.deviceId);
      return { ...session, user: await meFor(prisma, user.id, deps.opsAdmins) };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/auth/refresh',
    summary: 'Rotate a refresh token',
    tags: ['auth'],
    auth: 'public',
    errors: [401, 429],
    request: { body: z.object({ refreshToken: z.string().min(20).max(200), deviceId: DeviceId }) },
    response: { status: 200, schema: AuthResponse },
    handler: async ({ body }) => {
      const rotated = await tokens.rotate(body.refreshToken, body.deviceId);
      return {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        expiresIn: rotated.expiresIn,
        user: await meFor(prisma, rotated.userId, deps.opsAdmins),
      };
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/auth/logout',
    summary: "Sign out this device (revokes this session's refresh tokens)",
    tags: ['auth'],
    auth: 'host',
    response: { status: 204 },
    handler: async ({ req }) => {
      await tokens.revokeFamily(req.principal!.familyId, 'logout');
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/auth/logout-all',
    summary: 'Sign out everywhere',
    tags: ['auth'],
    auth: 'host',
    response: { status: 204 },
    handler: async ({ req }) => {
      await tokens.revokeAllForUser(req.principal!.userId, 'logout');
    },
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/me',
    summary: 'Signed-in host profile and the weddings they can open',
    tags: ['auth'],
    auth: 'host',
    response: { status: 200, schema: MeSchema },
    handler: ({ req }) => meFor(prisma, req.principal!.userId, deps.opsAdmins),
  });
}
