import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from 'pino';

/** An error the API means to show the caller: stable code, safe message, HTTP status. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface Mapped {
  status: number;
  body: ErrorBody;
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Maps anything thrown in a handler to the single API error shape. Unknown errors never leak detail. */
export function mapError(err: unknown): Mapped {
  if (err instanceof AppError) {
    return { status: err.status, body: body(err.code, err.message, err.details) };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: body(
        'VALIDATION_FAILED',
        'Some fields are invalid',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    };
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    return { status: 400, body: body('INVALID_JSON', 'Request body is not valid JSON') };
  }
  if (type === 'entity.too.large') {
    return { status: 413, body: body('PAYLOAD_TOO_LARGE', 'Request body is too large') };
  }
  return { status: 500, body: body('INTERNAL', 'Something went wrong') };
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      logger.error({ err, requestId: req.id }, 'unhandled error');
    }
    res.status(mapped.status).json(mapped.body);
  };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(body('NOT_FOUND', 'Route not found'));
};
