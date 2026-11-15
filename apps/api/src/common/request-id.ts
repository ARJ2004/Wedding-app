import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
// `req.id` is typed by pino-http's augmentation of http.IncomingMessage.
import 'pino-http';

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a sane X-Request-Id from Nginx or the app, otherwise mints one, and echoes it back. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

