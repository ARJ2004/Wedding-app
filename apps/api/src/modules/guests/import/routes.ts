import { ImportMapping } from '@mehfil/domain';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../../common/define-route';
import { idempotent } from '../../../common/idempotency';
import { z } from '../../../common/openapi';
import type { ImportService } from './service';

const Uuid = z.string().uuid();
const Params = z.object({ weddingId: Uuid, importId: Uuid });

const ImportView = z
  .object({
    id: Uuid,
    status: z.enum(['uploaded', 'parsing', 'mapping', 'validating', 'preview', 'committing', 'done', 'failed', 'cancelled']),
    source: z.string(),
    headers: z.array(z.string()),
    sheets: z.array(z.string()),
    sheetName: z.string().nullable(),
    sample: z.array(z.record(z.string(), z.string())),
    suggestedMapping: z.record(z.string(), z.unknown()).nullable(),
    mapping: z.record(z.string(), z.unknown()).nullable(),
    stats: z.object({
      total: z.number(), ok: z.number(), warnings: z.number(), errors: z.number(), duplicates: z.number(),
      imported: z.number(), merged: z.number(), skipped: z.number(),
    }),
    errorCode: z.string().nullable(),
  })
  .openapi('GuestImport');

const ImportRow = z
  .object({
    rowNumber: z.number().int(),
    status: z.string(),
    action: z.string(),
    partyKey: z.string().nullable(),
    fullName: z.string(),
    phone: z.string().nullable(),
    members: z.number().int(),
    issues: z.array(z.string()),
    matchKind: z.string().nullable(),
  })
  .openapi('GuestImportRow');

export function importRoutes(ctx: RouteContext, svc: ImportService, prisma: Parameters<typeof idempotent>[0]) {
  const W = '/v1/weddings/:weddingId/imports';
  const actor = (req: Request) => ({ userId: req.principal!.userId, role: req.membership!.role, requestId: String(req.id) });

  defineRoute(ctx, {
    method: 'post',
    path: W,
    summary: 'Start an import from an uploaded .xlsx/.csv (upload purpose "import" first)',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    errors: [404, 409],
    request: { params: z.object({ weddingId: Uuid }), body: z.object({ mediaId: Uuid }) },
    response: { status: 201, schema: ImportView },
    handler: ({ req, params, body }) => svc.start(actor(req), params.weddingId, body.mediaId),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:importId`,
    summary: 'Import status, headers, sample rows, suggested mapping and stats (poll while working)',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    errors: [404],
    request: { params: Params },
    response: { status: 200, schema: ImportView },
    handler: ({ params }) => svc.view(params.weddingId, params.importId),
  });

  defineRoute(ctx, {
    method: 'put',
    path: `${W}/:importId/mapping`,
    summary: 'Submit the column mapping; validation runs in the background',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    errors: [404, 409],
    request: { params: Params, body: ImportMapping },
    response: { status: 200, schema: ImportView },
    handler: ({ params, body }) => svc.setMapping(params.weddingId, params.importId, body),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:importId/rows`,
    summary: 'Preview rows with their status, issues and duplicate matches',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    request: {
      params: Params,
      query: z.object({
        status: z.enum(['ok', 'warning', 'error', 'duplicate']).optional(),
        cursor: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    },
    response: { status: 200, schema: z.object({ items: z.array(ImportRow), nextCursor: z.number().int().nullable() }) },
    handler: ({ params, query }) => svc.rows(params.weddingId, params.importId, query.status, query.cursor, query.limit),
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/:importId/rows`,
    summary: 'Set create/merge/skip for chosen rows or every row of a status',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    errors: [409],
    request: {
      params: Params,
      body: z.object({
        rowNumbers: z.array(z.number().int()).max(5000).optional(),
        status: z.enum(['duplicate', 'warning']).optional(),
        action: z.enum(['create', 'merge', 'skip']),
      }),
    },
    response: { status: 200, schema: z.object({ updated: z.number().int() }) },
    handler: ({ params, body }) => svc.setActions(params.weddingId, params.importId, body),
  });

  // Commit is idempotent on Idempotency-Key so a retried tap never imports twice.
  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:importId/commit`,
    summary: 'Commit the previewed import (send an Idempotency-Key)',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    before: [
      idempotent(prisma, {
        scope: (req) => `user:${req.principal!.userId}`,
        route: `${W}/:importId/commit`,
        weddingId: (req) => String(req.params.weddingId),
      }),
    ],
    errors: [409, 422],
    request: { params: Params },
    response: { status: 202, schema: ImportView },
    handler: ({ params }) => svc.requestCommit(params.weddingId, params.importId),
  });

  defineRoute(ctx, {
    method: 'post',
    path: `${W}/:importId/cancel`,
    summary: 'Cancel before commit',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    errors: [409],
    request: { params: Params },
    response: { status: 200, schema: ImportView },
    handler: ({ params }) => svc.cancel(params.weddingId, params.importId),
  });

  defineRoute(ctx, {
    method: 'get',
    path: `${W}/:importId/errors.csv`,
    summary: 'Rows with problems as CSV (Row, Problem, original columns)',
    tags: ['imports'],
    auth: 'host',
    permission: 'guest.import',
    request: { params: Params },
    response: { status: 200, schema: z.string() },
    handler: async ({ params, res }) => {
      const csv = await svc.errorsCsv(params.weddingId, params.importId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="import-problems.csv"');
      res.send(csv);
    },
  });
}
