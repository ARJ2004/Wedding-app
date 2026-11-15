import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths, Middleware };
export type ErrorResponse = components['schemas']['ErrorResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type AuthResponse = components['schemas']['AuthResponse'];
export type Me = components['schemas']['Me'];
export type WeddingMembership = components['schemas']['WeddingMembership'];
export type Wedding = components['schemas']['Wedding'];
export type CreateWedding = components['schemas']['CreateWedding'];
export type UpdateWedding = components['schemas']['UpdateWedding'];
export type Event = components['schemas']['Event'];
export type CreateEvent = components['schemas']['CreateEvent'];
export type EventPreset = components['schemas']['EventPreset'];
export type Venue = components['schemas']['Venue'];
export type CreateVenue = components['schemas']['CreateVenue'];
export type Party = components['schemas']['Party'];
export type Guest = components['schemas']['Guest'];
export type CreateParty = components['schemas']['CreateParty'];
export type GuestGroup = components['schemas']['GuestGroup'];

/** Creates a typed client for the Mehfil API; every path, body and response is checked. */
export function createApiClient(options: ClientOptions & { baseUrl: string }) {
  return createClient<paths>(options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
