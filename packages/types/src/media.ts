import { z } from 'zod';

/**
 * `/media` — docs/13-roadmap.md's file-attachment pass, the real object-storage
 * pipeline that voice/image messages' inline-ciphertext trick was always meant to be
 * replaced/complemented by for general files. The server only ever sees an encrypted
 * byte count here — the file's actual key/nonce/name/mime-type travel end-to-end
 * inside the message envelope itself (packages/types's `MessageAttachmentRef` in
 * messages.ts), never through this module.
 */

// Kept in sync with apps/web's MEDIA_MAX_UPLOAD_BYTES env var default — see
// apps/web/server/modules/media/service.ts, which reads the real env value and uses
// this only as the outer Zod-level sanity ceiling (a request can't even be shaped to
// ask for more than this regardless of server config).
export const MEDIA_UPLOAD_HARD_CAP_BYTES = 200 * 1024 * 1024; // 200 MiB

export const CreateUploadUrlRequest = z.object({
  encryptedSizeBytes: z.number().int().positive().max(MEDIA_UPLOAD_HARD_CAP_BYTES),
});
export type CreateUploadUrlRequest = z.infer<typeof CreateUploadUrlRequest>;

export const UploadTargetSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('PUT'), url: z.string() }),
  z.object({ method: z.literal('POST'), url: z.string(), fields: z.record(z.string()) }),
]);
export type UploadTargetSchema = z.infer<typeof UploadTargetSchema>;

export const CreateUploadUrlResponse = z.object({
  objectKey: z.string().uuid(),
  target: UploadTargetSchema,
});
export type CreateUploadUrlResponse = z.infer<typeof CreateUploadUrlResponse>;

export const DownloadUrlResponse = z.object({
  url: z.string(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponse>;
