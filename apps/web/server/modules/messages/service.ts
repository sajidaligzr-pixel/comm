import { prisma, Prisma } from '@comm/database';
import { AppError, type SendMessageRequest, type MessageDto, type StarredMessageDto } from '@comm/types';
import {
  requireConversationMembership,
  getGroupMemberPrimaryDevices,
  getAllOtherMembersActiveDeviceIds,
} from '../conversations/service';
import { claimPendingUpload } from '../media/service';

/**
 * Multi-device fan-out (docs/06-device-architecture.md's original target design,
 * shipped here after being tracked as a gap through Phase 3/4/5): a `direct`
 * message now reaches every active device of every conversation member — the other
 * participant's, AND the sender's own — not just whichever single device happened
 * to be "most recently active." `group` messages are unaffected (every member
 * already shared one Megolm-style session, which sidesteps this whole problem —
 * see `getGroupMemberPrimaryDevices`'s own doc comment, still tracking one device
 * per *member* rather than every device, a separate, smaller, still-open gap).
 *
 * The reason this needed a schema change rather than "just fan out more": a
 * pairwise Double Ratchet session's ciphertext is only valid for the one specific
 * device it was encrypted for, and `Message` only ever had room for one ciphertext.
 * `MessageRecipient` now carries its own `envelopeHeader`/`ciphertext`/`x3dhInit`
 * for exactly this case; `toDto` below falls back to `Message`-level columns for
 * `group` rows (still the single shared ciphertext) and for any `direct` message
 * sent before this shipped (never backfilled — those rows keep working exactly as
 * they always did). `sendMessage` returns one `MessageDto` per target device, same
 * shape as before this change — only the fan-out width changed, not `MessageDto`
 * itself.
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
  recipients: Array<{
    recipientDeviceId: string;
    deliveredAt: Date | null;
    readAt: Date | null;
    envelopeHeader: Buffer | null;
    ciphertext: Buffer | null;
    x3dhInit: unknown;
  }>;
},
  // Which specific device is asking — REQUIRED whenever `row.recipients` could
  // contain more than one device's row (i.e. `listMessages`, where multi-device
  // fan-out means a `direct` message now has a genuinely different, mutually
  // undecryptable ciphertext per recipient device). Without this, picking an
  // arbitrary `recipients[0]` risks handing back a DIFFERENT device's envelope —
  // decryptable by nobody who receives it, silently swallowed by the client as
  // "undecryptable on this device" and looking exactly like a dropped message.
  // Omitted only by `sendMessage`'s own re-fetch, which already queries exactly one
  // already-known-correct row (`include: { recipients: { where: { recipientDeviceId } } }`)
  // and by callers with no specific viewer device to disambiguate by (there are none
  // today — every caller of this function is device-scoped).
  viewerDeviceId?: string,
): MessageDto {
  const recipient = (viewerDeviceId && row.recipients.find((r) => r.recipientDeviceId === viewerDeviceId)) || row.recipients[0];
  if (!recipient) {
    throw new AppError('INTERNAL', 'Message is missing its envelope.');
  }
  // Per-recipient envelope wins when present (multi-device `direct` fan-out); every
  // other case (group, or a `direct` message sent before this existed) falls back
  // to `Message`-level columns, which is exactly where their one shared ciphertext
  // has always lived.
  const envelopeHeader = recipient.envelopeHeader ?? row.envelopeHeader;
  const ciphertext = recipient.ciphertext ?? row.ciphertext;
  const x3dhInit = recipient.envelopeHeader ? recipient.x3dhInit : row.x3dhInit;
  if (!envelopeHeader || !ciphertext) {
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
    envelope: { header: envelopeHeader.toString('base64'), ciphertext: ciphertext.toString('base64') },
    x3dhInit: x3dhInit as MessageDto['x3dhInit'],
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

  // Populated only for the `direct` branch below — each entry is one device's own
  // independently-encrypted envelope; empty for `group`, which still shares one
  // envelope at the `Message` level (input.envelope/input.x3dhInit), unchanged.
  let perDeviceEnvelopes: Array<{
    deviceId: string;
    header: Buffer;
    ciphertext: Buffer;
    x3dhInit: Prisma.InputJsonValue | undefined;
  }> = [];
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
    if (!input.envelope) {
      throw new AppError('VALIDATION_FAILED', 'A group message needs a shared envelope.');
    }
    const targets = await getGroupMemberPrimaryDevices(conversationId, ctx.userId);
    targetDeviceIds = targets.map((t) => t.deviceId);
  } else {
    if (!input.recipients || input.recipients.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'At least one recipient device is required.');
    }
    // The REAL target set, resolved server-side — never trust the client's own idea
    // of who should receive this. Every other member's active devices (the
    // multi-device-per-recipient half of this fix) plus the sender's own other
    // active devices (the self-fan-out half — a second phone, a desktop client, a
    // web tab left open elsewhere all need their own copy too).
    const otherMemberDevices = await getAllOtherMembersActiveDeviceIds(conversationId, ctx.userId);
    const ownOtherDevices = await prisma.device.findMany({
      where: { userId: ctx.userId, status: 'active', id: { not: ctx.deviceId } },
      select: { id: true },
    });
    const validTargetIds = new Set([...otherMemberDevices.map((d) => d.deviceId), ...ownOtherDevices.map((d) => d.id)]);

    // Silently drop any envelope the client supplied for a device outside the real
    // target set (IDOR guard, docs/35-authorization.md) — never throw for THAT case
    // specifically, since a device that just went inactive/was revoked in the race
    // window between the client resolving targets and sending shouldn't fail the
    // whole send for every other, still-valid target.
    const validRecipients = input.recipients.filter((r) => validTargetIds.has(r.deviceId));
    if (validRecipients.length === 0) {
      throw new AppError('MESSAGE_FAILED', 'No one in this conversation currently has an active device to receive messages.');
    }

    perDeviceEnvelopes = validRecipients.map((r) => ({
      deviceId: r.deviceId,
      header: Buffer.from(r.envelope.header, 'base64'),
      ciphertext: Buffer.from(r.envelope.ciphertext, 'base64'),
      x3dhInit: r.x3dhInit ?? undefined,
    }));
    targetDeviceIds = perDeviceEnvelopes.map((e) => e.deviceId);
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

  const envelopeByDevice = new Map(perDeviceEnvelopes.map((e) => [e.deviceId, e]));

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
          // `direct` sends carry no `Message`-level envelope anymore — each target
          // device's own ciphertext lives on its own `MessageRecipient` row instead
          // (below). `input.envelope` is only ever present for `group`.
          envelopeHeader: input.envelope ? Buffer.from(input.envelope.header, 'base64') : null,
          ciphertext: input.envelope ? Buffer.from(input.envelope.ciphertext, 'base64') : null,
          x3dhInit: input.envelope ? input.x3dhInit ?? undefined : undefined,
          contentTypeHint: input.contentTypeHint,
          replyToMessageId: input.replyToMessageId,
          sentAt: new Date(input.sentAt),
        },
      ],
      skipDuplicates: true,
    });

    await tx.messageRecipient.createMany({
      data: targetDeviceIds.map((recipientDeviceId) => {
        const own = envelopeByDevice.get(recipientDeviceId);
        return {
          messageId: input.messageId,
          recipientDeviceId,
          envelopeHeader: own?.header,
          ciphertext: own?.ciphertext,
          x3dhInit: own?.x3dhInit,
        };
      }),
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
  callerDeviceId: string,
  conversationId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: MessageDto[]; nextCursor: string | null }> {
  await requireConversationMembership(callerUserId, conversationId);

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      // "Messages visible to me" is: ones I sent, or ones where any of MY devices
      // is a targeted recipient — not filtered to just `callerDeviceId` here (a
      // message this account's OTHER device already caught up on should still show
      // in this device's history), which is exactly why `toDto` below needs
      // `callerDeviceId` explicitly: `recipients` can contain several of this
      // user's own devices' rows plus other members' devices' rows.
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
    items: page.map((row) => toDto(row, callerDeviceId)),
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
  // Prisma treats a bare `null` here as ambiguous. A `direct` message's actual
  // ciphertext may live on its `MessageRecipient` rows instead of `Message` itself
  // now (multi-device fan-out, this module's own docstring) — both need clearing in
  // the same transaction, or a "deleted" message could still have live ciphertext
  // sitting in a per-recipient row.
  await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull, deletionReason: 'manual' },
    }),
    prisma.messageRecipient.updateMany({
      where: { messageId },
      data: { ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull },
    }),
  ]);
  return { conversationId: message.conversationId };
}

/**
 * Starring (docs/13-roadmap.md's pinned/starred pass — see `StarredMessage`'s own
 * doc comment in schema.prisma for why this is a plain metadata table, not routed
 * through the E2E message pipeline the way reactions are). Membership-gated the
 * same way every other message action is: you can only star a message in a
 * conversation you're actually a member of — `requireConversationMembership`
 * throws FORBIDDEN for a non-member, and a nonexistent message is NOT_FOUND,
 * mirroring `deleteMessage`'s own lookup-then-authorize shape.
 */
