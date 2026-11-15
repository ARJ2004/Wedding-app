import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { Request, Response, Router } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ErrorResponseSchema } from './openapi';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type RouteAuth = 'public' | 'host' | 'guest';

interface RouteSpec<P extends ZodTypeAny, Q extends ZodTypeAny, B extends ZodTypeAny, R extends ZodTypeAny> {
  method: Method;
  /** Express-style path, e.g. /v1/weddings/:weddingId/events */
  path: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  request?: { params?: P; query?: Q; body?: B };
  /** Success status and schema; error responses are added automatically. */
  response: { status: 200 | 201 | 202; schema: R } | { status: 204 };
  errors?: number[];
  handler: (
    input: { params: z.infer<P>; query: z.infer<Q>; body: z.infer<B>; req: Request; res: Response },
  ) => Promise<z.infer<R> | void> | z.infer<R> | void;
}

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Registers a route with the OpenAPI registry and mounts it on the router in one place,
 * so the spec (and the generated client) cannot drift from the code. Inputs are parsed with
 * Zod before the handler runs; a ZodError becomes 400 VALIDATION_FAILED in the error handler.
 * Auth middleware is attached per route by `authFor` (host/guest arrive with FND-05 / ACC).
 */
export function defineRoute<
  P extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  B extends ZodTypeAny = ZodTypeAny,
  R extends ZodTypeAny = ZodTypeAny,
>(router: Router, registry: OpenAPIRegistry, spec: RouteSpec<P, Q, B, R>): void {
  const errorStatuses = new Set([400, 500, ...(spec.errors ?? [])]);
  if (spec.auth !== 'public') errorStatuses.add(401);

  const responses: RouteConfig['responses'] = {};
  if (spec.response.status === 204) {
    responses[204] = { description: 'No content' };
  } else {
    responses[spec.response.status] = {
      description: 'Success',
      content: { 'application/json': { schema: spec.response.schema } },
    };
  }
  for (const status of [...errorStatuses].sort()) {
    responses[status] = { description: 'Error', content: { 'application/json': { schema: ErrorResponseSchema } } };
  }

  registry.registerPath({
    method: spec.method,
    path: toOpenApiPath(spec.path),
    summary: spec.summary,
    tags: spec.tags,
    security: spec.auth === 'public' ? [] : [{ [`${spec.auth}Auth`]: [] }],
    request: {
      params: spec.request?.params as never,
      query: spec.request?.query as never,
      body: spec.request?.body
        ? { content: { 'application/json': { schema: spec.request.body } }, required: true }
        : undefined,
    },
    responses,
  });

  router[spec.method](spec.path, async (req: Request, res: Response) => {
    const params = (spec.request?.params ? spec.request.params.parse(req.params) : req.params) as z.infer<P>;
    const query = (spec.request?.query ? spec.request.query.parse(req.query) : req.query) as z.infer<Q>;
    const body = (spec.request?.body ? spec.request.body.parse(req.body) : undefined) as z.infer<B>;
    const result = await spec.handler({ params, query, body, req, res });
    if (res.headersSent) return;
    if (spec.response.status === 204) {
      res.status(204).end();
      return;
    }
    res.status(spec.response.status).json(spec.response.schema.parse(result));
  });
}
