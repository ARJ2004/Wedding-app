import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_FAILED' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorResponse');

export function createRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register('ErrorResponse', ErrorResponseSchema);
  registry.registerComponent('securitySchemes', 'hostAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registry.registerComponent('securitySchemes', 'guestAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  return registry;
}

export function buildOpenApiDocument(registry: OpenAPIRegistry, version: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Mehfil API', version },
    servers: [{ url: '/' }],
  });
}
