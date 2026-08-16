import { prisma, Prisma } from '@comm/database';
import { AppError, type SendMessageRequest, type MessageDto } from '@comm/types';
import { requireConversationMembership, getGroupMemberPrimaryDevices } from '../conversations/service';
import { claimPendingUpload } from '../media/service';

/**
 * Phase 3 scope, stated once here rather than scattered across comments: a message
 * is encrypted for and delivered to exactly ONE device PER OTHER MEMBER
 * (`getPrimaryRecipientDevice`/`getGroupMemberPrimaryDevices`), not fanned out to
 * every device a member owns. Real multi-device fan-out (encrypting once per device
 * a member has, docs/06-device-architecture.md's general model) is a tracked
 * follow-up — see docs/04-websocket-realtime.md's revision note. This is a genuine,
 * documented scope limit, not an oversight: it means a member only receives new
 * messages on whichever single device was most recently active, until that
 * follow-up ships. `sendMessage` returns one `MessageDto` per target device (one
 * for a direct conversation, one per other group member for a group one) — see
 * docs/13-roadmap.md's group chat pass for why this generalized from a single DTO
 * without changing `MessageDto`'s own shape (each DTO is still "this copy, for this
 * one device").
 */

function toDto(row: {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  envelopeType: string;
  envelopeHeader: Buffer | null;
  ciphertext: Buffer | null;
  x3dhInit: unknown;
  contentTypeHint: string;
  replyToMessageId: string | null;
  sentAt: Date;
  serverReceivedAt: Date;
  recipients: Array<{ recipientDeviceId: string; deliveredAt: Date | null; readAt: Date | null }>;
}): MessageDto {
  const recipient = row.recipients[0];
  if (!row.envelopeHeader || !row.ciphertext || !recipient) {
    // Tombstoned (deleted/expired) messages are filtered out by callers before this
    // runs — reaching here with nulled fields would be a caller bug, not a normal
    // state, so this throws loudly rather than fabricating an empty envelope.
    throw new AppError('INTERNAL', 'Message is missing its envelope.');
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    senderDeviceId: row.senderDeviceId,
    recipientDeviceId: recipient.recipientDeviceId,
    envelopeType: row.envelopeType as MessageDto['envelopeType'],
    envelope: { header: row.envelopeHeader.toString('base64'), ciphertext: row.ciphertext.toString('base64') },
    x3dhInit: row.x3dhInit as MessageDto['x3dhInit'],
    contentTypeHint: row.contentTypeHint as MessageDto['contentTypeHint'],
    replyToMessageId: row.replyToMessageId,
    sentAt: row.sentAt.toISOString(),
    serverReceivedAt: row.serverReceivedAt.toISOString(),
    deliveredAt: recipient.deliveredAt?.toISOString() ?? null,
    readAt: recipient.readAt?.toISOString() ?? null,
  };
}

export async function sendMessage(
  ctx: { userId: string; deviceId: string },
  conversationId: string,
  input: SendMessageRequest,
): Promise<MessageDto[]> {
  await requireConversationMembership(ctx.userId, conversationId);

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

  let targetDeviceIds: string[];
  if (conversation.type === 'group') {
    // group is guaranteed non-null when type === 'group' — see toSummary's note in
    // conversations/service.ts.
    const group = await prisma.group.findUniqueOrThrow({ where: { id: conversation.groupId! } });
    if (group.onlyAdminsCanMessage) {
      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: ctx.userId } },
      });
      if (!membership || membership.removedAt || membership.role !== 'admin') {
        throw new AppError('FORBIDDEN', 'Only group admins can send messages in this group.');
      }
    }
    const targets = await getGroupMemberPrimaryDevices(conversationId, ctx.userId);
    targetDeviceIds = targets.map((t) => t.deviceId);
  } else {
    if (!input.recipientDeviceId) {
      throw new AppError('VALIDATION_FAILED', 'A recipient device is required.');
    }
    const recipientDevice = await prisma.device.findUnique({
      where: { id: input.recipientDeviceId },
      include: { user: true },
    });
    if (!recipientDevice || recipientDevice.status !== 'active') {
      throw new AppError('DEVICE_REVOKED', 'That device can no longer receive messages.');
    }
    // The recipient device's OWNER must actually be a member of this conversation —
    // stops a caller from targeting an arbitrary device id that has nothing to do
    // with this conversation (docs/35-authorization.md's IDOR guard).
    await requireConversationMembership(recipientDevice.userId, conversationId);
    targetDeviceIds = [input.recipientDeviceId];
  }

  // A message with nobody currently reachable to deliver it to is refused rather
  // than silently persisted with zero `MessageRecipient` rows — a device that comes
  // back online later would otherwise never learn this message exists at all (its
  // catch-up query, listMessages below, is driven entirely by recipient rows). A
  // real, honest simplification (docs/13-roadmap.md), not solved further here.
  if (targetDeviceIds.length === 0) {
    throw new AppError('MESSAGE_FAILED', 'No one in this conversation currently has an active device to receive messages.');
  }

  if (input.replyToMessageId) {
    const replyTarget = await prisma.message.findUnique({ where: { id: input.replyToMessageId } });
    if (!replyTarget || replyTarget.conversationId !== conversationId) {
      throw new AppError('VALIDATION_FAILED', 'Cannot reply to a message outside this conversation.');
    }
  }

  // Idempotent insert (docs/02-database-schema.md#message-ids): a retried send from
  // a flaky connection with the same client-generated id is a silent no-op, not a
  // duplicate or an error. Wrapped in a transaction together with the attachment
  // claim (when present) so a failed upload-claim rolls the message insert back too
  // — never a message row pointing at an attachment that doesn't exist.
  await prisma.$transaction(async (tx) => {
    await tx.message.createMany({
      data: [
        {
          id: input.messageId,
          conversationId,
          senderUserId: ctx.userId,
          senderDeviceId: ctx.deviceId,
          envelopeType: input.envelopeType,
          envelopeHeader: Buffer.from(input.envelope.header, 'base64'),
          ciphertext: Buffer.from(input.envelope.ciphertext, 'base64'),
          x3dhInit: input.x3dhInit ?? undefined,
          contentTypeHint: input.contentTypeHint,
          replyToMessageId: input.replyToMessageId,
          sentAt: new Date(input.sentAt),
        },
      ],
      skipDuplicates: true,
    });

    await tx.messageRecipient.createMany({
      data: targetDeviceIds.map((recipientDeviceId) => ({ messageId: input.messageId, recipientDeviceId })),
      skipDuplicates: true,
    });

    if (input.attachment) {
      // skipDuplicates above means a retried send hits this a second time too — the
      // attachment row is unique on messageId, so a retry after the first attempt
      // already succeeded would throw here on a plain create. Guard the same way the
      // message/recipient inserts do: only claim if this message doesn't already
      // have one.
      const existing = await tx.messageAttachment.findUnique({ where: { messageId: input.messageId } });
      if (!existing) {
        await claimPendingUpload(tx, ctx.userId, input.messageId, input.attachment);
      }
    }
  });

  const rows = await Promise.all(
    targetDeviceIds.map((recipientDeviceId) =>
      prisma.message.findUniqueOrThrow({
        where: { id: input.messageId },
        include: { recipients: { where: { recipientDeviceId } } },
      }),
    ),
  );

  return rows.map((row) => toDto(row));
}

