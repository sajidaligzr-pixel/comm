'use client';

/**
 * Client for the object-storage upload/download routes (docs/13-roadmap.md's media
 * pass). Deliberately NOT layered on `apiFetch` (lib/api-client.ts) for the actual
 * byte transfer — `apiFetch` assumes a JSON body and the `{ok,data}` envelope, but
 * the upload/download targets these routes return are either this app's own local-fs
 * route (raw bytes in/out) or a real S3 presigned URL (a different origin entirely,
 * no CSRF cookie to attach). `apiFetch` IS used for the two same-origin JSON routes
 * that mint those targets.
 */
import { apiFetch } from './api-client';
import type { CreateUploadUrlResponse, UploadTargetSchema } from '@comm/types';

// Advisory only — matches the server's own default (apps/web/server/modules/media/service.ts)
// so most users get fast client-side feedback, but the server's own
// `MEDIA_MAX_UPLOAD_BYTES`-derived cap is what's actually authoritative; a
// deployment that raises it server-side works fine even though this constant wasn't
// updated to match, it just means the client-side pre-check activates a bit early.
const CLIENT_SOFT_CAP_BYTES = 25 * 1024 * 1024;

/** The actual PUT-or-POST-with-fields branch every `CreateUploadUrlResponse`
 * target needs — factored out of `uploadAttachmentCiphertext` so
 * group-info-trigger.tsx's (unencrypted) avatar upload can reuse the identical
 * mechanics against a target minted by a completely different route, without
 * duplicating the two-shapes-of-presigned-upload branching. */
export async function uploadRawBytes(target: UploadTargetSchema, bytes: BlobPart): Promise<void> {
  let res: Response;
  if (target.method === 'PUT') {
    res = await fetch(target.url, { method: 'PUT', body: bytes as BodyInit });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
    form.append('file', new Blob([bytes]));
    res = await fetch(target.url, { method: 'POST', body: form });
  }
  if (!res.ok) {
    throw new Error(res.status === 413 ? 'File is too large.' : 'Upload failed. Please try again.');
  }
}

export async function uploadAttachmentCiphertext(ciphertext: Uint8Array): Promise<{ objectKey: string; encryptedSizeBytes: number }> {
  if (ciphertext.byteLength > CLIENT_SOFT_CAP_BYTES) {
    throw new Error(`Files must be under ${Math.floor(CLIENT_SOFT_CAP_BYTES / (1024 * 1024))} MB.`);
  }

  const { objectKey, target } = await apiFetch<CreateUploadUrlResponse>('/api/media/upload-url', {
    method: 'POST',
    body: { encryptedSizeBytes: ciphertext.byteLength },
  });

  await uploadRawBytes(target, ciphertext as BlobPart);

  return { objectKey, encryptedSizeBytes: ciphertext.byteLength };
}

export async function downloadAttachmentCiphertext(objectKey: string): Promise<Uint8Array> {
  const { url } = await apiFetch<{ url: string }>(`/api/media/${objectKey}/download-url`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Could not download this file — it may no longer be available.');
  }
  return new Uint8Array(await res.arrayBuffer());
}
