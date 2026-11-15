import express from 'express';
import request from 'supertest';
import { Metrics } from './observability';

describe('Metrics', () => {
  it('labels latency by route template, never by the raw URL', async () => {
    const metrics = new Metrics({ defaults: false });
    const app = express();
    app.use(metrics.middleware());
    app.get('/v1/weddings/:weddingId', (_req, res) => {
      res.json({ ok: true });
    });
    await request(app).get('/v1/weddings/0193abcd-secret-id').expect(200);
    await request(app).get('/v1/nope').expect(404);
    const text = await metrics.registry.metrics();
    expect(text).toContain('route="/v1/weddings/:weddingId"');
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('0193abcd-secret-id');
  });

  it('counts job outcomes', async () => {
    const metrics = new Metrics({ defaults: false });
    metrics.jobs.inc({ queue: 'media.process', outcome: 'failed' });
    expect(await metrics.registry.metrics()).toContain('mehfil_jobs_total{queue="media.process",outcome="failed"} 1');
  });
});
