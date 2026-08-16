/**
 * Object storage abstraction for the file-attachment pipeline
 * (docs/13-roadmap.md's media pass, docs/05-crypto-architecture.md#media-encryption).
 *
 * The server only ever handles ciphertext bytes here — the attachment's actual
 * encryption key/nonce/filename/mime-type never reach it; they travel inside the
 * already end-to-end-encrypted message envelope (apps/web/lib/crypto/attachment-crypto.ts,
 * conversation-crypto.ts). This module's whole job is: "give the client somewhere to
 * PUT/POST opaque bytes, and a way to GET them back later, gated by conversation
 * membership" — nothing here ever needs to know what's inside a file.
 *
 * Lives in `packages/storage` (not `apps/web`) for the same reason
 * `packages/security`'s `createRedisSubscriber` does: both `apps/web` (the
 * upload/download routes) and `apps/worker` (the orphaned-object cleanup sweep,
 * `apps/worker/src/jobs/cleanup.ts`) need the identical implementation — two
 * independent copies is exactly the kind of drift risk this monorepo's
 * module-isolation rule (docs/01-folder-structure.md) exists to avoid.
 *
 * Two implementations, selected by `getObjectStorage()` below the same way this
 * project already gates TURN/push on whether their env vars are configured
 * (apps/web/app/api/calls/turn-credentials/route.ts, apps/worker's push dispatcher):
 * real S3-compatible storage when `OBJECT_STORAGE_*` are set (production, matches
 * docs/11-deployment-architecture.md's committed design), a local-filesystem adapter
 * otherwise (dev default — zero setup, no cloud account needed, consistent with this
 * project's "plain Node process, no Docker" local-dev stance already used for
 * Postgres/Redis).
 */

import { S3ObjectStorage } from './s3-storage';
import { LocalFsObjectStorage } from './local-fs-storage';

export type UploadTarget =
  | { method: 'PUT'; url: string }
  | { method: 'POST'; url: string; fields: Record<string, string> };

export interface ObjectStorage {
  /** Mint somewhere the client can upload `objectKey`'s ciphertext bytes, capped at
   * `maxBytes`. The cap is enforced by the adapter itself (see each implementation's
   * docstring for how) — a declared `encryptedSizeBytes` at upload-url mint time is
   * not itself a security boundary, same framing as `packages/types`'s
   * `MessageEnvelopeUpload` docstring already applies to the 4 MiB inline-ciphertext
   * cap. */
  createUploadTarget(objectKey: string, maxBytes: number): Promise<UploadTarget>;
  /** Mint a short-lived URL the client can GET `objectKey`'s ciphertext bytes from.
   * Caller is responsible for the membership check before minting this — see
   * apps/web/server/modules/media/service.ts. */
  createDownloadUrl(objectKey: string): Promise<string>;
  /** Best-effort delete — used by apps/worker's orphaned-object sweep
   * (jobs/cleanup.ts) and could be wired to message deletion later. */
  deleteObject(objectKey: string): Promise<void>;
  /** Used only by the orphaned-object cleanup sweep to find objects with no matching
   * `message_attachments` row. Returns object keys older than `olderThan`. */
  listObjectKeysOlderThan(olderThan: Date): Promise<string[]>;
}

let cached: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  if (cached) return cached;
  const { OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY } =
    process.env;
  if (OBJECT_STORAGE_ENDPOINT && OBJECT_STORAGE_BUCKET && OBJECT_STORAGE_ACCESS_KEY_ID && OBJECT_STORAGE_SECRET_ACCESS_KEY) {
    cached = new S3ObjectStorage({
      endpoint: OBJECT_STORAGE_ENDPOINT,
      bucket: OBJECT_STORAGE_BUCKET,
      accessKeyId: OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: OBJECT_STORAGE_SECRET_ACCESS_KEY,
    });
  } else {
    cached = new LocalFsObjectStorage();
  }
  return cached;
}

/** Test-only escape hatch — never called from application code. */
export function __resetObjectStorageCacheForTests(): void {
  cached = undefined;
}
