import { Prisma, prisma } from '@comm/database';
import { AppError, type UserHistoryKeyResponse } from '@comm/types';
import { requireConversationMembership } from '../conversations/service';

/**
 * Multi-device message HISTORY sync (docs/07-auth-architecture.md's history-key
 * section) — the account-level History Key (HK) CRUD, plus writing individual
 * `MessageHistoryEntry` rows. See `UserHistoryKey`/`MessageHistoryEntry`'s own
 * schema doc comments for the full design; this module is intentionally thin —
 * every wire value here already arrives wrapped/encrypted, so there is no
 * plaintext or unwrapped key material anywhere in this file.
 */

export async function getUserHistoryKey(userId: string): Promise<UserHistoryKeyResponse | null> {
  const row = await prisma.userHistoryKey.findUnique({ where: { userId } });
  if (!row) return null;
  return { wrappedKey: row.wrappedKey.toString('base64'), salt: row.salt.toString('base64') };
}

/**
 * Create-if-absent, race-safe: if two of the account's own devices both discover
 * "no HK yet" at the same time and both try to create one, only the first insert
 * wins (unique `userId`) — the loser's `create` throws Prisma's unique-violation
 * (P2002), caught here and turned into a plain re-fetch of the row that actually
 * won. The CALLER is responsible for then re-deriving its wrapping key from
 * whichever `salt` comes back (packages/types/src/history.ts's own doc comment on
 * `CreateUserHistoryKeyRequest`) — this never trusts "I called create" to mean
 * "my values are the ones now stored."
 */
export async function createUserHistoryKeyIfAbsent(
  userId: string,
  wrappedKey: Buffer,
  salt: Buffer,
): Promise<UserHistoryKeyResponse> {
  try {
    const row = await prisma.userHistoryKey.create({ data: { userId, wrappedKey, salt } });
    return { wrappedKey: row.wrappedKey.toString('base64'), salt: row.salt.toString('base64') };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.userHistoryKey.findUniqueOrThrow({ where: { userId } });
      return { wrappedKey: existing.wrappedKey.toString('base64'), salt: existing.salt.toString('base64') };
    }
    throw err;
  }
}

/**
 * Written client-side the first time THIS account's own client sees a message's
 * plaintext by any means (original sender at send time, or any device the instant
 * it successfully decrypts an incoming message live) — see `MessageHistoryEntry`'s
 * own schema doc comment. Authorization mirrors every other message-scoped action
 * in this file's sibling module (messages/service.ts): the caller must currently
 * be a member of the message's conversation, re-derived from the DB every call
 * (docs/35-authorization.md) — this is what stops a random authenticated user
 * from writing (or probing the existence of) a history entry for a message they
 * were never part of. Idempotent upsert: a retried upload, or a race between two
 * of the caller's own devices resolving the same message at once, just overwrites
 * with an equivalent ciphertext (same plaintext, a fresh AEAD nonce each time)
 * rather than erroring.
 */
export async function writeMessageHistoryEntry(callerUserId: string, messageId: string, ciphertext: Buffer): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (!message) throw new AppError('NOT_FOUND', 'Message not found.');
  await requireConversationMembership(callerUserId, message.conversationId);

  await prisma.messageHistoryEntry.upsert({
    where: { messageId_userId: { messageId, userId: callerUserId } },
    create: { messageId, userId: callerUserId, ciphertext },
    update: { ciphertext },
  });
}
