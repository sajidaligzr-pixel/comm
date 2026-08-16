import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { createUploadUrl } from '../../modules/media/service';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, deleteTestUser, fakeDeviceRegistration } from '../helpers';

/**
 * Regression coverage for the flood-protection pass (docs/10-privacy-data-retention.md
 * / docs/13-roadmap.md's media retention section) — found and closed a real,
 * previously-flagged gap: a per-file size cap alone doesn't stop one account from
 * sending enough separate files, back to back, to fill a self-hosted server's disk.
 * `MEDIA_ACCOUNT_QUOTA_BYTES` (default 500 MiB, overridden here via env for a fast
 * test) is the per-account running-total cap this suite exercises directly against
 * `createUploadUrl`, without going through a real upload (only the accounting logic
 * is under test here — the object-storage adapters have their own coverage).
 */
describe('media account quota', () => {
  const originalQuota = process.env.MEDIA_ACCOUNT_QUOTA_BYTES;
  process.env.MEDIA_ACCOUNT_QUOTA_BYTES = String(10 * 1024 * 1024); // 10 MiB, fast to hit in a test

  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  afterAll(async () => {
    if (originalQuota === undefined) delete process.env.MEDIA_ACCOUNT_QUOTA_BYTES;
    else process.env.MEDIA_ACCOUNT_QUOTA_BYTES = originalQuota;
    await Promise.all(createdConversationIds.map((id) => prisma.conversation.delete({ where: { id } }).catch(() => undefined)));
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  /** Fabricates a `Message` + `MessageAttachment` pair directly (bypassing the real
   * send pipeline, which isn't what's under test here) so the account already has
   * `sizeBytes` of "live" attachment usage before `createUploadUrl` is called. */
  async function seedLiveAttachment(userId: string, deviceId: string, conversationId: string, sizeBytes: number): Promise<void> {
    const message = await prisma.message.create({
      data: {
        id: crypto.randomUUID(),
        conversationId,
        senderUserId: userId,
        senderDeviceId: deviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        envelopeHeader: Buffer.from('h'),
        ciphertext: Buffer.from('c'),
        contentTypeHint: 'media',
        sentAt: new Date(),
      },
    });
    await prisma.messageAttachment.create({
      data: { messageId: message.id, objectKey: crypto.randomUUID(), encryptedSizeBytes: BigInt(sizeBytes) },
    });
  }

  async function setup() {
    const user = await createActiveUser();
    createdUserIds.push(user.userId);
    const { deviceId } = await registerDevice(prisma, user.userId, fakeDeviceRegistration());
    const other = await createActiveUser();
    createdUserIds.push(other.userId);
    const conversation = await prisma.conversation.create({
      data: { type: 'direct', members: { create: [{ userId: user.userId }, { userId: other.userId }] } },
    });
    createdConversationIds.push(conversation.id);
    return { userId: user.userId, deviceId, conversationId: conversation.id };
  }

  it('allows an upload comfortably under quota', async () => {
    const { userId } = await setup();
    const result = await createUploadUrl({ userId }, 1024 * 1024); // 1 MiB, quota is 10 MiB
    expect(result.objectKey).toBeTruthy();
  });

  it('rejects an upload that would push the account over its quota', async () => {
    const { userId, deviceId, conversationId } = await setup();
    // Already has 9 MiB of live attachments; quota is 10 MiB.
    await seedLiveAttachment(userId, deviceId, conversationId, 9 * 1024 * 1024);

    // A further 512 KiB fits.
    await expect(createUploadUrl({ userId }, 512 * 1024)).resolves.toMatchObject({ objectKey: expect.any(String) });

    // A further 2 MiB does not (9 + 2 > 10).
    await expect(createUploadUrl({ userId }, 2 * 1024 * 1024)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('excludes deleted/expired attachments from the running total — quota frees up as media expires', async () => {
    const { userId, deviceId, conversationId } = await setup();
    const message = await prisma.message.create({
      data: {
        id: crypto.randomUUID(),
        conversationId,
        senderUserId: userId,
        senderDeviceId: deviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        envelopeHeader: Buffer.from('h'),
        ciphertext: Buffer.from('c'),
        contentTypeHint: 'media',
        sentAt: new Date(),
      },
    });
    await prisma.messageAttachment.create({
      data: { messageId: message.id, objectKey: crypto.randomUUID(), encryptedSizeBytes: BigInt(9 * 1024 * 1024) },
    });
    // Simulate the media-retention sweep having already tombstoned it.
    await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date(), deletionReason: 'media_retention' } });

    // The 9 MiB is expired, so a fresh 9 MiB upload should still fit under the 10 MiB quota.
    await expect(createUploadUrl({ userId }, 9 * 1024 * 1024)).resolves.toMatchObject({ objectKey: expect.any(String) });
  });
});
