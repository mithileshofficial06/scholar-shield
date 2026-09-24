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

import { createHash } from 'node:crypto';

import { config } from './config.js';
import { extensionFor, type SniffedType } from './uploads.js';

function client(endpoint: string): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    endpoint,
    // MinIO serves buckets as a path, not a subdomain. Without this the SDK
    // resolves http://bucket.localhost:9000 and every request fails DNS.
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });
}

export const s3 = client(config.S3_ENDPOINT);

/**
 * Signs URLs against the address a browser uses. A presigned URL embeds its
 * host, so one signed against `http://minio:9000` is valid and unreachable.
 * Signing is local — this client never opens a connection.
 */
const publicS3 = config.S3_PUBLIC_ENDPOINT ? client(config.S3_PUBLIC_ENDPOINT) : s3;

/** Reviewer link lifetime. Long enough to open, short enough not to circulate. */
const SIGNED_URL_TTL_SECONDS = 300;

export function storageKeyFor(documentId: string, contentType: string): string {
  // The extension follows the sniffed type, never the uploaded filename.
  const extension = extensionFor(contentType as SniffedType) ?? 'bin';
  return `documents/${documentId}.${extension}`;
}

/**
 * The hash kept in the audit trail after the document itself is purged, so a
 * past decision stays traceable to a specific file without retaining the file.
 */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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
    publicS3,
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
