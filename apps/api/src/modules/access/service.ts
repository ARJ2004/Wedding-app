import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env';
import { deriveLinkToken, LINK_TOKEN_SHAPE, linkTokenHash } from '../../common/auth/link-token';
import type { TokenService } from '../../common/auth/tokens';
import { AppError } from '../../common/errors';
import { writeAudit } from '../audit';

const TRUST_DAYS = 90;
const OTP_TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = 30_000;
const MAX_SENDS_PER_HOUR = 5;
const LOCK_AFTER_FAILS = 10;
const LOCK_MS = 60 * 60_000;

type Platform = 'android' | 'ios' | 'web';

const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const maskPhone = (e164: string | null) => (e164 ? `•• ${e164.slice(-2)}` : null);

/**
 * Guest access (ACC-01, ACC-02a, ACC-04 with PRV-01): invite link → member picker → OTP to that
 * member's phone → device-bound session. The link alone reveals nothing personal (first names,
 * masked phones). In development the OTP is DEV_OTP_CODE and nothing is sent; real WhatsApp/SMS
 * delivery plugs in through MSG (S5) — until then non-dev environments answer 503.
 */
export class AccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  linkUrl(partyId: string, version: number) {
    return `${this.config.GUEST_LINK_BASE}${deriveLinkToken(this.config.LINK_TOKEN_KEY, partyId, version)}`;
  }

  private hmac(key: string, value: string) {
    return createHmac('sha256', key).update(value).digest();
  }

  private async partyByToken(token: string) {
    if (!LINK_TOKEN_SHAPE.test(token)) return null;
    return this.prisma.parties.findFirst({
      where: { link_token_hash: linkTokenHash(token), deleted_at: null, link_revoked_at: null, weddings: { deleted_at: null, status: { not: 'archived' } } },
      include: { weddings: true, guests: { where: { deleted_at: null }, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }] } },
    });
  }

  private async assertNotLocked(partyId: string) {
    const s = await this.prisma.party_auth_state.findUnique({ where: { party_id: partyId } });
    if (s?.locked_until && s.locked_until > new Date()) {
      throw new AppError('ACC_PARTY_LOCKED', 'Too many wrong codes. Ask the family to unlock your invite, or try again later.', 423, {
        retryAfter: s.locked_until.toISOString(),
      });
    }
  }

  async start(input: { token: string; installId: string; platform: Platform }) {
    const party = await this.partyByToken(input.token);
    // Same answer for unknown, revoked, deleted or archived: links are guessed and forwarded.
    if (!party) throw new AppError('ACC_LINK_INVALID', 'This invite link is not valid any more. Ask the family for a new one.', 404);
    await this.assertNotLocked(party.id);
    const live = await this.prisma.guest_devices.count({ where: { party_id: party.id, install_id: input.installId, revoked_at: null, trusted_until: { gt: new Date() } } });
    const linkTicket = jwt.sign({ iid: input.installId, plt: input.platform }, this.config.JWT_GUEST_SECRET, {
      algorithm: 'HS256',
      audience: 'link',
      subject: party.id,
      expiresIn: 15 * 60,
    });
    return {
      linkTicket,
      sessionExists: live > 0,
      wedding: { title: party.weddings.title, startsOn: party.weddings.starts_on.toISOString().slice(0, 10), endsOn: party.weddings.ends_on.toISOString().slice(0, 10) },
      party: { label: party.label },
      members: party.guests.map((g) => ({
        guestId: g.id,
        firstName: firstName(g.full_name),
        canReceiveCode: g.phone_status === 'valid',
        maskedPhone: g.phone_status === 'valid' ? maskPhone(g.phone_e164) : null,
      })),
    };
  }

  private readTicket(ticket: string) {
    try {
      const d = jwt.verify(ticket, this.config.JWT_GUEST_SECRET, { algorithms: ['HS256'], audience: 'link' });
      if (typeof d === 'string' || !d.sub) throw new Error('bad');
      return { partyId: d.sub, installId: String(d.iid), platform: String(d.plt) as Platform };
    } catch {
      throw new AppError('ACC_TICKET_EXPIRED', 'Open your invite link again', 401);
    }
  }

  async sendOtp(input: { linkTicket: string; guestId: string; channel: 'whatsapp' | 'sms' }) {
    const t = this.readTicket(input.linkTicket);
    await this.assertNotLocked(t.partyId);
    const guest = await this.prisma.guests.findFirst({ where: { id: input.guestId, party_id: t.partyId, deleted_at: null } });
    if (!guest) throw new AppError('ACC_NOT_PARTY_MEMBER', 'Pick someone from this invite', 404);
    if (guest.phone_status !== 'valid' || !guest.phone_e164) {
      throw new AppError('ACC_NO_PHONE', 'We have no phone number for this person. Pick someone else or ask the family.', 422);
    }
    const recent = await this.prisma.otp_challenges.findMany({
      where: { party_id: t.partyId, created_at: { gt: new Date(Date.now() - 60 * 60_000) } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true, install_id: true },
    });
    // Cooldown per phone (two family members may sign in at once); hourly cap per party.
    const mine = recent.find((r) => r.install_id === t.installId);
    if (mine && Date.now() - mine.created_at.getTime() < RESEND_AFTER_MS) {
      throw new AppError('ACC_RESEND_TOO_SOON', 'Please wait a few seconds before asking for another code', 409, {
        retryAfter: new Date(mine.created_at.getTime() + RESEND_AFTER_MS).toISOString(),
      });
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) throw new AppError('ACC_OTP_SEND_LIMIT', 'Too many codes asked for. Try again in an hour.', 429);

    const dev = this.config.DEV_AUTH_ENABLED && this.config.NODE_ENV !== 'production';
    if (!dev) {
      // Needs credentials: WhatsApp authentication template (Meta) + DLT SMS. Wired in MSG-01/07 (S5).
      throw new AppError('ACC_OTP_CHANNEL_UNAVAILABLE', 'Codes cannot be sent yet. Please try again later.', 503);
    }
    const code = this.config.DEV_OTP_CODE;
    const challenge = await this.prisma.$transaction(async (tx) => {
      // A new code on this phone supersedes this phone's pending code only.
      await tx.otp_challenges.updateMany({ where: { party_id: t.partyId, install_id: t.installId, status: 'pending' }, data: { status: 'superseded', resolved_at: new Date() } });
      const id = randomUUID();
      return tx.otp_challenges.create({
        data: {
          id,
          wedding_id: guest.wedding_id,
          party_id: t.partyId,
          guest_id: guest.id,
          install_id: t.installId,
          platform: t.platform,
          phone_hmac: this.hmac(this.config.PII_HASH_KEY, guest.phone_e164!),
          channel: 'dev',
          code_hmac: this.hmac(this.config.OTP_PEPPER, `${id}:${code}`),
          expires_at: new Date(Date.now() + OTP_TTL_MS),
        },
      });
    });
    this.logger.info({ challengeId: challenge.id, devOtp: code }, 'dev OTP (not sent; DEV_AUTH_ENABLED)');
    return { challengeId: challenge.id, channel: 'dev' as const, maskedPhone: maskPhone(guest.phone_e164)!, expiresAt: challenge.expires_at.toISOString() };
  }

  /** Counts a wrong code toward the party lock; returns true when this failure locked the party. */
  private async recordFailure(partyId: string, weddingId: string): Promise<boolean> {
    const now = new Date();
    const s = await this.prisma.party_auth_state.findUnique({ where: { party_id: partyId } });
    const inWindow = s?.window_started_at && now.getTime() - s.window_started_at.getTime() < 60 * 60_000;
    const failed = (inWindow ? s!.failed_verifies : 0) + 1;
    const lock = failed >= LOCK_AFTER_FAILS;
    await this.prisma.party_auth_state.upsert({
      where: { party_id: partyId },
      create: { party_id: partyId, wedding_id: weddingId, failed_verifies: failed, window_started_at: now, locked_until: lock ? new Date(now.getTime() + LOCK_MS) : null, lock_count: lock ? 1 : 0 },
      update: {
        failed_verifies: lock ? 0 : failed,
        window_started_at: inWindow ? undefined : now,
        locked_until: lock ? new Date(now.getTime() + LOCK_MS) : undefined,
        lock_count: lock ? { increment: 1 } : undefined,
        updated_at: now,
      },
    });
    return lock;
  }

  async verify(input: { challengeId: string; code: string; installId: string; appVersion?: string; clientSummary?: string }) {
    const ch = await this.prisma.otp_challenges.findUnique({ where: { id: input.challengeId } });
    if (!ch || ch.status === 'superseded') throw new AppError('ACC_OTP_EXPIRED', 'This code has expired. Ask for a new one.', 410);
    await this.assertNotLocked(ch.party_id);
    if (ch.install_id !== input.installId) throw new AppError('ACC_INSTALL_MISMATCH', 'Enter the code on the phone that asked for it', 409);
    if (ch.status !== 'pending' || ch.expires_at < new Date()) throw new AppError('ACC_OTP_EXPIRED', 'This code has expired. Ask for a new one.', 410);
    const expected = this.hmac(this.config.OTP_PEPPER, `${ch.id}:${input.code}`);
    if (!timingSafeEqual(expected, Buffer.from(ch.code_hmac))) {
      const attempts = ch.attempts + 1;
      const exhausted = attempts >= ch.max_attempts;
      await this.prisma.otp_challenges.update({
        where: { id: ch.id },
        data: { attempts, status: exhausted ? 'failed' : 'pending', resolved_at: exhausted ? new Date() : null },
      });
      if (await this.recordFailure(ch.party_id, ch.wedding_id)) await this.assertNotLocked(ch.party_id);
      if (exhausted) throw new AppError('ACC_OTP_EXHAUSTED', 'Too many wrong tries. Ask for a new code.', 429);
      throw new AppError('ACC_OTP_INVALID', "That code didn't match", 400, { attemptsLeft: ch.max_attempts - attempts });
    }

    const wedding = await this.prisma.weddings.findUniqueOrThrow({ where: { id: ch.wedding_id } });
    const now = new Date();
    const trustedUntil = new Date(Math.min(now.getTime() + TRUST_DAYS * 86_400_000, wedding.ends_on.getTime() + 31 * 86_400_000));
    const device = await this.prisma.$transaction(async (tx) => {
      await tx.otp_challenges.update({ where: { id: ch.id }, data: { status: 'verified', resolved_at: now } });
      const old = await tx.guest_devices.findMany({ where: { party_id: ch.party_id, install_id: input.installId, revoked_at: null } });
      for (const d of old) {
        await tx.guest_devices.update({ where: { id: d.id }, data: { revoked_at: now, revoke_reason: 'replaced' } });
        await tx.refresh_tokens.updateMany({ where: { family_id: d.id, revoked_at: null }, data: { revoked_at: now, revoked_reason: 'logout' } });
      }
      const d = await tx.guest_devices.create({
        data: {
          wedding_id: ch.wedding_id,
          party_id: ch.party_id,
          install_id: input.installId,
          platform: ch.platform,
          app_version: input.appVersion,
          client_summary: input.clientSummary?.slice(0, 80),
          verified_guest_id: ch.guest_id,
          active_guest_id: ch.guest_id,
          trusted_until: trustedUntil,
        },
      });
      await tx.party_auth_state.updateMany({ where: { party_id: ch.party_id }, data: { failed_verifies: 0 } });
      await writeAudit(tx, { weddingId: ch.wedding_id, actor: { type: 'guest', id: ch.guest_id }, action: 'guest.device_verified', entityType: 'guest_device', entityId: d.id, after: { platform: d.platform } });
      return d;
    });
    return this.issue(device);
  }

  private async issue(device: { id: string; active_guest_id: string; party_id: string; wedding_id: string; install_id: string; trusted_until: Date }) {
    const refreshToken = await this.tokens.issueGuestRefresh({
      guestId: device.active_guest_id,
      weddingId: device.wedding_id,
      installId: device.install_id,
      deviceId: device.id,
      expiresAt: device.trusted_until,
    });
    return {
      accessToken: this.tokens.signGuestAccess({ sub: device.active_guest_id, pid: device.party_id, wid: device.wedding_id, sid: device.id }),
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      session: await this.session(device.active_guest_id, device.id),
    };
  }

  async refresh(refreshToken: string, installId: string) {
    const r = await this.tokens.rotateGuest(refreshToken, installId);
    const device = await this.prisma.guest_devices.findUnique({ where: { id: r.familyId } });
    if (!device || device.revoked_at || device.trusted_until < new Date()) {
      throw new AppError('ACC_DEVICE_EXPIRED', 'Open your invite link again', 401);
    }
    await this.prisma.guest_devices.update({ where: { id: device.id }, data: { last_seen_at: new Date() } });
    return this.issue(device);
  }

  async logout(deviceId: string) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.guest_devices.updateMany({ where: { id: deviceId, revoked_at: null }, data: { revoked_at: now, revoke_reason: 'guest_logout' } }),
      this.prisma.refresh_tokens.updateMany({ where: { family_id: deviceId, revoked_at: null }, data: { revoked_at: now, revoked_reason: 'logout' } }),
    ]);
  }

  async currentNotice(locale = 'en') {
    const n = await this.prisma.privacy_notices.findFirst({
      where: { audience: 'guest', published_at: { not: null }, effective_from: { lte: new Date() } },
      orderBy: { effective_from: 'desc' },
    });
    if (!n) throw new AppError('PRV_NOTICE_MISSING', 'Privacy notice not published', 500);
    const text =
      (await this.prisma.privacy_notice_texts.findUnique({ where: { version_locale: { version: n.version, locale } } })) ??
      (await this.prisma.privacy_notice_texts.findUniqueOrThrow({ where: { version_locale: { version: n.version, locale: 'en' } } }));
    return { version: n.version, title: text.title, bodyMd: text.body_md, locale: text.locale };
  }

  async session(guestId: string, deviceId: string) {
    const guest = await this.prisma.guests.findUniqueOrThrow({
      where: { id: guestId },
      include: { parties: { include: { guests: { where: { deleted_at: null }, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }] } } }, weddings: true },
    });
    const core = await this.prisma.consents.count({ where: { guest_id: guestId, purpose: 'core', withdrawn_at: null } });
    const device = await this.prisma.guest_devices.findUniqueOrThrow({ where: { id: deviceId } });
    return {
      guest: { id: guest.id, fullName: guest.full_name },
      party: {
        id: guest.party_id,
        label: guest.parties.label,
        members: guest.parties.guests.map((g) => ({ id: g.id, fullName: g.full_name, isPrimary: g.is_primary, ageBand: g.age_band as 'child' | 'adult' | 'senior' | null })),
      },
      wedding: {
        id: guest.wedding_id,
        title: guest.weddings.title,
        startsOn: guest.weddings.starts_on.toISOString().slice(0, 10),
        endsOn: guest.weddings.ends_on.toISOString().slice(0, 10),
        timezone: guest.weddings.timezone,
      },
      trustedUntil: device.trusted_until.toISOString(),
      consentNeeded: core ? [] : (['core'] as 'core'[]),
    };
  }

  async consent(g: { guestId: string; weddingId: string; deviceId: string }, purpose: 'core' | 'photos', noticeVersion: string, locale: string) {
    const current = await this.currentNotice(locale);
    if (noticeVersion !== current.version) throw new AppError('PRV_NOTICE_OUTDATED', 'Please read the latest notice', 409, { version: current.version });
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.consents.findFirst({ where: { guest_id: g.guestId, purpose, withdrawn_at: null } });
      if (existing && existing.notice_version === noticeVersion) return;
      if (existing) await tx.consents.update({ where: { id: existing.id }, data: { withdrawn_at: new Date(), withdrawn_source: 'superseded' } });
      await tx.consents.create({ data: { wedding_id: g.weddingId, guest_id: g.guestId, purpose, notice_version: noticeVersion, source: 'guest_app', locale } });
      await writeAudit(tx, { weddingId: g.weddingId, actor: { type: 'guest', id: g.guestId }, action: 'consent.grant', entityType: 'consent', after: { purpose, noticeVersion } });
    });
    return this.session(g.guestId, g.deviceId);
  }

  async withdraw(g: { guestId: string; weddingId: string; deviceId: string }, purpose: 'core' | 'photos') {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.consents.updateMany({ where: { guest_id: g.guestId, purpose, withdrawn_at: null }, data: { withdrawn_at: now, withdrawn_source: 'guest_app' } });
      if (purpose === 'core') {
        await tx.guest_devices.updateMany({ where: { id: g.deviceId, revoked_at: null }, data: { revoked_at: now, revoke_reason: 'consent_withdrawn' } });
        await tx.refresh_tokens.updateMany({ where: { family_id: g.deviceId, revoked_at: null }, data: { revoked_at: now, revoked_reason: 'logout' } });
      }
      await writeAudit(tx, { weddingId: g.weddingId, actor: { type: 'guest', id: g.guestId }, action: 'consent.withdraw', entityType: 'consent', after: { purpose } });
    });
  }

  // ── host side ──────────────────────────────────────────────────────────────
  async hostLink(weddingId: string, partyId: string) {
    const p = await this.prisma.parties.findFirst({ where: { id: partyId, wedding_id: weddingId, deleted_at: null } });
    if (!p) throw new AppError('GST_PARTY_NOT_FOUND', 'Party not found', 404);
    if (p.link_revoked_at || !p.link_token_hash) return { url: null, version: p.link_version, revoked: true };
    return { url: this.linkUrl(p.id, p.link_version), version: p.link_version, revoked: false };
  }

  async rotate(actor: { userId: string; role: string }, weddingId: string, partyId: string) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.parties.findFirst({ where: { id: partyId, wedding_id: weddingId, deleted_at: null } });
      if (!p) throw new AppError('GST_PARTY_NOT_FOUND', 'Party not found', 404);
      const version = p.link_version + 1;
      await tx.parties.update({
        where: { id: partyId },
        data: { link_version: version, link_token_hash: linkTokenHash(deriveLinkToken(this.config.LINK_TOKEN_KEY, partyId, version)), link_revoked_at: null, link_rotated_at: now },
      });
      const devices = await tx.guest_devices.findMany({ where: { party_id: partyId, revoked_at: null }, select: { id: true } });
      await tx.guest_devices.updateMany({ where: { party_id: partyId, revoked_at: null }, data: { revoked_at: now, revoke_reason: 'link_rotated' } });
      await tx.refresh_tokens.updateMany({ where: { family_id: { in: devices.map((d) => d.id) }, revoked_at: null }, data: { revoked_at: now, revoked_reason: 'admin' } });
      await writeAudit(tx, { weddingId, actor: { type: 'user', id: actor.userId, role: actor.role }, action: 'party.link_rotated', entityType: 'party', entityId: partyId, after: { version, devicesSignedOut: devices.length } });
      return { url: this.linkUrl(partyId, version), version, revoked: false };
    });
  }
}
