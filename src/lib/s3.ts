import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { Tenant } from '../models/Tenant.js';

/**
 * §16 FILE UPLOAD — presigned direct-to-storage PUT. Bytes never pass
 * through Express. S3-compatible (R2 recommended for free egress); works
 * unmodified against MinIO for local dev.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SPREADSHEET_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const PRESIGN_TTL_SECONDS = 300;
// §16 — 5 MB cap. Presigned PUT cannot itself enforce a byte cap portably
// across S3-compatible providers; the import/catalog services re-check
// Content-Length after fetching the object back (see modules/import/service.ts).
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_KEY, secretAccessKey: env.S3_SECRET },
});

export type UploadPurpose =
  | 'category-tile'
  | 'product-image'
  | 'banner'
  | 'tenant-logo'
  | 'delivery-proof'
  | 'import';

const extensionFor: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * Tenant slugs are unique, URL-safe and stable enough (only owners can
 * rename a shop, and rarely do) to double as the storage folder name — far
 * more legible than a bare ObjectId when browsing the bucket by hand.
 * Falls back to the id itself if the tenant can't be found, so a bad lookup
 * never blocks an upload.
 */
async function resolveTenantFolder(tenantId: string): Promise<string> {
  const tenant = await Tenant.findById(tenantId as unknown as Types.ObjectId).select('slug').lean();
  return tenant?.slug ?? tenantId;
}

/** §16 — path is `<tenantSlug>/<purpose>/<uuid>.<ext>`, so storage is auditable and deletable per tenant. */
export async function signUpload(
  tenantId: string,
  contentType: string,
  purpose: UploadPurpose,
): Promise<{ url: string; fileUrl: string }> {
  const allowed = purpose === 'import' ? SPREADSHEET_TYPES : IMAGE_TYPES;
  if (!allowed.includes(contentType)) {
    throw AppError.validationFailed({ contentType: `Not allowed for purpose "${purpose}".` });
  }

  const folder = await resolveTenantFolder(tenantId);
  const key = `${folder}/${purpose}/${randomUUID()}.${extensionFor[contentType]}`;

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SECONDS });
  const fileUrl = `${env.S3_PUBLIC_BASE}/${key}`;

  return { url, fileUrl };
}

/** §16 — delivery proof photos are PRIVATE, served via short-lived signed GET, never a public URL. */
export async function signPrivateUpload(
  tenantId: string,
  contentType: string,
): Promise<{ url: string; fileUrl: string }> {
  return signUpload(tenantId, contentType, 'delivery-proof');
}
