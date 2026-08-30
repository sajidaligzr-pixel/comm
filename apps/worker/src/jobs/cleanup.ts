import { prisma, Prisma } from '@comm/database';
import { getRedisClient } from '@comm/security';
import { getObjectStorage } from '@comm/storage';
import {
  MESSAGE_EVENTS_CHANNEL,
  disappearingTimerToMs,
  MEDIA_RETENTION_MS,
  type MessageEvent,
  type DisappearingTimer,
} from '@comm/types';

/**
 * Deletes data that has passed its documented retention point — see
 * docs/10-privacy-data-retention.md. "Storage is cheap" is explicitly rejected there
 * as a reason to keep this around, so this job runs on a schedule rather than never.
 */
/**
 * Runs one cleanup category, swallowing (and logging) whatever it throws rather than
 * letting it propagate — a real bug found live-auditing this job: none of the five
 * categories below were isolated from each other or, within each sweep, from a
 * single bad row. Deleting an already-manually-removed object-storage file, one
 * Prisma row a foreign key quirk makes momentarily inconsistent, one Redis publish
 * hiccup — any single failure anywhere used to abort that entire sweep function,
 * which (since `runCleanup` awaited all of them in sequence, unguarded) meant every
 * *later* category that hour silently never ran either. `tick()` in index.ts's own
 * try/catch stopped that from crashing the whole worker process, but "the process
 * survives" isn't the same guarantee as "cleanup actually happens" — and the same
 * bad row would keep blocking the same categories every single hour after, forever,
 * not just once. That's a direct hole in the flood-protection story media retention
 * exists for (docs/10-privacy-data-retention.md): the one thing standing between a
 * self-hosted disk and slowly filling up is this job actually running to completion,
 * hour after hour, regardless of what any one row looks like.
 */
