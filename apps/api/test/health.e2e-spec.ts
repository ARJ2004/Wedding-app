import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { boot, closePrisma } from './helpers';

afterAll(closePrisma);

describe('health', () => {
  it('GET /v1/health is public and returns the version', async () => {
    const res = await request(boot()).get('/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', version: expect.any(String) });
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('GET /v1/health/ready checks the real database', async () => {
    await request(boot()).get('/v1/health/ready').expect(200);
  });

  it('GET /v1/health/ready returns 503 NOT_READY when the database fails', async () => {
    const prisma = { $queryRaw: () => Promise.reject(new Error('connection refused')) } as unknown as PrismaClient;
    const app = boot({ prisma });
    const res = await request(app).get('/v1/health/ready').expect(503);
    expect(res.body).toEqual({ error: { code: 'NOT_READY', message: 'Database is not reachable' } });
  });
});

describe('platform behaviour', () => {
  it('unknown routes return the error shape with 404', async () => {
    const res = await request(boot()).get('/v1/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('malformed JSON returns 400 INVALID_JSON', async () => {
    const res = await request(boot())
      .post('/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"oops":')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('echoes a well-formed X-Request-Id', async () => {
    const res = await request(boot()).get('/v1/health').set('X-Request-Id', 'req-12345678');
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('rate limits with 429 RATE_LIMITED', async () => {
    const app = boot({ config: { RATE_LIMIT_PER_MINUTE: 2 } });
    await request(app).get('/v1/health').expect(200);
    await request(app).get('/v1/health').expect(200);
    const res = await request(app).get('/v1/health').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not advertise Express', async () => {
    const res = await request(boot()).get('/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('serves the spec with the health paths and the error schema when docs are on', async () => {
    const res = await request(boot()).get('/v1/openapi.json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/v1/health', '/v1/health/ready']));
    expect(res.body.components.schemas.ErrorResponse).toBeDefined();
    expect(res.body.paths['/v1/health/ready'].get.responses['503']).toBeDefined();
  });

  it('hides the spec and Swagger UI when docs are off', async () => {
    const app = boot({ config: { OPENAPI_DOCS: false } });
    await request(app).get('/v1/openapi.json').expect(404);
    await request(app).get('/v1/docs/').expect(404);
  });
});
