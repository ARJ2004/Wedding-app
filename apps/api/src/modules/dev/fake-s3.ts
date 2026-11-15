import express, { Router } from 'express';
import { FakeObjectStore, type ObjectStore } from '../../common/object-store';

/**
 * Dev-only stand-in for S3 presigned PUTs so the app preview and simulators can upload while
 * OBJECT_STORE=fake. Mounted only outside production (config validation refuses fake in prod).
 */
export function fakeS3Router(store: ObjectStore): Router | null {
  if (!(store instanceof FakeObjectStore)) return null;
  const router = Router();
  router.put('/v1/dev/fake-s3/:id', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    try {
      store.simulateUpload(req.originalUrl, req.body as Buffer, req.header('content-type') ?? 'application/octet-stream');
      res.status(200).end();
    } catch (e) {
      res.status((e as Error).message === 'EntityTooLarge' ? 413 : 400).json({ error: { code: 'FAKE_S3_REJECTED', message: (e as Error).message } });
    }
  });
  return router;
}
