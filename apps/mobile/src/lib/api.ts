import { createApiClient, type Middleware } from '@mehfil/api-client';
import { QueryClient } from '@tanstack/react-query';
import { config } from './config';
import { useSession } from './session';

/** Error with the API's stable code, so screens can show the right message. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const auth: Middleware = {
  async onRequest({ request }) {
    const token = useSession.getState().accessToken;
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
  async onResponse({ request, response }) {
    if (response.status !== 401 || request.headers.get('x-retried')) return response;
    const token = await useSession.getState().refresh();
    if (!token) return response;
    // openapi-fetch hands us a WHATWG Request; React Native's fetch accepts it at runtime but the
    // two lib typings differ, hence the narrow casts.
    const headers = new Headers(request.headers as unknown as Record<string, string>);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('x-retried', '1');
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().text();
    return (await fetch(request.url, { method: request.method, headers, body })) as unknown as Response;
  },
};

export const api = createApiClient({ baseUrl: config.apiUrl || (typeof window !== 'undefined' ? window.location.origin : '') });
api.use(auth);

/** Unwraps an openapi-fetch result or throws ApiError with the server's code. */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.error !== undefined || res.data === undefined) {
    const err = (res.error as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(err?.code ?? 'NETWORK', err?.message ?? 'Could not reach the server', res.response.status);
  }
  return res.data;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});
