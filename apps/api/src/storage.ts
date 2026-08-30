/**
 * Object storage for uploaded documents (MinIO locally, S3/R2 deployed).
 *
 * Two rules from PROJECT_REPORT.md §10 are enforced here rather than left to
 * convention:
 *
 *   1. THE BUCKET IS NEVER PUBLIC. Nothing in this module produces an
 *      unauthenticated URL. Reviewers get short-TTL signed URLs from
 *      `signedReadUrl`, and the TTL is short because a signed URL that outlives
 *      the review session is a public URL with extra steps.
 *
 *   2. DOCUMENTS ARE PURGEABLE. `remove` exists so the retention job can
 *      actually delete bytes. The sha256 stays in the audit trail after the
 *      document is gone, which is what keeps a past decision traceable to a
 *      specific file without retaining the file.
 *
 * Storage keys are opaque and derived from the document UUID, never from the
 * applicant's name or the original filename — an object key that leaks who
 * uploaded it is a disclosure in any log line that mentions it.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from './config.js';

export const s3 = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  // MinIO serves buckets as a path, not a subdomain. Without this the SDK
  // resolves http://bucket.localhost:9000 and every request fails DNS.
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});

/** Reviewer link lifetime. Long enough to open, short enough not to circulate. */
const SIGNED_URL_TTL_SECONDS = 300;

export function storageKeyFor(documentId: string, contentType: string): string {
  const extension = contentType === 'application/pdf' ? 'pdf' : 'jpg';
  return `documents/${documentId}.${extension}`;
}

export async function put(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function get(key: string): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Object ${key} has no body`);
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function remove(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
}

export async function signedReadUrl(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}

/**
 * How the pipeline reads a document.
 *
 * An interface rather than a direct call to `get`, so stage handlers can be
 * tested against an in-memory map without MinIO running. The pipeline's
 * idempotency and ordering guarantees are the part worth testing, and they
 * should not require object storage to exercise.
 */
export type DocumentLoader = (storageKey: string) => Promise<Buffer>;

export const s3DocumentLoader: DocumentLoader = (storageKey) => get(storageKey);
