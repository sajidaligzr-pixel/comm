import { randomUUID } from 'node:crypto';
import { prisma, Prisma } from '@comm/database';
import { AppError, type CreateUploadUrlResponse, MEDIA_UPLOAD_HARD_CAP_BYTES, type MessageAttachmentRef } from '@comm/types';
import { getRedisClient } from '@comm/security';
import { getObjectStorage } from '@comm/storage';
import { requireConversationMembership } from '../conversations/service';

// Server-enforced ceiling — a client-declared `encryptedSizeBytes` at mint time is
// not itself a security boundary (same framing as packages/types's
// MessageEnvelopeUpload docstring), so this is what actually gates it, alongside each
// storage adapter's own enforcement (content-length-range for S3, a streamed byte
// count for the local-fs adapter).
function maxUploadBytes(): number {
  const configured = Number(process.env.MEDIA_MAX_UPLOAD_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, MEDIA_UPLOAD_HARD_CAP_BYTES);
  }
  return 25 * 1024 * 1024; // 25 MiB default
}

/**
 * A per-account ceiling on how many bytes of *currently-live* file attachments one
 * account can have sitting in object storage at once — closes a real gap the
 * per-file cap above doesn't: `MEDIA_MAX_UPLOAD_BYTES` bounds any single upload, but
 * says nothing about one account sending enough separate files, back to back, to
 * fill the disk (docs/10-privacy-data-retention.md's media retention pass shortens
 * how long any of this sticks around to 24h, but a determined account could still
 * exhaust real disk space well inside that window without a cap on the running
 * total). Configurable since the right number depends on the deployment's actual
 * disk size — the local-fs dev adapter and a small self-hosted production box don't
 * have the same headroom a managed S3 bucket would.
 */
function accountQuotaBytes(): number {
  const configured = Number(process.env.MEDIA_ACCOUNT_QUOTA_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 500 * 1024 * 1024; // 500 MiB default
}

/** Sum of `encryptedSizeBytes` across every attachment this account has sent that
 * hasn't yet been deleted or expired (docs/10-privacy-data-retention.md's media
 * retention sweep already reclaims this automatically after 24h — this is what
 * stops the account from re-filling that space faster than it drains). */
async function liveAttachmentBytesForUser(userId: string): Promise<number> {
  const result = await prisma.messageAttachment.aggregate({
    _sum: { encryptedSizeBytes: true },
    where: { message: { senderUserId: userId, deletedAt: null } },
  });
  return Number(result._sum.encryptedSizeBytes ?? 0n);
}

function pendingUploadKey(objectKey: string): string {
  return `media:pending:${objectKey}`;
}

const PENDING_UPLOAD_TTL_SECONDS = 600; // matches the signed upload URL's own TTL

export async function createUploadUrl(
  ctx: { userId: string },
  encryptedSizeBytes: number,
): Promise<CreateUploadUrlResponse> {
  const cap = maxUploadBytes();
  if (encryptedSizeBytes > cap) {
    throw new AppError('MEDIA_TOO_LARGE', `Files must be under ${Math.floor(cap / (1024 * 1024))} MB.`);
  }

  const quota = accountQuotaBytes();
  const currentUsage = await liveAttachmentBytesForUser(ctx.userId);
  if (currentUsage + encryptedSizeBytes > quota) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      `You're at your storage limit (${Math.floor(quota / (1024 * 1024))} MB of files currently in your chats). Space frees up automatically as older files expire — try again later, or delete a file you no longer need.`,
    );
  }

  const objectKey = randomUUID();
  const target = await getObjectStorage().createUploadTarget(objectKey, cap);

  const redis = getRedisClient();
  await redis.set(
    pendingUploadKey(objectKey),
    JSON.stringify({ userId: ctx.userId, encryptedSizeBytes }),
    'EX',
    PENDING_UPLOAD_TTL_SECONDS,
  );

  return { objectKey, target };
}

/**
 * Called from messages/service.ts's `sendMessage` when the request carries an
 * `attachment` ref. One-time consumption of the pending-upload record — mirrors the
 * existing one-time-prekey `claimed_at` pattern (packages/database's
 * `one_time_pre_keys`): a Redis key that's already been consumed (or never existed,
 * or belongs to a different caller) means this objectKey cannot be linked to a
 * message, full stop. Runs inside the same transaction as the message insert so a
 * failure here rolls back the message too, not just the attachment.
 */
export async function claimPendingUpload(
  tx: Prisma.TransactionClient,
  callerUserId: string,
  messageId: string,
  attachment: MessageAttachmentRef,
): Promise<void> {
  const redis = getRedisClient();
  const key = pendingUploadKey(attachment.objectKey);
  const raw = await redis.get(key);
  if (!raw) {
    throw new AppError('VALIDATION_FAILED', 'This upload has expired or was never completed. Please attach the file again.');
  }
  const pending = JSON.parse(raw) as { userId: string; encryptedSizeBytes: number };
  if (pending.userId !== callerUserId) {
    throw new AppError('VALIDATION_FAILED', 'This upload does not belong to you.');
  }
  await redis.del(key);

  await tx.messageAttachment.create({
    data: {
      messageId,
      objectKey: attachment.objectKey,
      // Trust the value recorded at upload-url mint time (server-derived, not the
      // client-declared value on this second request) — the two should always match
      // in the honest-client case, but if a client sends a different number here it
      // doesn't matter, since this is what's actually persisted.
      encryptedSizeBytes: BigInt(pending.encryptedSizeBytes),
    },
  });
}

export async function createDownloadUrl(callerUserId: string, objectKey: string): Promise<string> {
  const attachment = await prisma.messageAttachment.findUnique({
    where: { objectKey },
    include: { message: true },
  });
  if (!attachment) {
    throw new AppError('NOT_FOUND', 'File not found.');
  }
  // Re-derived from the DB every call, never trusted from the URL alone — the exact
  // same membership-gate every other conversation-scoped resource in this codebase
  // uses (docs/03-api-design.md#authorization).
  await requireConversationMembership(callerUserId, attachment.message.conversationId);

  return getObjectStorage().createDownloadUrl(objectKey);
}
