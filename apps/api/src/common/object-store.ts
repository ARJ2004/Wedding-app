import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PresignPutInput {
  key: string;
  contentType: string;
  /** Upper bound the client promised; enforced again on completion via head(). */
  maxBytes: number;
  expiresInSeconds?: number;
  bucket?: string;
}

export interface ObjectHead {
  contentType: string | undefined;
  byteSize: number;
}

/**
 * The only way modules touch S3 (baseline: media flow). Production uses S3, local dev uses
 * MinIO through the same class, tests use FakeObjectStore. Buckets are private; reads are
 * presigned GETs (or CloudFront signed URLs for previews, added with CAM-07).
 */
export interface ObjectStore {
  readonly defaultBucket: string;
  presignPut(input: PresignPutInput): Promise<{ url: string; headers: Record<string, string>; expiresAt: Date }>;
  presignGet(key: string, opts?: { expiresInSeconds?: number; bucket?: string; downloadName?: string }): Promise<string>;
  head(key: string, bucket?: string): Promise<ObjectHead | null>;
  get(key: string, bucket?: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string, bucket?: string): Promise<void>;
  delete(key: string, bucket?: string): Promise<void>;
  copy(fromKey: string, toKey: string, opts?: { fromBucket?: string; toBucket?: string }): Promise<void>;
}

const DEFAULT_PUT_EXPIRY = 300;
const DEFAULT_GET_EXPIRY = 300;

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  /** MinIO or another S3-compatible endpoint; switches to path-style addressing. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class S3ObjectStore implements ObjectStore {
  readonly defaultBucket: string;
  private readonly s3: S3Client;

  constructor(opts: S3ObjectStoreOptions, client?: S3Client) {
    this.defaultBucket = opts.bucket;
    this.s3 =
      client ??
      new S3Client({
        region: opts.region,
        endpoint: opts.endpoint,
        forcePathStyle: Boolean(opts.endpoint),
        credentials: opts.credentials,
      });
  }

  async presignPut(input: PresignPutInput) {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_PUT_EXPIRY;
    const command = new PutObjectCommand({
      Bucket: input.bucket ?? this.defaultBucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn });
    return { url, headers: { 'Content-Type': input.contentType }, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  presignGet(key: string, opts: { expiresInSeconds?: number; bucket?: string; downloadName?: string } = {}) {
    const command = new GetObjectCommand({
      Bucket: opts.bucket ?? this.defaultBucket,
      Key: key,
      ResponseContentDisposition: opts.downloadName ? `attachment; filename="${opts.downloadName}"` : undefined,
    });
    return getSignedUrl(this.s3, command, { expiresIn: opts.expiresInSeconds ?? DEFAULT_GET_EXPIRY });
  }

  async head(key: string, bucket?: string): Promise<ObjectHead | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: bucket ?? this.defaultBucket, Key: key }));
      return { contentType: out.ContentType, byteSize: out.ContentLength ?? 0 };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async get(key: string, bucket?: string): Promise<Buffer | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket ?? this.defaultBucket, Key: key }));
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer, contentType: string, bucket?: string) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: bucket ?? this.defaultBucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string, bucket?: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket ?? this.defaultBucket, Key: key }));
  }

  async copy(fromKey: string, toKey: string, opts: { fromBucket?: string; toBucket?: string } = {}) {
    const from = opts.fromBucket ?? this.defaultBucket;
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: opts.toBucket ?? this.defaultBucket,
        Key: toKey,
        CopySource: `${from}/${encodeURIComponent(toS3Path(fromKey))}`.replace(/%2F/g, '/'),
      }),
    );
  }
}

const toS3Path = (key: string) => key.replace(/^\/+/, '');

interface FakeObject {
  body: Buffer;
  contentType: string;
}

/** Where fake/local stores keep objects. The in-memory map is per process; disk is shared. */
interface Backend {
  get(id: string): FakeObject | undefined;
  set(id: string, obj: FakeObject): void;
  delete(id: string): void;
  keys(): string[];
}

class MemoryBackend implements Backend {
  private readonly map = new Map<string, FakeObject>();
  get = (id: string) => this.map.get(id);
  set = (id: string, obj: FakeObject) => void this.map.set(id, obj);
  delete = (id: string) => void this.map.delete(id);
  keys = () => [...this.map.keys()];
}

/** Dev only: objects as files so the API and the worker process see the same uploads. */
class DiskBackend implements Backend {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private file(id: string) {
    return join(this.dir, Buffer.from(id).toString('base64url'));
  }
  get(id: string) {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    return { body: readFileSync(f), contentType: readFileSync(`${f}.type`, 'utf8') };
  }
  set(id: string, obj: FakeObject) {
    writeFileSync(this.file(id), obj.body);
    writeFileSync(`${this.file(id)}.type`, obj.contentType);
  }
  delete(id: string) {
    rmSync(this.file(id), { force: true });
    rmSync(`${this.file(id)}.type`, { force: true });
  }
  keys() {
    return readdirSync(this.dir)
      .filter((f) => !f.endsWith('.type'))
      .map((f) => Buffer.from(f, 'base64url').toString());
  }
}