async function runCategory(label: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[cleanup] ${label} sweep failed — other categories still ran; will retry next hour`, err);
    return 0;
  }
}

export async function runCleanup(): Promise<void> {
  const now = new Date();

  // Never-redeemed invites past expiry — see docs/02-database-schema.md's invites
  // table and docs/07-auth-architecture.md's short-lived-token rationale.
  const expiredInvites = await runCategory('expired-invites', async () => {
    const result = await prisma.invite.deleteMany({ where: { redeemedAt: null, expiresAt: { lt: now } } });
    return result.count;
  });

  // Sessions past their own expiry that were never explicitly revoked (the client
  // simply never came back to refresh) — same retention logic as an explicit revoke,
  // just triggered by time instead of an action.
  const expiredSessions = await runCategory('expired-sessions', async () => {
    const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  });

  const expiredMessages = await runCategory('disappearing-messages', () => sweepDisappearingMessages(now));
  const expiredMedia = await runCategory('expired-media', () => sweepExpiredMedia(now));
  const orphanedObjects = await runCategory('orphaned-media-objects', () => sweepOrphanedMediaObjects(now));

  // Unredeemed iOS push-delivery tokens (realtime/push-dispatch.ts's
  // `createPushDeliveryToken`, MessagePushDeliveryToken's own schema doc comment) —
  // the push was never actually delivered (device offline, app uninstalled,
  // notifications disabled) or the extension's own ~30s budget ran out before it
  // got to redeem it. Same short-lived-token retention shape as invites above,
  // just minutes instead of days.
  const expiredPushDeliveryTokens = await runCategory('expired-push-delivery-tokens', async () => {
    const result = await prisma.messagePushDeliveryToken.deleteMany({ where: { expiresAt: { lt: now } } });
    return result.count;
  });

  console.log(
    `[cleanup] removed ${expiredInvites} expired invite(s), ${expiredSessions} expired session(s), ${expiredMessages} disappeared message(s), ${expiredMedia} expired media message(s), ${orphanedObjects} orphaned media object(s), ${expiredPushDeliveryTokens} expired push-delivery token(s)`,
  );
}

/**
 * Deletes object-storage bytes with no matching `message_attachments` row — the
 * cleanup half of docs/13-roadmap.md's media pass. An orphan happens when a client
 * uploads ciphertext (`POST /api/media/upload-url` + the actual PUT/POST) but never
 * successfully sends the message that would link it (network drop, user closed the
 * tab mid-send, the app crashed) — the Redis `media:pending:<objectKey>` record
 * (apps/web/server/modules/media/service.ts) already expires on its own after 10
 * minutes, but the uploaded bytes themselves don't; this is what actually reclaims
 * them. `getObjectStorage()` is `@comm/storage` (not apps/web's own module) for the
 * same reason `createRedisSubscriber` lives in `@comm/security` — this app and
 * apps/web need the identical implementation, not two that can drift.
 */
async function sweepOrphanedMediaObjects(now: Date): Promise<number> {
  // Past the 10-minute pending-upload TTL with real margin, so this never races a
  // legitimate in-flight send — this job runs hourly (see apps/worker/src/index.ts),
  // not the thing a user is ever waiting on. Deliberately NOT a generous 24h window
  // (an earlier version of this comment described one) — self-hosted disk is finite
  // (docs/10-privacy-data-retention.md's media retention pass), and an account that
  // repeatedly uploads without ever sending is indistinguishable from someone trying
  // to fill the disk one abandoned upload at a time. An hour is still generous
  // relative to the 10-minute TTL a genuine client would complete well within.
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const candidateKeys = await getObjectStorage().listObjectKeysOlderThan(cutoff);
  if (candidateKeys.length === 0) return 0;

  const linked = await prisma.messageAttachment.findMany({
    where: { objectKey: { in: candidateKeys } },
    select: { objectKey: true },
  });
  const linkedKeys = new Set(linked.map((a) => a.objectKey));
  const orphaned = candidateKeys.filter((k) => !linkedKeys.has(k));

  for (const key of orphaned) {
    await getObjectStorage().deleteObject(key);
  }
  return orphaned.length;
}

/**
 * Enforces `conversations.disappearing_timer` (docs/02-database-schema.md) — the
 * setting itself is just a stored preference (server/modules/conversations/service.ts's
 * `updateDisappearingTimer`); this is what actually makes it true. Same tombstone
 * shape as a manual delete (server/modules/messages/service.ts's `deleteMessage`):
 * ciphertext genuinely nulled, not just flagged, so a later DB compromise can't
 * retroactively decrypt an expired message either. Publishes the same `deleted`
 * realtime event a manual delete does, to every active device in the conversation
 * (not "the other member" — unlike the API route, this isn't scoped to one caller),
 * so local decrypted caches (lib/crypto/message-cache.ts) scrub it too, not just the
 * server's row.
 */
async function sweepDisappearingMessages(now: Date): Promise<number> {
  const conversations = await prisma.conversation.findMany({
    where: { disappearingTimer: { not: 'off' } },
    select: { id: true, disappearingTimer: true },
  });
  if (conversations.length === 0) return 0;

  const redis = getRedisClient();
  let total = 0;

  for (const conversation of conversations) {
    const ttlMs = disappearingTimerToMs(conversation.disappearingTimer as DisappearingTimer);
    if (!ttlMs) continue;

    const expired = await prisma.message.findMany({
      where: { conversationId: conversation.id, deletedAt: null, sentAt: { lt: new Date(now.getTime() - ttlMs) } },
      select: { id: true },
    });
    if (expired.length === 0) continue;

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: conversation.id },
      select: { userId: true },
    });
    const devices = await prisma.device.findMany({
      where: { userId: { in: members.map((m) => m.userId) }, status: 'active' },
      select: { id: true },
    });

    for (const message of expired) {
      // All three in one transaction — see server/modules/messages/service.ts's
      // tombstoneMessages for why the per-recipient row AND every participant's
      // MessageHistoryEntry both need clearing too: a direct message's actual
      // ciphertext may live on MessageRecipient instead of Message itself
      // (multi-device fan-out), and leaving MessageHistoryEntry untouched would let
      // a "deleted" message's content stay fully recoverable via history sync on a
      // newly-added device.
      await prisma.$transaction([
        prisma.message.update({
          where: { id: message.id },
          data: { deletedAt: now, ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull, deletionReason: 'disappearing_timer' },
        }),
        prisma.messageRecipient.updateMany({
          where: { messageId: message.id },
          data: { ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull },
        }),
        prisma.messageHistoryEntry.deleteMany({ where: { messageId: message.id } }),
      ]);
      for (const device of devices) {
        const event: MessageEvent = {
          type: 'deleted',
          targetDeviceId: device.id,
          conversationId: conversation.id,
          messageId: message.id,
          reason: 'disappearing_timer',
        };
        await redis.publish(MESSAGE_EVENTS_CHANNEL, JSON.stringify(event));
      }
      total += 1;
    }
  }

  return total;
}

/**
 * A separate, always-on default from the disappearing-timer sweep above — not a
 * privacy feature a conversation opts into, a storage-bounding one that applies
 * regardless of that setting: images, voice notes, and file attachments have their
 * content erased 24h after being sent, full stop (docs/10-privacy-data-retention.md's
 * media retention pass). Text messages are untouched — they cost negligible storage
 * next to a photo or file, and there's no comparable reason to erase them by default.
 *
 * Deliberately not configurable per conversation this pass, unlike
 * `DisappearingTimer` — see docs/13-roadmap.md for why a per-conversation override is
 * a tracked follow-up rather than built now (it would need its own opt-out UI and a
 * decision about what "off" even means for a default that exists to bound server
 * storage, not user privacy).
 *
 * A message already tombstoned by the disappearing-timer sweep or a manual delete is
 * naturally excluded (`deletedAt: null` below) — the two sweeps never fight over the
 * same row, whichever gets there first wins and the other's query just won't match it
 * on its next run.
 */
async function sweepExpiredMedia(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MEDIA_RETENTION_MS);
  const expired = await prisma.message.findMany({
    where: {
      // `view_once` included: an unopened view-once photo still needs the same
      // storage-bounding fallback everything else here gets — the point of this
      // sweep is never letting media sit forever regardless of whether anyone's
      // looked at it (docs/13-roadmap.md). A message the viewer DID open is
      // already gone by then (deleteMessage's `viewed` tombstone, service.ts),
      // so this only ever catches the "never opened" case.
      contentTypeHint: { in: ['image', 'voice', 'media', 'view_once'] },
      deletedAt: null,
      sentAt: { lt: cutoff },
    },
    select: { id: true, conversationId: true, contentTypeHint: true, attachment: { select: { objectKey: true } } },
  });
  if (expired.length === 0) return 0;

  // Group by conversation so each conversation's active-device list is resolved once,
  // not once per expired message in it — same shape as sweepDisappearingMessages above.
  const conversationIds = Array.from(new Set(expired.map((m) => m.conversationId)));
  const members = await prisma.conversationMember.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { conversationId: true, userId: true },
  });
  const userIdsByConversation = new Map<string, string[]>();
  for (const m of members) {
    const list = userIdsByConversation.get(m.conversationId) ?? [];
    list.push(m.userId);
    userIdsByConversation.set(m.conversationId, list);
  }
  const allUserIds = Array.from(new Set(members.map((m) => m.userId)));
  const devices = await prisma.device.findMany({
    where: { userId: { in: allUserIds }, status: 'active' },
    select: { id: true, userId: true },
  });
  const deviceIdsByUser = new Map<string, string[]>();
  for (const d of devices) {
    const list = deviceIdsByUser.get(d.userId) ?? [];
    list.push(d.id);
    deviceIdsByUser.set(d.userId, list);
  }

  const redis = getRedisClient();
  const storage = getObjectStorage();

  for (const message of expired) {
    // A file attachment's actual bytes live in object storage, not the ciphertext
    // column — tombstoning the message row alone wouldn't reclaim that space, so the
    // underlying blob is deleted first. Images/voice notes need no equivalent step:
    // their bytes ARE the ciphertext column, reclaimed by the tombstone update below.
    if (message.contentTypeHint === 'media' && message.attachment) {
      await storage.deleteObject(message.attachment.objectKey);
    }

    // Same "all three need clearing together" reasoning as sweepDisappearingMessages above.
    await prisma.$transaction([
      prisma.message.update({
        where: { id: message.id },
        data: { deletedAt: now, ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull, deletionReason: 'media_retention' },
      }),
      prisma.messageRecipient.updateMany({
        where: { messageId: message.id },
        data: { ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull },
      }),
      prisma.messageHistoryEntry.deleteMany({ where: { messageId: message.id } }),
    ]);

    const userIds = userIdsByConversation.get(message.conversationId) ?? [];
    for (const userId of userIds) {
      for (const deviceId of deviceIdsByUser.get(userId) ?? []) {
        const event: MessageEvent = {
          type: 'deleted',
          targetDeviceId: deviceId,
          conversationId: message.conversationId,
          messageId: message.id,
          reason: 'media_retention',
        };
        await redis.publish(MESSAGE_EVENTS_CHANNEL, JSON.stringify(event));
      }
    }
  }

  return expired.length;
}
