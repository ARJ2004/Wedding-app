import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { defineJob, type JobQueue } from '../../common/jobs';
import type { ObjectStore } from '../../common/object-store';
import { POLICIES, type UploadPolicy } from './policies';

export interface MediaDeps {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  jobs: JobQueue;
}

/** Hook run by media.process for a purpose once the object is verified (cover thumbnails land in CAM-07). */
export type Processor = (mediaId: string) => Promise<void>;

export function mediaJobs(deps: MediaDeps, processors: Record<string, Processor> = {}) {
  return {
    process: defineJob({
      name: 'media.process',
      lane: 'media',
      schema: z.object({ mediaId: z.string().uuid(), purpose: z.string() }),
      handler: async ({ mediaId, purpose }) => {
        const m = await deps.prisma.media_objects.findUnique({ where: { id: mediaId } });
        if (!m || m.status === 'deleted' || m.status === 'processed') return;
        await processors[purpose]?.(mediaId);
        await deps.prisma.media_objects.update({ where: { id: mediaId }, data: { status: 'processed' } });
      },
    }),
  };
}

export class MediaService {
  readonly jobs: ReturnType<typeof mediaJobs>;

  constructor(private readonly deps: MediaDeps) {
    this.jobs = mediaJobs(deps);
  }

  static policyFor(purpose: string): UploadPolicy {
    const policy = POLICIES[purpose];
    if (!policy) throw new AppError('MEDIA_PURPOSE_UNKNOWN', 'Unknown upload purpose', 400);
    return policy;
  }

  /** Validates type/size against the policy, creates a pending media row, returns a presigned PUT. */
  async createUpload(input: { weddingId: string; userId: string; purpose: string; contentType: string; byteSize: number }) {
    const policy = MediaService.policyFor(input.purpose);
    const ext = policy.contentTypes[input.contentType];
    if (!ext) throw new AppError('MEDIA_TYPE_NOT_ALLOWED', 'This file type is not allowed here', 415);
    if (input.byteSize > policy.maxBytes) {
      throw new AppError('MEDIA_TOO_LARGE', `Files up to ${Math.round(policy.maxBytes / 1048576)} MB`, 413);
    }
    const media = await this.deps.prisma.media_objects.create({
      data: {
        wedding_id: input.weddingId,
        kind: policy.kind,
        s3_bucket: this.deps.objectStore.defaultBucket,
        s3_key: `pending/${randomUUID()}`,
        content_type: input.contentType,
        byte_size: input.byteSize,
        uploaded_by_user_id: input.userId,
        delete_after: policy.deleteAfterDays ? new Date(Date.now() + policy.deleteAfterDays * 86_400_000) : null,
      },
    });
    const key = `weddings/${input.weddingId}/${policy.purpose}/${media.id}${ext}`;
    await this.deps.prisma.media_objects.update({ where: { id: media.id }, data: { s3_key: key } });
    const put = await this.deps.objectStore.presignPut({ key, contentType: input.contentType, maxBytes: policy.maxBytes });
    return { mediaId: media.id, uploadUrl: put.url, headers: put.headers, expiresAt: put.expiresAt.toISOString() };
  }

  /** The uploader confirms the PUT; we check the object is really there and the size matches. */
  async complete(mediaId: string, userId: string, purpose?: string) {
    const m = await this.deps.prisma.media_objects.findFirst({ where: { id: mediaId, uploaded_by_user_id: userId } });
    if (!m) throw new AppError('MEDIA_NOT_FOUND', 'Upload not found', 404);
    if (m.status !== 'pending') return { mediaId, status: m.status };
    const head = await this.deps.objectStore.head(m.s3_key, m.s3_bucket);
    if (!head) throw new AppError('MEDIA_OBJECT_MISSING', 'The file has not arrived yet; retry the upload', 409);
    if (m.byte_size != null && BigInt(head.byteSize) !== m.byte_size) {
      throw new AppError('MEDIA_SIZE_MISMATCH', 'The uploaded file size does not match', 422);
    }
    await this.deps.prisma.media_objects.update({ where: { id: mediaId }, data: { status: 'uploaded' } });
    const policyPurpose = purpose ?? m.s3_key.split('/')[2] ?? 'unknown';
    await this.deps.jobs.send(this.jobs.process, { mediaId, purpose: policyPurpose }, { singletonKey: mediaId });
    return { mediaId, status: 'uploaded' };
  }

  /** For owning modules: an uploaded file of the right kind in the right wedding, or a 4xx. */
  async requireUploaded(mediaId: string, weddingId: string, kind: UploadPolicy['kind']) {
    const m = await this.deps.prisma.media_objects.findFirst({ where: { id: mediaId, wedding_id: weddingId, kind } });
    if (!m) throw new AppError('MEDIA_NOT_FOUND', 'File not found', 404);
    if (m.status !== 'uploaded' && m.status !== 'processed') throw new AppError('MEDIA_NOT_READY', 'Finish the upload first', 409);
    return m;
  }

  read(mediaId: string) {
    return this.deps.prisma.media_objects.findUniqueOrThrow({ where: { id: mediaId } }).then(async (m) => {
      const body = await this.deps.objectStore.get(m.s3_key, m.s3_bucket);
      if (!body) throw new AppError('MEDIA_OBJECT_MISSING', 'File is missing', 409);
      return body;
    });
  }
}
