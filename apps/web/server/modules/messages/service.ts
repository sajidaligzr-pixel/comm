import { prisma, Prisma, type MessageDeletionReason } from '@comm/database';
import { hashToken } from '@comm/security';
import { AppError, type SendMessageRequest, type MessageDto, type StarredMessageDto, type MessageReceiptDto } from '@comm/types';
import { requireConversationMembership, getAllOtherMembersActiveDeviceIds } from '../conversations/service';
import { claimPendingUpload } from '../media/service';
import { isEitherBlocked } from '../blocking/service';

/**
 * Multi-device fan-out (docs/06-device-architecture.md's original target design,
 * shipped here after being tracked as a gap through Phase 3/4/5): a message now
 * reaches every active device of every conversation member — the other
 * participant's/members', AND the sender's own — not just whichever single device
 * happened to be "most recently active." `direct` and `group` conversations both
 * go through `getAllOtherMembersActiveDeviceIds` now (this module's own group
 * branch used to call a now-removed `getGroupMemberPrimaryDevices`, one device per
 * *member* — every member's OTHER devices simply never got a copy at all). `group`
 * messages still share one Megolm-style envelope at the `Message` level regardless
 * of how many devices it fans out to — sidesteps the per-device-ciphertext problem
 * `direct` needed a schema change for, since the exact same ciphertext is valid for
 * every device of every member already.
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
  // Pre-filtered to the CALLER's own userId by the query itself (`where: { userId:
  // callerUserId }`) — never filtered here, so this is always either empty or
  // exactly one row (MessageHistoryEntry's composite PK). Absent entirely on
  // sendMessage's own re-fetch, which has no history entry to show yet anyway (see
  // this field's own handling below).
  historyEntries?: Array<{ ciphertext: Buffer }>;
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
    history: row.historyEntries?.[0] ? { ciphertext: row.historyEntries[0].ciphertext.toString('base64') } : null,
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
    // Every other member's every active device, PLUS the sender's own other active
    // devices (a second phone, a desktop client, a web tab left open elsewhere) —
    // the same two-part resolution `direct` uses below, now shared rather than
    // group messages only ever reaching one device per member and never the
    // sender's own other devices at all.
    const otherMemberDevices = await getAllOtherMembersActiveDeviceIds(conversationId, ctx.userId);
    const ownOtherDevices = await prisma.device.findMany({
      where: { userId: ctx.userId, status: 'active', id: { not: ctx.deviceId } },
      select: { id: true },
    });
    targetDeviceIds = [...otherMemberDevices.map((d) => d.deviceId), ...ownOtherDevices.map((d) => d.id)];
  } else {
    if (!input.recipients || input.recipients.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'At least one recipient device is required.');
    }

    // Blocked users (docs/13-roadmap.md) — checked in either direction, same
    // generic failure a legitimate "nobody reachable" case gets (MESSAGE_FAILED,
    // not a distinct code), so this can't be used to probe which direction a
    // block runs. Direct conversations only — see blocking/service.ts's own
    // note on why group messages aren't gated this way.
    const otherMember = await prisma.conversationMember.findFirst({
      where: { conversationId, userId: { not: ctx.userId } },
      select: { userId: true },
    });
    if (otherMember && (await isEitherBlocked(ctx.userId, otherMember.userId))) {
      throw new AppError('MESSAGE_FAILED', 'This message could not be delivered.');
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
    // historyEntries here is ALWAYS pre-filtered to the caller's own userId —
    // never the raw relation — so toDto never has to (and never could safely)
    // pick the right one out of potentially many other members' entries too.
    include: { recipients: true, historyEntries: { where: { userId: callerUserId } } },
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

/**
 * Redeems the one-time token apps/worker's `createPushDeliveryToken`
 * (push-dispatch.ts) embeds in an iOS message push — see `MessagePushDeliveryToken`'s
 * own schema doc comment for the full why. Deletes the token row the instant it's
 * found (race-safe via the `deleteMany` count check, same shape `redeemInvite`
 * already uses for its own one-time token) BEFORE returning anything, so a
 * retried/duplicated extension invocation — or a race with `jobs/cleanup.ts`'s
 * expiry sweep — can't double-fire. Returns the device whose token this was so the
 * caller (the route) can ack delivery and publish the live update, or `null` on
 * anything short of a valid, unexpired, not-already-redeemed token for this exact
 * message — same "never distinguish invalid from expired" reasoning
 * `getInviteInfo` already documents; this route has no user-facing error surface
 * to leak that distinction through anyway.
 */
