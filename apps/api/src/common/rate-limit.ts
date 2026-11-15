import rateLimit, { type Options } from 'express-rate-limit';
import { mapError, AppError } from './errors';

/**
 * Rate-limit helper. In-memory store is correct while the API runs as one process (MVP);
 * swap the store before running more than one API process (OPS-05).
 */
export function limit(perMinute: number, code = 'RATE_LIMITED', overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      const mapped = mapError(new AppError(code, 'Too many requests, try again shortly', 429));
      res.status(mapped.status).json(mapped.body);
    },
    ...overrides,
  });
}
