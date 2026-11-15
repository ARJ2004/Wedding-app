import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response } from 'express';
import { AppError } from './errors';

const KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** Stable JSON: object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(body: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(body)).digest();
}

export interface IdempotencyOptions {
  /** Caller identity, e.g. `user:<uuid>`; two callers can never collide on a key. */
  scope: (req: Request) => string;
  /** Route template stored for support, e.g. `/v1/weddings/:weddingId/announcements`. */
  route: string;
  weddingId?: (req: Request) => string | undefined;
  /** When true a missing Idempotency-Key header is a 400; otherwise the request just runs. */
  required?: boolean;
}

/**
 * Idempotency-Key middleware (01-fnd §3). First request inserts `in_progress` and runs; its
 * 2xx/4xx response is stored and replayed to later duplicates. A concurrent duplicate gets 409,
 * the same key with a different body gets 422. A 5xx deletes the row so the client can retry.
 */
export function idempotent(prisma: PrismaClient, opts: IdempotencyOptions): RequestHandler {
  return async (req: Request, res: Response, next) => {
    const key = req.header('idempotency-key');
    if (!key) {
      if (opts.required) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', 400);
      return next();
    }
    if (!KEY.test(key)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8–128 URL-safe characters', 400);

    const scope = opts.scope(req);
    const hash = requestHash(req.body);
    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO idempotency_keys (scope, idem_key, wedding_id, method, route, request_hash)
      VALUES (${scope}, ${key}, ${opts.weddingId?.(req) ?? null}::uuid, ${req.method}, ${opts.route}, ${hash})
      ON CONFLICT (scope, idem_key) DO NOTHING
      RETURNING id`;

    if (inserted.length === 0) {
      const rows = await prisma.$queryRaw<
        { request_hash: Buffer; state: string; response_status: number | null; response_body: unknown }[]
      >`SELECT request_hash, state, response_status, response_body FROM idempotency_keys
        WHERE scope = ${scope} AND idem_key = ${key} AND expires_at > now()`;
      const row = rows[0];
      if (!row) {
        // Expired between insert attempt and read: treat as a conflict the client can retry.
        throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is being processed', 409);
      }
      if (!Buffer.from(row.request_hash).equals(hash)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request', 422);
      }
      if (row.state !== 'completed') {
        throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is being processed', 409);
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(row.response_status ?? 200);
      if (row.response_body === null) {
        res.end();
      } else {
        res.json(row.response_body);
      }
      return;
    }

    const id = inserted[0]!.id;
    let captured: unknown = null;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      captured = body;
      return json(body);
    };
    res.on('finish', () => {
      const status = res.statusCode;
      const write =
        status >= 500
          ? prisma.$executeRaw`DELETE FROM idempotency_keys WHERE id = ${id}::uuid`
          : prisma.$executeRaw`UPDATE idempotency_keys
              SET state = 'completed', response_status = ${status}, response_body = ${JSON.stringify(captured)}::jsonb
              WHERE id = ${id}::uuid`;
      write.catch(() => undefined);
    });
    next();
  };
}
