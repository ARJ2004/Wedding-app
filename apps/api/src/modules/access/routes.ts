import { AppError } from '../../common/errors';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { z } from '../../common/openapi';
import { PartyParams } from '../guests/schemas';
import type { AccessService } from './service';

const InstallId = z.string().min(16).max(64);
const Platform = z.enum(['android', 'ios', 'web']);

const GuestSession = z
  .object({
    guest: z.object({ id: z.string().uuid(), fullName: z.string() }),
    party: z.object({
      id: z.string().uuid(),
      label: z.string(),
      members: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), isPrimary: z.boolean(), ageBand: z.enum(['child', 'adult', 'senior']).nullable() })),
    }),
    wedding: z.object({ id: z.string().uuid(), title: z.string(), startsOn: z.string(), endsOn: z.string(), timezone: z.string() }),
    trustedUntil: z.string(),
    consentNeeded: z.array(z.enum(['core'])),
  })
  .openapi('GuestSession');

const GuestAuth = z
  .object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number().int(), session: GuestSession })
  .openapi('GuestAuthResponse');

const Notice = z.object({ version: z.string(), title: z.string(), bodyMd: z.string(), locale: z.string() }).openapi('PrivacyNotice');
const PartyLink = z.object({ url: z.string().nullable(), version: z.number().int(), revoked: z.boolean() }).openapi('PartyLink');