export async function redeemPushDeliveryToken(messageId: string, rawToken: string): Promise<string | null> {
  const tokenHash = hashToken(rawToken);
  const row = await prisma.messagePushDeliveryToken.findUnique({ where: { tokenHash } });
  if (!row || row.messageId !== messageId || row.expiresAt.getTime() < Date.now()) return null;

  const deleted = await prisma.messagePushDeliveryToken.deleteMany({ where: { id: row.id } });
  if (deleted.count === 0) return null; // lost the race — some other call already redeemed/swept this row

  return row.deviceId;
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

/** Prisma's transaction client type, same alias devices/service.ts already uses —
 * lets this run either inside an outer transaction (adminDeleteUser, apps/worker's
 * sweeps) or standalone. */
export type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The one place a message is ever actually tombstoned — every call site in this
 * file, apps/worker's disappearing-timer/media-retention sweeps, and
 * adminDeleteUser all fold into this. Clears ciphertext everywhere it could still
 * live: `Message` itself, every per-device `MessageRecipient` row (multi-device
 * fan-out may put a `direct` message's real ciphertext there instead), AND every
 * account's own `MessageHistoryEntry` copy (multi-device history sync) — this last
 * one closes a real gap the original tombstone transaction had: nulling
 * Message/MessageRecipient alone left a "deleted" message's plaintext-equivalent
 * still fully recoverable by any participant's History Key on a newly-added
 * device. Bulk (`messageIds`, not one at a time) so a caller tombstoning many
 * messages at once (adminDeleteUser) does it as one statement per table, not N.
 */
export async function tombstoneMessages(db: Db, messageIds: string[], deletionReason: MessageDeletionReason): Promise<void> {
  if (messageIds.length === 0) return;
  await db.message.updateMany({
    where: { id: { in: messageIds } },
    data: { deletedAt: new Date(), ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull, deletionReason },
  });
  await db.messageRecipient.updateMany({
    where: { messageId: { in: messageIds } },
    data: { ciphertext: null, envelopeHeader: null, x3dhInit: Prisma.JsonNull },
  });
  await db.messageHistoryEntry.deleteMany({ where: { messageId: { in: messageIds } } });
}

/**
 * Two distinct authorized callers, not one: the SENDER deleting their own
 * message (the original, only case this ever handled — reason `manual`), or —
 * new, docs/13-roadmap.md's view-once pass — a genuine RECIPIENT tombstoning a
 * `view_once` message the instant they open it (reason `viewed`, so the client
 * shows "Opened" rather than a generic "deleted" placeholder). Both end up
 * calling `tombstoneMessages` above; only who's allowed to trigger it, and why,
 * differs. A recipient can only ever self-tombstone a `view_once` message
 * specifically — this is NOT a general "any member can delete any message"
 * hole, and idempotent by construction (safe to run twice: a race between the
 * viewer's own multiple devices both opening it just re-nulls already-null
 * columns).
 */
export async function deleteMessage(
  callerUserId: string,
  messageId: string,
): Promise<{ conversationId: string; deletionReason: 'manual' | 'viewed' }> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('NOT_FOUND', 'Message not found.');

  let deletionReason: 'manual' | 'viewed';
  if (message.senderUserId === callerUserId) {
    deletionReason = 'manual';
  } else if (message.contentTypeHint === 'view_once') {
    // Throws FORBIDDEN for a non-member, which we deliberately let escape as
    // NOT_FOUND below (same "don't leak whether a message id exists" posture
    // every other message-scoped authorization check in this file already takes).
    await requireConversationMembership(callerUserId, message.conversationId).catch(() => {
      throw new AppError('NOT_FOUND', 'Message not found.');
    });
    deletionReason = 'viewed';
  } else {
    throw new AppError('NOT_FOUND', 'Message not found.');
  }

  await tombstoneMessages(prisma, [messageId], deletionReason);
  return { conversationId: message.conversationId, deletionReason };
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

/**
 * "Seen by" (docs/13-roadmap.md) — group messages only, see `MessageReceiptDto`'s
 * own docstring for why: a 1:1 conversation already shows this as a single tick
 * (sent), double tick (delivered), or blue double tick (read), never a
 * per-person breakdown. Data was already being recorded for every group member
 * (`sendMessage`'s `MessageRecipient` rows, now one per member's every active
 * device rather than a single primary one) — `byUser` below already collapsed
 * multiple device rows per member down to their best state before this fanned
 * out to every device, so this read path needed no changes at all.
 */
export async function getMessageReceipts(callerUserId: string, messageId: string): Promise<MessageReceiptDto[]> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });
  if (!message) throw new AppError('NOT_FOUND', 'Message not found.');
  await requireConversationMembership(callerUserId, message.conversationId);
  if (message.conversation.type !== 'group') {
    throw new AppError('VALIDATION_FAILED', '"Seen by" is only available for group messages.');
  }

  const recipients = await prisma.messageRecipient.findMany({
    where: { messageId },
    include: { recipientDevice: { include: { user: true } } },
  });

  // Collapse to one entry per USER, not per device — a member with several active
  // devices (sendMessage's group branch now fans out to every one of them, not just
  // one primary device) takes the best state across whichever rows exist: read
  // beats delivered beats neither, and the later timestamp wins when more than one
  // row has the same state.
  const byUser = new Map<string, { userId: string; username: string; displayName: string; deliveredAt: Date | null; readAt: Date | null }>();
  for (const r of recipients) {
    const u = r.recipientDevice.user;
    const existing = byUser.get(u.id);
    byUser.set(u.id, {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      deliveredAt: laterOf(existing?.deliveredAt ?? null, r.deliveredAt),
      readAt: laterOf(existing?.readAt ?? null, r.readAt),
    });
  }
  return [...byUser.values()].map((v) => ({
    ...v,
    deliveredAt: v.deliveredAt?.toISOString() ?? null,
    readAt: v.readAt?.toISOString() ?? null,
  }));
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
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
