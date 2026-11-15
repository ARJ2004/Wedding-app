import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

/**
 * In-memory ObjectStore for tests and offline dev. Presigned URLs are fake:// strings that
 * tests can hand to `simulateUpload()` to play the part of the phone uploading to S3.
 */
export class FakeObjectStore implements ObjectStore {
  readonly defaultBucket: string;
  private readonly objects = new Map<string, FakeObject>();

  constructor(bucket = 'fake-bucket') {
    this.defaultBucket = bucket;
  }

  private id(key: string, bucket?: string) {
    return `${bucket ?? this.defaultBucket}/${key}`;
  }

  async presignPut(input: PresignPutInput) {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_PUT_EXPIRY;
    const url = `fake://${this.id(input.key, input.bucket)}?op=put&maxBytes=${input.maxBytes}`;
    return { url, headers: { 'Content-Type': input.contentType }, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async presignGet(key: string, opts: { bucket?: string } = {}) {
    return `fake://${this.id(key, opts.bucket)}?op=get`;
  }

  /** Test helper: what the phone does with a presigned PUT URL. */
  simulateUpload(url: string, body: Buffer, contentType: string) {
    const match = /^fake:\/\/([^?]+)\?op=put&maxBytes=(\d+)$/.exec(url);
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
    return [...this.objects.keys()];
  }
}

/** Builds the configured store; config validation already refused `fake` in production. */
export function createObjectStore(config: {
  OBJECT_STORE: 's3' | 'minio' | 'fake';
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}): ObjectStore {
  if (config.OBJECT_STORE === 'fake') return new FakeObjectStore(config.S3_BUCKET ?? 'fake-bucket');
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