export function accessRoutes(ctx: RouteContext, svc: AccessService) {
  const me = (req: Request) => req.guest!;

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/auth/start',
    summary: 'Open an invite link: returns a member picker (first names, masked phones) and a short-lived ticket',
    tags: ['guest-auth'],
    auth: 'public',
    errors: [404, 423, 429],
    request: { body: z.object({ token: z.string().max(64), installId: InstallId, platform: Platform }) },
    response: {
      status: 200,
      schema: z
        .object({
          linkTicket: z.string(),
          sessionExists: z.boolean(),
          wedding: z.object({ title: z.string(), startsOn: z.string(), endsOn: z.string() }),
          party: z.object({ label: z.string() }),
          members: z.array(z.object({ guestId: z.string().uuid(), firstName: z.string(), canReceiveCode: z.boolean(), maskedPhone: z.string().nullable() })),
        })
        .openapi('GuestLinkStart'),
    },
    handler: ({ body }) => svc.start(body),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/auth/otp',
    summary: "Send a 6-digit code to the chosen member's phone (dev: fixed code, nothing sent)",
    tags: ['guest-auth'],
    auth: 'public',
    errors: [401, 404, 409, 422, 423, 429, 503],
    request: { body: z.object({ linkTicket: z.string(), guestId: z.string().uuid(), channel: z.enum(['whatsapp', 'sms']).default('whatsapp') }) },
    response: {
      status: 200,
      schema: z.object({ challengeId: z.string().uuid(), channel: z.enum(['whatsapp', 'sms', 'dev']), maskedPhone: z.string(), expiresAt: z.string() }).openapi('OtpChallenge'),
    },
    handler: ({ body, req }) => svc.sendOtp({ ...body, ip: req.ip }),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/auth/verify',
    summary: 'Check the code; trusts this device and returns guest tokens',
    tags: ['guest-auth'],
    auth: 'public',
    errors: [409, 410, 423, 429],
    request: {
      body: z.object({
        challengeId: z.string().uuid(),
        code: z.string().regex(/^\d{6}$/),
        installId: InstallId,
        appVersion: z.string().max(20).optional(),
        clientSummary: z.string().max(80).optional(),
      }),
    },
    response: { status: 200, schema: GuestAuth },
    handler: ({ body }) => svc.verify(body),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/auth/refresh',
    summary: 'Rotate a guest refresh token (stops at the device trust limit)',
    tags: ['guest-auth'],
    auth: 'public',
    request: { body: z.object({ refreshToken: z.string().min(20).max(200), installId: InstallId }) },
    response: { status: 200, schema: GuestAuth },
    handler: ({ body }) => svc.refresh(body.refreshToken, body.installId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/guest/auth/logout',
    summary: 'Sign this device out of the invite',
    tags: ['guest-auth'],
    auth: 'guest',
    consent: false,
    response: { status: 204 },
    handler: ({ req }) => svc.logout(me(req).deviceId),
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/guest/session',
    summary: 'Who I am, my party, the wedding, and whether consent is still needed',
    tags: ['guest'],
    auth: 'guest',
    consent: false,
    response: { status: 200, schema: GuestSession },
    handler: ({ req }) => svc.session(me(req).guestId, me(req).deviceId),
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/guest/privacy-notice',
    summary: 'The current guest privacy notice (PRV-01)',
    tags: ['guest'],
    auth: 'public',
    request: { query: z.object({ locale: z.enum(['en', 'hi', 'kn']).default('en') }) },
    response: { status: 200, schema: Notice },
    handler: ({ query }) => svc.currentNotice(query.locale),
  });

  defineRoute(ctx, {
    method: 'put',
    path: '/v1/guest/consents/:purpose',
    summary: 'Accept the privacy notice for a purpose (core first)',
    tags: ['guest'],
    auth: 'guest',
    consent: false,
    errors: [409],
    request: {
      params: z.object({ purpose: z.enum(['core', 'photos']) }),
      body: z.object({ noticeVersion: z.string(), locale: z.enum(['en', 'hi', 'kn']).default('en') }),
    },
    response: { status: 200, schema: GuestSession },
    handler: ({ req, params, body }) => svc.consent(me(req), params.purpose, body.noticeVersion, body.locale),
  });

  defineRoute(ctx, {
    method: 'delete',
    path: '/v1/guest/consents/:purpose',
    summary: 'Withdraw consent (core also signs this device out)',
    tags: ['guest'],
    auth: 'guest',
    consent: false,
    request: { params: z.object({ purpose: z.enum(['core', 'photos']) }) },
    response: { status: 204 },
    handler: ({ req, params }) => svc.withdraw(me(req), params.purpose),
  });

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/parties/:partyId/link',
    summary: "The party's invite link, to copy or share",
    tags: ['guests'],
    auth: 'host',
    permission: 'link.rotate',
    request: { params: PartyParams },
    response: { status: 200, schema: PartyLink },
    handler: ({ params }) => svc.hostLink(params.weddingId, params.partyId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/weddings/:weddingId/parties/:partyId/link/rotate',
    summary: 'Issue a new invite link; the old one stops working and its devices are signed out',
    tags: ['guests'],
    auth: 'host',
    permission: 'link.rotate',
    request: { params: PartyParams },
    response: { status: 200, schema: PartyLink },
    handler: ({ req, params }) => svc.rotate({ userId: req.principal!.userId, role: req.membership!.role }, params.weddingId, params.partyId),
  });
  const DeviceParams = PartyParams.extend({ deviceId: z.string().uuid() });
  const ownerOnly = (role: string) => {
    if (role !== 'owner' && role !== 'co_host') throw new AppError('ROL_FORBIDDEN', 'Only the couple can do this', 403);
  };
  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/parties/:partyId/access',
    summary: "Who is signed in on this invite, lock state and the last code sent",
    tags: ['guests'],
    auth: 'host',
    permission: 'link.rotate',
    request: { params: PartyParams },
    response: {
      status: 200,
      schema: z
        .object({
          locked: z.boolean(),
          lockedUntil: z.string().nullable(),
          failedAttempts: z.number().int(),
          lastCode: z.object({ at: z.string(), channel: z.string(), status: z.string() }).nullable(),
          devices: z.array(z.object({ id: z.string(), platform: z.string(), summary: z.string().nullable(), member: z.string(), lastSeenAt: z.string(), trustedUntil: z.string() })),
        })
        .openapi('PartyAccess'),
    },
    handler: ({ params }) => svc.hostAccess(params.weddingId, params.partyId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/weddings/:weddingId/parties/:partyId/access/unlock',
    summary: 'Unlock an invite locked by wrong codes (owner and co-host)',
    tags: ['guests'],
    auth: 'host',
    permission: 'link.rotate',
    request: { params: PartyParams },
    response: { status: 204 },
    handler: async ({ params, req }) => {
      ownerOnly(req.membership!.role);
      await svc.unlock({ userId: req.principal!.userId, role: req.membership!.role }, params.weddingId, params.partyId);
    },
  });

  defineRoute(ctx, {
    method: 'delete',
    path: '/v1/weddings/:weddingId/parties/:partyId/access/devices/:deviceId',
    summary: 'Sign one phone out of this invite (owner and co-host)',
    tags: ['guests'],
    auth: 'host',
    permission: 'link.rotate',
    request: { params: DeviceParams },
    response: { status: 204 },
    handler: async ({ params, req }) => {
      ownerOnly(req.membership!.role);
      await svc.revokeDevice({ userId: req.principal!.userId, role: req.membership!.role }, params.weddingId, params.partyId, params.deviceId);
    },
  });
}
