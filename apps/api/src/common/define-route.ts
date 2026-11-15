import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { Action } from '@mehfil/domain';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { Guards } from './auth/guards';
import type { ZodTypeAny, z } from 'zod';
import { ErrorResponseSchema } from './openapi';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteContext {
  router: Router;
  registry: OpenAPIRegistry;
  guards: Guards;
}
export type RouteAuth = 'public' | 'host' | 'guest';

interface RouteSpec<P extends ZodTypeAny, Q extends ZodTypeAny, B extends ZodTypeAny, R extends ZodTypeAny> {
  method: Method;
  /** Express-style path, e.g. /v1/weddings/:weddingId/events */
  path: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  /** Wedding-scoped host routes: the `can()` action checked after loading membership from :weddingId. */
  permission?: Action;
  /** Guest routes require the core consent unless set to false (sign-in, session, consent itself). */
  consent?: false;
  /** Extra middleware after auth/permission, e.g. idempotent(). */
  before?: RequestHandler[];
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
 * `auth: 'host'` attaches the host JWT guard; `permission` loads the caller's membership of
 * :weddingId (404 if none) and checks `can(role, permission)` (403 ROL_FORBIDDEN).
 */
export function defineRoute<
  P extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  B extends ZodTypeAny = ZodTypeAny,
  R extends ZodTypeAny = ZodTypeAny,
>(ctx: RouteContext, spec: RouteSpec<P, Q, B, R>): void {
  const { router, registry, guards } = ctx;
  const errorStatuses = new Set([400, 500, ...(spec.errors ?? [])]);
  if (spec.auth !== 'public') errorStatuses.add(401);
  if (spec.auth === 'guest' && spec.consent !== false) errorStatuses.add(403);
  if (spec.permission) {
    errorStatuses.add(403);
    errorStatuses.add(404);
  }

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

  const chain: RequestHandler[] = [];
  if (spec.auth === 'host') chain.push(guards.authHost);
  if (spec.auth === 'guest') {
    chain.push(guards.authGuest);
    if (spec.consent !== false) chain.push(guards.requireConsent('core'));
  }
  if (spec.permission) {
    if (spec.auth !== 'host') throw new Error(`permission needs host auth: ${spec.path}`);
    chain.push(guards.requirePermission(spec.permission));
  }
  chain.push(...(spec.before ?? []));

  router[spec.method](spec.path, ...chain, async (req: Request, res: Response) => {
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