export async function listMessages(
  callerUserId: string,
  conversationId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: MessageDto[]; nextCursor: string | null }> {
  await requireConversationMembership(callerUserId, conversationId);

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      // Phase 3's single-recipient-device model (see module header) means "messages
      // visible to me" is: ones I sent, or ones where I'm the targeted recipient —
      // not every device, just the caller's own devices.
      OR: [{ senderUserId: callerUserId }, { recipients: { some: { recipientDevice: { userId: callerUserId } } } }],
    },
    include: { recipients: true },
    orderBy: { serverReceivedAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((row) => toDto(row)),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

export async function acknowledgeDelivered(recipientDeviceId: string, messageId: string): Promise<void> {
  await prisma.messageRecipient.updateMany({
    where: { messageId, recipientDeviceId, deliveredAt: null },
    data: { deliveredAt: new Date() },
  });
}

/** Who to notify when a message's delivery/read state changes — the realtime layer
 * uses this rather than reaching into Prisma directly (docs/00-overview.md's
 * module-boundary rule). */
export async function getMessageSenderDeviceId(messageId: string): Promise<string | null> {
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { senderDeviceId: true } });
  return message?.senderDeviceId ?? null;
}

/**
 * Respects the READER's own `read_receipts` privacy setting (docs/28-privacy-settings.md
 * in the master prompt / docs/02-database-schema.md's `user_privacy_settings`): if
 * they've turned receipts off, `readAt` is simply never written — not written then
 * hidden from the sender, genuinely absent, so there's nothing to leak even from a
 * database-level view.
 */
/** Returns whether read receipts were actually recorded — the WS handler uses this
 * to decide whether to notify the other participant at all; if receipts are off,
 * there is nothing to tell them (docs/28-privacy-settings in the master prompt). */
export async function markConversationRead(callerUserId: string, conversationId: string, upToMessageId: string): Promise<boolean> {
  await requireConversationMembership(callerUserId, conversationId);

  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: callerUserId } },
    data: { lastReadMessageId: upToMessageId },
  });

  const privacy = await prisma.userPrivacySetting.findUnique({ where: { userId: callerUserId } });
  if (privacy && privacy.readReceipts === false) {
    return false;
  }

  const upToMessage = await prisma.message.findUnique({ where: { id: upToMessageId } });
  if (!upToMessage) return false;

  const myDeviceIds = (await prisma.device.findMany({ where: { userId: callerUserId, status: 'active' }, select: { id: true } })).map(
    (d) => d.id,
  );

  await prisma.messageRecipient.updateMany({
    where: {
      recipientDeviceId: { in: myDeviceIds },
      readAt: null,
      message: { conversationId, serverReceivedAt: { lte: upToMessage.serverReceivedAt } },
    },
    data: { readAt: new Date() },
  });
  return true;
}

export async function deleteMessage(callerUserId: string, messageId: string): Promise<{ conversationId: string }> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.senderUserId !== callerUserId) {
    throw new AppError('NOT_FOUND', 'Message not found.');
  }
  // Tombstone: ciphertext genuinely nulled out, not just flagged
  // (docs/02-database-schema.md's "On deletion" note) — a later DB compromise can't
  // retroactively decrypt "deleted" content. `Prisma.JsonNull` (not plain `null`)
  // is required to actually clear a JSON column rather than leave it untouched —
  // Prisma treats a bare `null` here as ambiguous.
  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull, deletionReason: 'manual' },
  });
  return { conversationId: message.conversationId };
}
