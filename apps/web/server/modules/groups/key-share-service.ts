import { prisma } from '@comm/database';
import { AppError, type SendGroupKeyShareRequest, type GroupKeyShareDto } from '@comm/types';
import { requireConversationMembership } from '../conversations/service';

/**
 * The durable device-to-device outbox for group session key material — see
 * `packages/database/prisma/schema.prisma`'s `GroupKeyShare` model docstring and
 * docs/13-roadmap.md's design note for why this exists as its own table rather than
 * a WS-only event or an entry in `messages`. The server never decrypts anything
 * here; every check below is membership/ownership, never content.
 */

function toDto(row: {
  id: string;
  groupId: string;
  epoch: number;
  fromDeviceId: string;
  fromDevice: { userId: string };
  envelopeHeader: Buffer;
  ciphertext: Buffer;
  x3dhInit: unknown;
  createdAt: Date;
}): GroupKeyShareDto {
  return {
    id: row.id,
    groupId: row.groupId,
    epoch: row.epoch,
    fromDeviceId: row.fromDeviceId,
    fromUserId: row.fromDevice.userId,
    envelope: { header: row.envelopeHeader.toString('base64'), ciphertext: row.ciphertext.toString('base64') },
    x3dhInit: row.x3dhInit as GroupKeyShareDto['x3dhInit'],
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates one outbox row — called once per (sender device, target member device)
 * pair, mirroring how a group session is actually redistributed (docs/05-crypto-architecture.md#group-encryption:
 * one 1:1-encrypted share per recipient device, never a single multicast blob).
 * Returns the target device id so the WS handler (server/realtime/message-handlers.ts)
 * knows who to ping.
 */
export async function createGroupKeyShare(
  callerUserId: string,
  callerDeviceId: string,
  input: SendGroupKeyShareRequest,
): Promise<{ dto: GroupKeyShareDto; targetDeviceId: string }> {
  const group = await prisma.group.findUnique({ where: { id: input.groupId }, include: { conversation: true } });
  if (!group) throw new AppError('NOT_FOUND', 'Group not found.');
  // Caller must currently be a member — re-derived from the DB, never trusted from
  // the request alone (docs/35-authorization.md).
  await requireConversationMembership(callerUserId, group.conversation!.id);

  const targetDevice = await prisma.device.findUnique({ where: { id: input.toDeviceId } });
  if (!targetDevice || targetDevice.status !== 'active') {
    throw new AppError('DEVICE_REVOKED', 'That device can no longer receive group keys.');
  }
  // The target device's OWNER must also be a current member — same IDOR guard
  // sendMessage applies to a claimed recipientDeviceId.
  await requireConversationMembership(targetDevice.userId, group.conversation!.id);

  const row = await prisma.groupKeyShare.create({
    data: {
      groupId: input.groupId,
      epoch: input.epoch,
      fromDeviceId: callerDeviceId,
      toDeviceId: input.toDeviceId,
      envelopeHeader: Buffer.from(input.envelope.header, 'base64'),
      ciphertext: Buffer.from(input.envelope.ciphertext, 'base64'),
      x3dhInit: input.x3dhInit ?? undefined,
    },
    include: { fromDevice: { select: { userId: true } } },
  });

  return { dto: toDto(row), targetDeviceId: input.toDeviceId };
}

/**
 * REST catch-up (`GET /groups/:id/key-shares`) — everything still pending for the
 * CALLER's OWN device (never another device, even the caller's own other ones: same
 * Phase-3 single-device-per-recipient scope this whole system already carries).
 * Consumed on fetch: a REST response is either fully delivered or the request
 * failed outright (no partial-delivery ambiguity the way a dropped WS frame has), so
 * "fetched" and "consumed" are the same moment here — one code path serves both the
 * live-ping-triggered fetch and a cold reconnect's catch-up.
 */
export async function listAndConsumePendingKeyShares(groupId: string, callerUserId: string, callerDeviceId: string): Promise<GroupKeyShareDto[]> {
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: { conversation: true } });
  if (!group) throw new AppError('NOT_FOUND', 'Group not found.');
  await requireConversationMembership(callerUserId, group.conversation!.id);

  const rows = await prisma.groupKeyShare.findMany({
    where: { groupId, toDeviceId: callerDeviceId, consumedAt: null },
    include: { fromDevice: { select: { userId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];

  await prisma.groupKeyShare.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { consumedAt: new Date() },
  });

  return rows.map(toDto);
}
