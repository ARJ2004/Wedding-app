import type { PrismaClient } from '@prisma/client';
import { canSubscribe, isRealtimeChannel, type RealtimeChannel } from '@mehfil/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { bearer, loadMembership } from '../../common/auth/guards';
import type { TokenService } from '../../common/auth/tokens';
import { ErrorResponseSchema } from '../../common/openapi';
import { TooManyStreams, type RealtimeHub } from '../../common/sse';

const Params = z.object({ weddingId: z.string().uuid() });
const Query = z.object({
  channels: z
    .string()
    .min(1)
    .describe('Comma-separated channel names, e.g. headcount,debug.ping'),
});

/**
 * GET /v1/weddings/:weddingId/stream (FND-14). Host or guest bearer; 404 when the caller is not
 * on the wedding, 403 RT_CHANNEL_FORBIDDEN for a channel their role may not read,
 * 429 RT_TOO_MANY_STREAMS past 3 per principal. Resumes from the Last-Event-ID header.
 */
export function realtimeRoutes(ctx: RouteContext, deps: { prisma: PrismaClient; tokens: TokenService; hub: RealtimeHub }) {
  const path = '/v1/weddings/:weddingId/stream';
  const err = { description: 'Error', content: { 'application/json': { schema: ErrorResponseSchema } } };
  ctx.registry.registerPath({
    method: 'get',
    path: '/v1/weddings/{weddingId}/stream',
    summary: 'Realtime event stream (Server-Sent Events)',
    tags: ['realtime'],
    security: [{ hostAuth: [] }, { guestAuth: [] }],
    request: { params: Params, query: Query, headers: z.object({ 'last-event-id': z.string().optional() }) },
    responses: {
      200: { description: 'text/event-stream of {id, channel, kind, payload}', content: { 'text/event-stream': { schema: z.string() } } },
      400: err,
      401: err,
      403: err,
      404: err,
      429: err,
    },
  });

  ctx.router.get(path, async (req: Request, res: Response) => {
    const { weddingId } = Params.parse(req.params);
    const channels = [...new Set(Query.parse(req.query).channels.split(',').map((c) => c.trim()).filter(Boolean))];
    const unknown = channels.find((c) => !isRealtimeChannel(c));
    if (unknown || channels.length === 0 || channels.length > 10) {
      throw new AppError('VALIDATION_FAILED', `Unknown channel ${unknown ?? ''}`.trim(), 400);
    }

    const token = bearer(req);
    if (!token) throw new AppError('AUTH_UNAUTHENTICATED', 'Sign in to continue', 401);
    const { role, principal } = await identify(deps, token, weddingId);
    const forbidden = (channels as RealtimeChannel[]).find((c) => !canSubscribe(role, c));
    if (forbidden) throw new AppError('RT_CHANNEL_FORBIDDEN', `Not allowed to follow ${forbidden}`, 403);

    const rawLast = req.header('last-event-id');
    const lastEventId = rawLast && /^\d{1,19}$/.test(rawLast) ? BigInt(rawLast) : undefined;

    let close: () => void;
    try {
      close = await deps.hub.open({
        weddingId,
        channels,
        principal,
        lastEventId,
        sink: {
          write: (chunk) => {
            if (!res.headersSent) start(res);
            res.write(chunk);
          },
          end: () => res.end(),
        },
      });
    } catch (e) {
      if (e instanceof TooManyStreams) throw new AppError('RT_TOO_MANY_STREAMS', 'Too many live connections', 429);
      throw e;
    }
    req.on('close', close);
  });
}

function start(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Host token first, then guest; the role decides which channels are allowed. */
async function identify(deps: { prisma: PrismaClient; tokens: TokenService }, token: string, weddingId: string) {
  let host: { sub: string } | null = null;
  try {
    host = deps.tokens.verifyHostAccess(token);
  } catch {
    host = null;
  }
  if (host) {
    const m = await loadMembership(deps.prisma, host.sub, weddingId);
    if (!m) throw new AppError('WEDDING_NOT_FOUND', 'Wedding not found', 404);
    return { role: m.role, principal: `u:${host.sub}` };
  }
  const g = deps.tokens.verifyGuestAccess(token);
  const device = await deps.prisma.guest_devices.findUnique({ where: { id: g.sid }, select: { revoked_at: true, trusted_until: true } });
  if (!device || device.revoked_at || device.trusted_until < new Date()) {
    throw new AppError('ACC_DEVICE_EXPIRED', 'Open your invite link again', 401);
  }
  if (g.wid !== weddingId) throw new AppError('WEDDING_NOT_FOUND', 'Wedding not found', 404);
  return { role: 'guest' as const, principal: `g:${g.sub}` };
}
