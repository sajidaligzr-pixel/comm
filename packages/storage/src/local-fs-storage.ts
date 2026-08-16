/**
 * Dev-default `ObjectStorage` adapter — a private directory on disk, "signed URLs"
 * implemented as short-lived HMAC tokens verified by
 * `apps/web/app/api/media/objects/[objectKey]/route.ts`. This is the exact same
 * `createHmac('sha1', secret)`-style short-lived-credential pattern already used by
 * `apps/web/app/api/calls/turn-credentials/route.ts` — not a new authorization
 * mechanism invented for this file.
 *
 * Never used in production: `getObjectStorage()` (./storage.ts) only falls back to
 * this when `OBJECT_STORAGE_*` env vars are unset, matching how the TURN route
 * degrades to an empty ICE list and the push dispatcher disables itself when their
 * own env vars are unset. Deliberately scoped as dev-only convenience so a fresh
 * checkout works with zero cloud signup — see docs/11-deployment-architecture.md.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObjectStorage, UploadTarget } from './storage';

// Resolved from THIS FILE's on-disk location, not `process.cwd()` — apps/web and
// apps/worker run as separate processes with different working directories, but
// both need to agree on the exact same directory for this to work at all (the
// worker's cleanup sweep has to see the same files apps/web's upload route wrote).
// `packages/storage/src/local-fs-storage.ts` -> repo root is three `..` up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STORE_DIR = path.join(REPO_ROOT, '.data', 'media-objects');
const TOKEN_TTL_SECONDS = 600; // matches the TURN credential route's 10-minute TTL

function tokenSecret(): string {
  const base = process.env.CSRF_SECRET;
  if (!base) {
    throw new Error('CSRF_SECRET is not set — required (indirectly) to mint local media storage tokens.');
  }
  // Domain-separated from CSRF's own use of this secret, same reasoning as the
  // X3DH_KDF_INFO / ROOT_KDF_INFO domain-separation strings in packages/crypto —
  // reusing an existing secret for an unrelated purpose is fine as long as the two
  // uses can never be confused for each other.
  return createHmac('sha256', base).update('comm-media-local-storage-token-v1').digest('hex');
}

interface TokenPayload {
  objectKey: string;
  op: 'put' | 'get';
  maxBytes: number;
  expiresAt: number; // unix seconds
}

function signToken(payload: TokenPayload): string {
  const body = `${payload.objectKey}:${payload.op}:${payload.maxBytes}:${payload.expiresAt}`;
  const sig = createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}

/** Exported for the route handler (`app/api/media/objects/[objectKey]/route.ts`) to
 * verify a token against the request's method + objectKey. Returns the payload if
 * valid, `null` otherwise (expired, wrong objectKey/op, or bad signature) — the route
 * maps `null` to a 403, never leaking which check failed. */
export function verifyLocalStorageToken(token: string, objectKey: string, op: 'put' | 'get'): TokenPayload | null {
  const [bodyB64, sig] = token.split('.');
  if (!bodyB64 || !sig) return null;
  const body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  const expectedSig = createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  const [payloadObjectKey, payloadOp, maxBytesStr, expiresAtStr] = body.split(':');
  const payload: TokenPayload = {
    objectKey: payloadObjectKey ?? '',
    op: payloadOp as 'put' | 'get',
    maxBytes: Number(maxBytesStr),
    expiresAt: Number(expiresAtStr),
  };
  if (payload.objectKey !== objectKey || payload.op !== op) return null;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now() / 1000) return null;
  return payload;
}

function objectPath(objectKey: string): string {
  // objectKey is always our own crypto.randomUUID() output (see
  // apps/web/server/modules/media/service.ts) — validated as a UUID before it ever
  // reaches here, so this can't be a path traversal vector, but the check is kept
  // anyway as defense in depth rather than trusting that invariant silently.
  if (!/^[0-9a-f-]{36}$/i.test(objectKey)) {
    throw new Error('Invalid object key.');
  }
  return path.join(STORE_DIR, objectKey);
}

export class LocalFsObjectStorage implements ObjectStorage {
  async createUploadTarget(objectKey: string, maxBytes: number): Promise<UploadTarget> {
    await mkdir(STORE_DIR, { recursive: true });
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = signToken({ objectKey, op: 'put', maxBytes, expiresAt });
    return { method: 'PUT', url: `/api/media/objects/${objectKey}?token=${token}` };
  }

  async createDownloadUrl(objectKey: string): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    // maxBytes is meaningless for a download token; kept at 0 rather than making it
    // optional so one TokenPayload shape covers both operations.
    const token = signToken({ objectKey, op: 'get', maxBytes: 0, expiresAt });
    return `/api/media/objects/${objectKey}?token=${token}`;
  }

  async deleteObject(objectKey: string): Promise<void> {
    await unlink(objectPath(objectKey)).catch(() => undefined);
  }

  async listObjectKeysOlderThan(olderThan: Date): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(STORE_DIR);
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.includes('.tmp-')) continue; // in-progress upload, not a real object yet
      const st = await stat(path.join(STORE_DIR, entry)).catch(() => null);
      if (st && st.mtime < olderThan) results.push(entry);
    }
    return results;
  }
}

/** Used only by `app/api/media/objects/[objectKey]/route.ts` — writes a request body
 * stream to disk, aborting (and cleaning up the partial file) if it exceeds
 * `maxBytes`. This is where the local adapter gets its size-cap guarantee from,
 * mirroring what the S3 adapter gets for free from a presigned POST's
 * `content-length-range` condition. */
export async function writeObjectStream(objectKey: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  const tmpPath = objectPath(objectKey) + `.tmp-${randomUUID()}`;
  const handle = await open(tmpPath, 'w');
  let written = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        throw new Error('Upload exceeds the configured size limit.');
      }
      await handle.write(value);
    }
    await handle.close();
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, objectPath(objectKey));
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function readObjectStream(objectKey: string): Promise<ReadableStream<Uint8Array> | null> {
  const { createReadStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  try {
    await stat(objectPath(objectKey));
  } catch {
    return null;
  }
  return Readable.toWeb(createReadStream(objectPath(objectKey))) as ReadableStream<Uint8Array>;
}
