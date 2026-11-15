import { can } from '@mehfil/domain';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { WeddingParams } from '../weddings/schemas';
import { UPLOAD_PURPOSES } from './policies';
import { MediaService } from './service';

const UploadTicket = z
  .object({
    mediaId: z.string().uuid(),
    uploadUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  })
  .openapi('UploadTicket');

export function mediaRoutes(ctx: RouteContext, media: MediaService) {
  // Permission depends on the purpose, so it is checked per policy after membership is loaded
  // with the weakest wedding-scoped action every uploader has.
  defineRoute(ctx, {
    method: 'post',
    path: '/v1/weddings/:weddingId/uploads',
    summary: 'Start an upload: returns a presigned PUT (5 min) for the file',
    tags: ['media'],
    auth: 'host',
    permission: 'wedding.read',
    errors: [413, 415],
    request: {
      params: WeddingParams,
      body: z.object({
        purpose: z.enum(UPLOAD_PURPOSES),
        contentType: z.string().max(120),
        byteSize: z.number().int().min(1),
      }),
    },
    response: { status: 201, schema: UploadTicket },
    handler: async ({ req, params, body }) => {
      const policy = MediaService.policyFor(body.purpose);
      if (!can(req.membership!.role, policy.permission)) {
        throw new AppError('ROL_FORBIDDEN', 'Your role cannot upload this', 403);
      }
      return media.createUpload({ weddingId: params.weddingId, userId: req.principal!.userId, ...body });
    },
  });

  defineRoute(ctx, {
    method: 'post',
    path: '/v1/uploads/:mediaId/complete',
    summary: 'Confirm the PUT finished; verifies the object and queues processing',
    tags: ['media'],
    auth: 'host',
    errors: [404, 409, 422],
    request: { params: z.object({ mediaId: z.string().uuid() }) },
    response: { status: 200, schema: z.object({ mediaId: z.string().uuid(), status: z.string() }) },
    handler: ({ req, params }) => media.complete(params.mediaId, req.principal!.userId),
  });
}
