import type { PrismaClient } from '@prisma/client';
import { can, isWeddingRole, type Action, type WeddingRole } from '@mehfil/domain';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors';
import type { TokenService } from './tokens';

export interface HostPrincipal {
  userId: string;
  familyId: string;
}

export interface Membership {
  weddingId: string;
  role: WeddingRole;
  /** true when access comes from being org_owner/org_admin of the wedding's org. */
  implicit: boolean;
}

export interface GuestPrincipal {
  guestId: string;
  partyId: string;
  weddingId: string;
  deviceId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: HostPrincipal;
    membership?: Membership;
    guest?: GuestPrincipal;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Loads the caller's role on a wedding (10-rol §4): explicit wedding_members row first, else
 * implicit planner_member for org_owner/org_admin of the wedding's org, else null (→ 404).
 * Read per request so removal takes effect immediately.
 */
export async function loadMembership(prisma: PrismaClient, userId: string, weddingId: string): Promise<Membership | null> {
  if (!UUID.test(weddingId)) return null;
  const rows = await prisma.$queryRaw<{ role: string | null; org_role: string | null }[]>`
    SELECT wm.role, om.org_role
    FROM weddings w
    LEFT JOIN wedding_members wm ON wm.wedding_id = w.id AND wm.user_id = ${userId}::uuid
    LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ${userId}::uuid
    WHERE w.id = ${weddingId}::uuid AND w.deleted_at IS NULL`;
  const row = rows[0];
  if (!row) return null;
  if (row.role && isWeddingRole(row.role)) return { weddingId, role: row.role, implicit: false };
  if (row.org_role === 'org_owner' || row.org_role === 'org_admin') {
    return { weddingId, role: 'planner_member', implicit: true };
  }
  return null;
}

export function createGuards(deps: { prisma: PrismaClient; tokens: TokenService }) {
  const authHost: RequestHandler = (req, _res, next) => {
    const token = bearer(req);
    if (!token) throw new AppError('AUTH_UNAUTHENTICATED', 'Sign in to continue', 401);
    const claims = deps.tokens.verifyHostAccess(token);
    req.principal = { userId: claims.sub, familyId: claims.sid };
    next();
  };

  /** 404 for weddings the caller can't see (never 403), 403 ROL_FORBIDDEN for a missing permission. */
  const requirePermission =
    (action: Action, weddingParam = 'weddingId'): RequestHandler =>
    async (req, _res, next) => {
      const raw = req.params[weddingParam];
      const weddingId = typeof raw === 'string' ? raw : undefined;
      const membership = req.principal && weddingId ? await loadMembership(deps.prisma, req.principal.userId, weddingId) : null;
      if (!membership) throw new AppError('WEDDING_NOT_FOUND', 'Wedding not found', 404);
      if (!can(membership.role, action)) {
        throw new AppError('ROL_FORBIDDEN', 'Your role on this wedding cannot do that', 403);
      }
      req.membership = membership;
      next();
    };

  /**
   * Guest JWT (aud=guest, separate secret, so a guest token can never pass authHost) plus a live
   * device check: a host revoking a device or rotating the link ends access immediately.
   */
  const authGuest: RequestHandler = async (req, _res, next) => {
    const token = bearer(req);
    if (!token) throw new AppError('AUTH_UNAUTHENTICATED', 'Open your invite link again', 401);
    const c = deps.tokens.verifyGuestAccess(token);
    const device = await deps.prisma.guest_devices.findUnique({ where: { id: c.sid }, select: { revoked_at: true, trusted_until: true } });
    if (!device || device.revoked_at || device.trusted_until < new Date()) {
      throw new AppError('ACC_DEVICE_EXPIRED', 'Open your invite link again', 401);
    }
    req.guest = { guestId: c.sub, partyId: c.pid, weddingId: c.wid, deviceId: c.sid };
    next();
  };

  /** Guests must have an active consent for the purpose (PRV-01); 403 tells the app to show the notice. */
  const requireConsent =
    (purpose: 'core' | 'photos' | 'face_match' | 'id_documents'): RequestHandler =>
    async (req, _res, next) => {
      const ok = await deps.prisma.consents.count({ where: { guest_id: req.guest!.guestId, purpose, withdrawn_at: null } });
      if (!ok) throw new AppError('ACC_CONSENT_REQUIRED', 'Please read and accept how we use your details', 403, { purpose });
      next();
    };

  return { authHost, authGuest, requireConsent, requirePermission };
}

export type Guards = ReturnType<typeof createGuards>;
