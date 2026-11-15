import type { PrismaClient } from '@prisma/client';
import { deriveLinkToken } from './common/auth/link-token';
import type { AppConfig } from './config/env';
import type { FanoutService, ReplyRouter } from './modules/messaging';
import { RsvpReplyHandler } from './modules/rsvp';

/**
 * Cross-module wiring shared by the API and the worker (both must agree, since replies are
 * routed in the worker): modules plug into MSG's registries here, so MSG never imports them.
 */
export function wireReplies(deps: { prisma: PrismaClient; config: AppConfig; replies: ReplyRouter; fanout: FanoutService }) {
  const link = (partyId: string, version: number) => `${deps.config.GUEST_LINK_BASE}${deriveLinkToken(deps.config.LINK_TOKEN_KEY, partyId, version)}`;
  deps.replies.register('rsv', new RsvpReplyHandler(deps.prisma, link));
  deps.replies.sendReply = async (cmd, reply) => {
    await deps.fanout.sendToGuest({
      weddingId: cmd.weddingId,
      guestId: cmd.guestId,
      templateKey: reply.templateKey,
      params: reply.params,
      kind: reply.templateKey === 'rsvp_confirmation' ? 'rsvp_confirmation' : 'system',
      module: cmd.action.split('.')[0]!,
    });
  };
}