/**
 * In-memory ObjectStore for tests and offline dev. Presigned URLs are fake:// strings that
 * tests can hand to `simulateUpload()` to play the part of the phone uploading to S3.
 */
export class FakeObjectStore implements ObjectStore {
  readonly defaultBucket: string;
  private readonly objects: Backend;

  /**
   * @param publicBaseUrl when set (dev preview only), presigned PUTs point at the API's dev upload
   *   sink (`PUT {base}/v1/dev/fake-s3/...`) so a browser or simulator can upload for real.
   */
  constructor(
    bucket = 'fake-bucket',
    private readonly publicBaseUrl?: string,
    diskDir?: string,
  ) {
    this.defaultBucket = bucket;
    this.objects = diskDir ? new DiskBackend(diskDir) : new MemoryBackend();
  }

  private id(key: string, bucket?: string) {
    return `${bucket ?? this.defaultBucket}/${key}`;
  }

  async presignPut(input: PresignPutInput) {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_PUT_EXPIRY;
    const id = this.id(input.key, input.bucket);
    const url =
      this.publicBaseUrl !== undefined
        ? `${this.publicBaseUrl}/v1/dev/fake-s3/${encodeURIComponent(id)}?maxBytes=${input.maxBytes}`
        : `fake://${id}?op=put&maxBytes=${input.maxBytes}`;
    return { url, headers: { 'Content-Type': input.contentType }, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async presignGet(key: string, opts: { bucket?: string } = {}) {
    const id = this.id(key, opts.bucket);
    return this.publicBaseUrl !== undefined
      ? `${this.publicBaseUrl}/v1/dev/fake-s3/${encodeURIComponent(id)}?op=get`
      : `fake://${id}?op=get`;
  }

  /** Dev sink: read an object by its presigned GET URL. */
  readByUrl(url: string): FakeObject | undefined {
    const dev = /\/v1\/dev\/fake-s3\/([^?]+)\?op=get$/.exec(url);
    return dev ? this.objects.get(decodeURIComponent(dev[1]!)) : undefined;
  }

  /** Test helper: what the phone does with a presigned PUT URL. */
  simulateUpload(url: string, body: Buffer, contentType: string) {
    const fake = /^fake:\/\/([^?]+)\?op=put&maxBytes=(\d+)$/.exec(url);
    const dev = /\/v1\/dev\/fake-s3\/([^?]+)\?maxBytes=(\d+)$/.exec(url);
    const match = fake ?? (dev ? [dev[0], decodeURIComponent(dev[1]!), dev[2]] : null);
    if (!match) throw new Error(`not a fake presigned PUT url: ${url}`);
    if (body.length > Number(match[2])) throw new Error('EntityTooLarge');
    this.objects.set(match[1]!, { body, contentType });
  }

  async head(key: string, bucket?: string) {
    const obj = this.objects.get(this.id(key, bucket));
    return obj ? { contentType: obj.contentType, byteSize: obj.body.length } : null;
  }

  async get(key: string, bucket?: string) {
    return this.objects.get(this.id(key, bucket))?.body ?? null;
  }

  async put(key: string, body: Buffer, contentType: string, bucket?: string) {
    this.objects.set(this.id(key, bucket), { body, contentType });
  }

  async delete(key: string, bucket?: string) {
    this.objects.delete(this.id(key, bucket));
  }

  async copy(fromKey: string, toKey: string, opts: { fromBucket?: string; toBucket?: string } = {}) {
    const obj = this.objects.get(this.id(fromKey, opts.fromBucket));
    if (!obj) throw new Error('NoSuchKey');
    this.objects.set(this.id(toKey, opts.toBucket), { ...obj });
  }

  keys(): string[] {
    return this.objects.keys();
  }
}

/** Builds the configured store; config validation already refused `fake` in production. */
export function createObjectStore(config: {
  OBJECT_STORE: 's3' | 'minio' | 'fake' | 'local';
  LOCAL_STORE_DIR?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  FAKE_S3_PUBLIC_BASE?: string;
}): ObjectStore {
  if (config.OBJECT_STORE === 'fake') return new FakeObjectStore(config.S3_BUCKET ?? 'fake-bucket', config.FAKE_S3_PUBLIC_BASE);
  if (config.OBJECT_STORE === 'local') {
    return new FakeObjectStore(config.S3_BUCKET ?? 'local', config.FAKE_S3_PUBLIC_BASE ?? '', config.LOCAL_STORE_DIR ?? '.data/objects');
  }
  const credentials =
    config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
      : undefined; // on EC2 the instance role supplies credentials
  return new S3ObjectStore({
    bucket: config.S3_BUCKET ?? 'mehfil-dev',
    region: config.S3_REGION ?? 'ap-south-1',
    endpoint: config.OBJECT_STORE === 'minio' ? (config.S3_ENDPOINT ?? 'http://localhost:9000') : undefined,
    credentials,
  });
}
