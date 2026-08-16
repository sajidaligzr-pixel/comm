/**
 * Production `ObjectStorage` adapter — any S3-compatible bucket (AWS S3, Cloudflare
 * R2, etc.), matching docs/11-deployment-architecture.md's already-committed design:
 * private bucket, signed URLs only, no self-hosted storage service. Selected
 * automatically by `getObjectStorage()` (./storage.ts) once `OBJECT_STORAGE_*` env
 * vars are all set.
 *
 * Upload uses a presigned POST (not a presigned PUT) specifically so
 * `content-length-range` can be enforced by S3 itself before the object is ever
 * written — a presigned PUT alone can't enforce a size cap server-side, and this
 * project doesn't treat a client-declared size as a security boundary anywhere else
 * either (see packages/types's `MessageEnvelopeUpload` docstring for the same
 * reasoning applied to the inline-ciphertext cap).
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { ObjectStorage, UploadTarget } from './storage';

const DOWNLOAD_URL_TTL_SECONDS = 300;
const UPLOAD_URL_TTL_SECONDS = 600;

export interface S3ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3ObjectStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      // Region is required by the SDK's types even for R2/MinIO-style endpoints that
      // don't really use it — 'auto' is the conventional placeholder those providers
      // themselves document for this field.
      region: process.env.OBJECT_STORAGE_REGION || 'auto',
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
    });
  }

  async createUploadTarget(objectKey: string, maxBytes: number): Promise<UploadTarget> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: objectKey,
      Conditions: [['content-length-range', 0, maxBytes]],
      Expires: UPLOAD_URL_TTL_SECONDS,
    });
    return { method: 'POST', url, fields };
  }

  async createDownloadUrl(objectKey: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async listObjectKeysOlderThan(olderThan: Date): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: continuationToken }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key && obj.LastModified && obj.LastModified < olderThan) keys.push(obj.Key);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }
}
