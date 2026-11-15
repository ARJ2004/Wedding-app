import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorHandler, notFoundHandler } from './common/errors';
import { buildOpenApiDocument, createRegistry } from './common/openapi';
import { limit } from './common/rate-limit';
import { requestId } from './common/request-id';
import type { Deps } from './deps';
import { createGuards } from './common/auth/guards';
import { TokenService } from './common/auth/tokens';
import { createVerifiers, type IdTokenVerifier } from './common/auth/verifiers';
import type { RouteContext } from './common/define-route';
import { AccessService, accessRoutes } from './modules/access';
import { authRoutes } from './modules/auth';
import { guestHomeRoutes } from './modules/guest-home';
import { RsvpService, rsvpRoutes } from './modules/rsvp';
import { guestRoutes } from './modules/guests';
import { importRoutes, ImportService } from './modules/guests/import';
import { MediaService, mediaRoutes } from './modules/media';
import { healthRoutes } from './modules/health';
import { fakeS3Router } from './modules/dev/fake-s3';
import { opsRoutes } from './modules/ops';
import { orgRoutes } from './modules/team';
import { weddingRoutes } from './modules/weddings';
import { realtimeRoutes } from './modules/realtime';
import { createWhatsAppProvider, webhookRouter } from './modules/messaging';
import { PgListener, prismaRtStore, RealtimeHub } from './common/sse';

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * Builds the Express app. Used by main.ts, the OpenAPI emit script and every e2e test,
 * so the middleware order below is the one production runs (01-fnd §4).
 */
export function createApp(deps: Deps, opts: { verifiers?: IdTokenVerifier[] } = {}) {
  const version = packageVersion();
  const registry = createRegistry();
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestId);
  if (deps.metrics) app.use(deps.metrics.middleware());
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => req.id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  const devS3 = deps.config.NODE_ENV !== 'production' ? fakeS3Router(deps.objectStore) : null;
  if (devS3) app.use(devS3); // before express.json: takes raw bodies
  const whatsapp = deps.whatsapp ?? createWhatsAppProvider(deps.config, deps.prisma);
  // Provider webhooks: raw body for the signature, and outside the per-IP rate limit.
  app.use(
    webhookRouter({
      prisma: deps.prisma,
      logger: deps.logger,
      providers: [whatsapp],
      piiHashKey: deps.config.PII_HASH_KEY,
      verifyToken: deps.config.WHATSAPP_VERIFY_TOKEN,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(limit(deps.config.RATE_LIMIT_PER_MINUTE));
  app.use('/v1/auth', limit(deps.config.AUTH_RATE_LIMIT_PER_MINUTE, 'AUTH_RATE_LIMITED'));
  app.use('/v1/guest/auth', limit(deps.config.AUTH_RATE_LIMIT_PER_MINUTE, 'ACC_RATE_LIMITED'));

  const tokens = new TokenService(deps.prisma, deps.config);
  const ctx: RouteContext = { router: Router(), registry, guards: createGuards({ prisma: deps.prisma, tokens }) };
  const opsAdmins = deps.config.OPS_ADMIN_EMAILS;
  healthRoutes(ctx, deps, version);
  authRoutes(ctx, { prisma: deps.prisma, tokens, verifiers: opts.verifiers ?? createVerifiers(deps.config), opsAdmins });
  weddingRoutes(ctx, deps);
  guestRoutes(ctx, { prisma: deps.prisma, linkTokenKey: deps.config.LINK_TOKEN_KEY });
  orgRoutes(ctx, deps);
  accessRoutes(ctx, new AccessService(deps.prisma, tokens, deps.config, deps.logger));
  const realtime =
    deps.realtime ??
    new RealtimeHub(
      prismaRtStore(deps.prisma),
      new PgListener(deps.config.DATABASE_URL, deps.logger, () => deps.metrics?.sseListenReconnects.inc()),
      deps.logger,
      { onCount: (n) => deps.metrics?.sseConnections.set(n) },
    );
  realtimeRoutes(ctx, { prisma: deps.prisma, tokens, hub: realtime });
  const rsvp = new RsvpService(deps.prisma);
  rsvpRoutes(ctx, rsvp);
  guestHomeRoutes(ctx, { prisma: deps.prisma, objectStore: deps.objectStore, rsvp });
  const media = new MediaService(deps);
  mediaRoutes(ctx, media);
  importRoutes(ctx, new ImportService({ prisma: deps.prisma, jobs: deps.jobs, media, linkTokenKey: deps.config.LINK_TOKEN_KEY }), deps.prisma);
  opsRoutes(ctx, { prisma: deps.prisma, jobs: deps.jobs, opsAdmins });
  app.use(ctx.router);

  const openApiDocument = buildOpenApiDocument(registry, version);
  if (deps.config.OPENAPI_DOCS) {
    app.get('/v1/openapi.json', (_req, res) => {
      res.json(openApiDocument);
    });
    app.use('/v1/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));

  return { app, openApiDocument, realtime };
}
