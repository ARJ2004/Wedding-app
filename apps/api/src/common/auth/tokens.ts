import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { AppError } from '../errors';

export interface HostClaims {
  sub: string; // user id
  sid: string; // refresh family id
}

export interface GuestClaims {
  sub: string; // active guest id
  pid: string; // party id
  wid: string; // wedding id
  sid: string; // guest_devices.id (= refresh family)
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Access JWTs (15 min, HS256, separate secrets per audience) and rotating refresh tokens
 * stored as sha256 in refresh_tokens. Reusing a rotated token revokes the whole family and
 * every live token of that principal (Expense-Tracker behaviour, 01-fnd §2).
 */
export class TokenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Pick<AppConfig, 'JWT_HOST_SECRET' | 'JWT_GUEST_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS' | 'REFRESH_TOKEN_TTL_DAYS'>,
  ) {}

  signHostAccess(claims: HostClaims): string {
    return jwt.sign({ sid: claims.sid }, this.config.JWT_HOST_SECRET, {
      algorithm: 'HS256',
      audience: 'host',
      subject: claims.sub,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  verifyHostAccess(token: string): HostClaims {
    try {
      const decoded = jwt.verify(token, this.config.JWT_HOST_SECRET, { algorithms: ['HS256'], audience: 'host' });
      if (typeof decoded === 'string' || !decoded.sub) throw new Error('bad claims');
      return { sub: decoded.sub, sid: String(decoded.sid) };
    } catch {
      throw new AppError('AUTH_UNAUTHENTICATED', 'Sign in again', 401);
    }
  }

  signGuestAccess(c: GuestClaims): string {
    return jwt.sign({ pid: c.pid, wid: c.wid, sid: c.sid }, this.config.JWT_GUEST_SECRET, {
      algorithm: 'HS256',
      audience: 'guest',
      subject: c.sub,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  verifyGuestAccess(token: string): GuestClaims {
    try {
      const d = jwt.verify(token, this.config.JWT_GUEST_SECRET, { algorithms: ['HS256'], audience: 'guest' });
      if (typeof d === 'string' || !d.sub) throw new Error('bad claims');
      return { sub: d.sub, pid: String(d.pid), wid: String(d.wid), sid: String(d.sid) };
    } catch {
      throw new AppError('AUTH_UNAUTHENTICATED', 'Open your invite link again', 401);
    }
  }

  /** Guest refresh token in the shared table: family = guest device, device_id = install id. */
  async issueGuestRefresh(input: { guestId: string; weddingId: string; installId: string; deviceId: string; expiresAt: Date }) {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refresh_tokens.create({
      data: {
        audience: 'guest',
        guest_id: input.guestId,
        wedding_id: input.weddingId,
        device_id: input.installId,
        family_id: input.deviceId,
        token_hash: sha256(refreshToken),
        expires_at: input.expiresAt,
      },
    });
    return refreshToken;
  }

  /** Rotates a guest refresh token; returns the row's family (device) or throws like host rotation. */
  async rotateGuest(refreshToken: string, installId: string) {
    const row = await this.prisma.refresh_tokens.findUnique({ where: { token_hash: sha256(refreshToken) } });
    if (!row || row.audience !== 'guest' || !row.guest_id || !row.wedding_id) throw new AppError('AUTH_REFRESH_INVALID', 'Open your invite link again', 401);
    if (row.revoked_at) {
      if (row.revoked_reason === 'rotated') {
        await this.revokeFamily(row.family_id, 'admin');
        throw new AppError('AUTH_REFRESH_REUSED', 'Session ended, open your invite link again', 401);
      }
      throw new AppError('AUTH_REFRESH_INVALID', 'Open your invite link again', 401);
    }
    if (row.expires_at < new Date() || row.device_id !== installId) throw new AppError('AUTH_REFRESH_INVALID', 'Open your invite link again', 401);
    const claimed = await this.prisma.refresh_tokens.updateMany({
      where: { id: row.id, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: 'rotated' },
    });
    if (claimed.count === 0) {
      await this.revokeFamily(row.family_id, 'admin');
      throw new AppError('AUTH_REFRESH_REUSED', 'Session ended, open your invite link again', 401);
    }
    return { familyId: row.family_id, weddingId: row.wedding_id, expiresAt: row.expires_at };
  }

  /** Starts a new family for a fresh sign-in. */
  async issueHostSession(userId: string, deviceId: string) {
    return this.issue({ userId, deviceId, familyId: randomUUID() });
  }

  private async issue(input: { userId: string; deviceId: string; familyId: string }) {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refresh_tokens.create({
      data: {
        audience: 'host',
        user_id: input.userId,
        device_id: input.deviceId,
        family_id: input.familyId,
        token_hash: sha256(refreshToken),
        expires_at: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    return {
      accessToken: this.signHostAccess({ sub: input.userId, sid: input.familyId }),
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async rotate(refreshToken: string, deviceId: string) {
    const row = await this.prisma.refresh_tokens.findUnique({ where: { token_hash: sha256(refreshToken) } });
    if (!row || row.audience !== 'host' || !row.user_id) {
      throw new AppError('AUTH_REFRESH_INVALID', 'Sign in again', 401);
    }
    if (row.revoked_at) {
      if (row.revoked_reason === 'rotated') {
        // A rotated token came back: someone else holds the newer one. End every session.
        await this.revokeAllForUser(row.user_id, 'reuse_detected');
        throw new AppError('AUTH_REFRESH_REUSED', 'Session ended, sign in again', 401);
      }
      throw new AppError('AUTH_REFRESH_INVALID', 'Sign in again', 401);
    }
    if (row.expires_at < new Date() || row.device_id !== deviceId) {
      throw new AppError('AUTH_REFRESH_INVALID', 'Sign in again', 401);
    }
    const claimed = await this.prisma.refresh_tokens.updateMany({
      where: { id: row.id, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: 'rotated' },
    });
    if (claimed.count === 0) {
      await this.revokeAllForUser(row.user_id, 'reuse_detected');
      throw new AppError('AUTH_REFRESH_REUSED', 'Session ended, sign in again', 401);
    }
    const tokens = await this.issue({ userId: row.user_id, deviceId, familyId: row.family_id });
    return { userId: row.user_id, ...tokens };
  }

  async revokeFamily(familyId: string, reason: 'logout' | 'admin') {
    await this.prisma.refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: 'logout' | 'reuse_detected' | 'account_deleted' | 'access_removed') {
    await this.prisma.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }
}