async function requireMessageMembership(callerUserId: string, messageId: string): Promise<{ conversationId: string }> {
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (!message) throw new AppError('NOT_FOUND', 'Message not found.');
  await requireConversationMembership(callerUserId, message.conversationId);
  return { conversationId: message.conversationId };
}

export async function starMessage(callerUserId: string, messageId: string): Promise<void> {
  await requireMessageMembership(callerUserId, messageId);
  // Idempotent — starring an already-starred message (e.g. a retried request, or
  // two of the caller's own devices racing) is a no-op, not an error.
  await prisma.starredMessage.upsert({
    where: { userId_messageId: { userId: callerUserId, messageId } },
    create: { userId: callerUserId, messageId },
    update: {},
  });
}

export async function unstarMessage(callerUserId: string, messageId: string): Promise<void> {
  await prisma.starredMessage.deleteMany({ where: { userId: callerUserId, messageId } });
}

export async function listStarredMessages(callerUserId: string): Promise<StarredMessageDto[]> {
  const rows = await prisma.starredMessage.findMany({
    where: { userId: callerUserId },
    orderBy: { createdAt: 'desc' },
    include: { message: { select: { conversationId: true } } },
  });
  return rows.map((row) => ({
    messageId: row.messageId,
    conversationId: row.message.conversationId,
    starredAt: row.createdAt.toISOString(),
  }));
}
