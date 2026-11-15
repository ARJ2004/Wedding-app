import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths, Middleware };
export type ErrorResponse = components['schemas']['ErrorResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];

/** Creates a typed client for the Mehfil API; every path, body and response is checked. */
export function createApiClient(options: ClientOptions & { baseUrl: string }) {
  return createClient<paths>(options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
