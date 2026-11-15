import type { Action } from '@mehfil/domain';

/**
 * Upload policy registry (CAM-01a, 12-cam §4). One entry per purpose: who may upload, which
 * content types and sizes, which media kind it becomes and how long it lives. Camera, gallery,
 * feed, ticket and selfie policies are added by their stories (CAM-01b, TRV-02, FEED, FACE).
 */
export interface UploadPolicy {
  purpose: string;
  kind: 'photo' | 'ticket' | 'id_document' | 'selfie' | 'video' | 'export' | 'cover' | 'other';
  /** Host permission required (guests get their own policies later). */
  permission: Action;
  contentTypes: Record<string, string>; // content type → file extension
  maxBytes: number;
  /** Days until retention deletes the object; null = kept with the wedding. */
  deleteAfterDays: number | null;
}

const IMAGE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };

export const POLICIES: Record<string, UploadPolicy> = {
  cover: {
    purpose: 'cover',
    kind: 'cover',
    permission: 'wedding.settings.update',
    contentTypes: IMAGE,
    maxBytes: 10 * 1024 * 1024,
    deleteAfterDays: null,
  },
  import: {
    purpose: 'import',
    kind: 'other',
    permission: 'guest.import',
    contentTypes: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/csv': '.csv',
      'application/vnd.ms-excel': '.csv', // what some Android pickers report for .csv
    },
    maxBytes: 5 * 1024 * 1024,
    deleteAfterDays: 7,
  },
};

export type UploadPurpose = keyof typeof POLICIES;
export const UPLOAD_PURPOSES = Object.keys(POLICIES) as [UploadPurpose, ...UploadPurpose[]];
