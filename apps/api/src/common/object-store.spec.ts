import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectStore, FakeObjectStore, S3ObjectStore } from './object-store';

describe('S3ObjectStore presigning (no network)', () => {
  const store = new S3ObjectStore({
    bucket: 'mehfil-test',
    region: 'ap-south-1',
    endpoint: 'http://localhost:9000',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('signs a PUT for the exact key and content type with a short expiry', async () => {
    const { url, headers, expiresAt } = await store.presignPut({
      key: 'weddings/w1/photos/p1.jpg',
      contentType: 'image/jpeg',
      maxBytes: 10_000_000,
    });
    const u = new URL(url);
    expect(u.pathname).toBe('/mehfil-test/weddings/w1/photos/p1.jpg'); // path-style for MinIO
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    expect(headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('signs a GET with a download filename', async () => {
    const url = await store.presignGet('exports/a.zip', { downloadName: 'album.zip', expiresInSeconds: 60 });
    const u = new URL(url);
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment; filename="album.zip"');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});

describe('FakeObjectStore', () => {
  it('round-trips a simulated phone upload, copy and delete', async () => {
    const store = new FakeObjectStore();
    const { url } = await store.presignPut({ key: 'k1', contentType: 'image/jpeg', maxBytes: 5 });
    store.simulateUpload(url, Buffer.from('abc'), 'image/jpeg');
    expect(await store.head('k1')).toEqual({ contentType: 'image/jpeg', byteSize: 3 });
    await store.copy('k1', 'k2');
    expect((await store.get('k2'))?.toString()).toBe('abc');
    await store.delete('k1');
    expect(await store.head('k1')).toBeNull();
  });

  it('rejects uploads over the presigned limit', async () => {
    const store = new FakeObjectStore();
    const { url } = await store.presignPut({ key: 'k', contentType: 'image/jpeg', maxBytes: 2 });
    expect(() => store.simulateUpload(url, Buffer.from('abc'), 'image/jpeg')).toThrow('EntityTooLarge');
  });
});

describe('createObjectStore', () => {
  it('picks the implementation from config', () => {
    expect(createObjectStore({ OBJECT_STORE: 'fake' })).toBeInstanceOf(FakeObjectStore);
    expect(createObjectStore({ OBJECT_STORE: 'minio', S3_BUCKET: 'b' })).toBeInstanceOf(S3ObjectStore);
  });
});

describe('local disk store (dev)', () => {
  it('shares objects between two instances (API and worker processes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mehfil-'));
    const api = new FakeObjectStore('local', '', dir);
    const worker = new FakeObjectStore('local', '', dir);
    const { url } = await api.presignPut({ key: 'weddings/w/import/a.csv', contentType: 'text/csv', maxBytes: 100 });
    expect(url.startsWith('/v1/dev/fake-s3/')).toBe(true);
    api.simulateUpload(url, Buffer.from('Name\nAsha'), 'text/csv');
    expect((await worker.get('weddings/w/import/a.csv'))?.toString()).toBe('Name\nAsha');
    expect(await worker.head('weddings/w/import/a.csv')).toEqual({ contentType: 'text/csv', byteSize: 9 });
  });
});
