import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import {
  createGroup,
  getOrCreateGroupInviteLink,
  regenerateGroupInviteLink,
  revokeGroupInviteLink,
  peekGroupInvite,
  joinGroupViaInviteLink,
  createGroupAvatarUploadUrl,
  confirmGroupAvatar,
  removeGroupAvatar,
  setGroupMemberRole,
} from '../../modules/groups/service';
import { createActiveUser, deleteTestUser, fakeDeviceRegistration } from '../helpers';
import { registerDevice } from '../../modules/devices/service';

/**
 * Coverage for the three group-settings features added in this pass (docs/13-roadmap.md
 * "quick wins" batch) — all new admin-gated authorization surfaces, the same
 * class of thing group-authorization.test.ts already covers for the pre-existing
 * group routes, so this mirrors that file's exact fixture shape.
 */
describe('group invite links, avatar, and roles', () => {
  const createdUserIds: string[] = [];
  const createdGroupIds: string[] = [];

  afterAll(async () => {
    await Promise.all(createdGroupIds.map((id) => prisma.group.delete({ where: { id } }).catch(() => undefined)));
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function makeMember(name: string) {
    const user = await createActiveUser();
    createdUserIds.push(user.userId);
    const { deviceId } = await registerDevice(prisma, user.userId, fakeDeviceRegistration(name));
    return { ...user, deviceId };
  }

  async function setupGroup() {
    const admin = await makeMember('Admin device');
    const member = await makeMember('Member device');
    const group = await createGroup(admin.userId, 'Invite-link test group', undefined, [member.username]);
    createdGroupIds.push(group.id);
    return { admin, member, group };
  }

  it('rejects a non-admin member from creating, resetting, or revoking the invite link', async () => {
    const { member, group } = await setupGroup();

    await expect(getOrCreateGroupInviteLink(group.id, member.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(regenerateGroupInviteLink(group.id, member.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(revokeGroupInviteLink(group.id, member.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is idempotent — fetching twice returns the SAME token, not a new one each time', async () => {
    const { admin, group } = await setupGroup();

    const first = await getOrCreateGroupInviteLink(group.id, admin.userId);
    const second = await getOrCreateGroupInviteLink(group.id, admin.userId);
    expect(second.token).toBe(first.token);
  });

  it('"reset link" mints a different token, and the old one stops working', async () => {
    const { admin, group } = await setupGroup();
    const original = await getOrCreateGroupInviteLink(group.id, admin.userId);

    const outsider = await makeMember('Outsider device');
    const regenerated = await regenerateGroupInviteLink(group.id, admin.userId);
    expect(regenerated.token).not.toBe(original.token);

    await expect(peekGroupInvite(original.token, outsider.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The new one works fine.
    const peek = await peekGroupInvite(regenerated.token, outsider.userId);
    expect(peek.groupId).toBe(group.id);
  });

  it('a revoked link can no longer be peeked or joined', async () => {
    const { admin, group } = await setupGroup();
    const link = await getOrCreateGroupInviteLink(group.id, admin.userId);
    await revokeGroupInviteLink(group.id, admin.userId);

    const outsider = await makeMember('Outsider device');
    await expect(peekGroupInvite(link.token, outsider.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(joinGroupViaInviteLink(link.token, outsider.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an unrelated authenticated user can peek (not-yet-a-member) and then join via a valid link', async () => {
    const { admin, group } = await setupGroup();
    const link = await getOrCreateGroupInviteLink(group.id, admin.userId);
    const outsider = await makeMember('Outsider device');

    const peek = await peekGroupInvite(link.token, outsider.userId);
    expect(peek.alreadyMember).toBe(false);
    expect(peek.conversationId).toBeNull();

    const joined = await joinGroupViaInviteLink(link.token, outsider.userId);
    expect(joined.members.some((m) => m.userId === outsider.userId)).toBe(true);

    const peekAfter = await peekGroupInvite(link.token, outsider.userId);
    expect(peekAfter.alreadyMember).toBe(true);
    expect(peekAfter.conversationId).toBe(group.conversationId);
  });

  it('joining a group already joined is a harmless no-op, not an error or a duplicate row', async () => {
    const { admin, group } = await setupGroup();
    const link = await getOrCreateGroupInviteLink(group.id, admin.userId);
    const outsider = await makeMember('Outsider device');

    await joinGroupViaInviteLink(link.token, outsider.userId);
    const secondJoin = await joinGroupViaInviteLink(link.token, outsider.userId);
    expect(secondJoin.members.filter((m) => m.userId === outsider.userId)).toHaveLength(1);
  });

  it('a former (removed) member re-joining via link gets a fresh membership row, not left "removed"', async () => {
    const { admin, member, group } = await setupGroup();
    const link = await getOrCreateGroupInviteLink(group.id, admin.userId);

    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: group.conversationId, userId: member.userId } },
    });
    await prisma.groupMember.update({
      where: { groupId_userId: { groupId: group.id, userId: member.userId } },
      data: { removedAt: new Date() },
    });

    const rejoined = await joinGroupViaInviteLink(link.token, member.userId);
    expect(rejoined.members.some((m) => m.userId === member.userId)).toBe(true);
    const row = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: member.userId } } });
    expect(row?.removedAt).toBeNull();
  });

  it('rejects a non-admin from minting an avatar upload URL or setting/removing the avatar', async () => {
    const { member, group } = await setupGroup();

    await expect(createGroupAvatarUploadUrl(group.id, member.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(confirmGroupAvatar(group.id, member.userId, 'some-object-key')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(removeGroupAvatar(group.id, member.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin can set and then remove the group avatar, reflected in avatarUrl', async () => {
    const { admin, group } = await setupGroup();

    const { objectKey } = await createGroupAvatarUploadUrl(group.id, admin.userId);
    const withAvatar = await confirmGroupAvatar(group.id, admin.userId, objectKey);
    expect(withAvatar.avatarUrl).toBeTruthy();

    const withoutAvatar = await removeGroupAvatar(group.id, admin.userId);
    expect(withoutAvatar.avatarUrl).toBeNull();
  });

  it('rejects a non-admin from promoting or demoting anyone', async () => {
    const { member, group } = await setupGroup();

    await expect(setGroupMemberRole(group.id, member.userId, member.userId, 'admin')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin can promote a member, and that promoted member can then act as an admin too', async () => {
    const { admin, member, group } = await setupGroup();

    const promoted = await setGroupMemberRole(group.id, admin.userId, member.userId, 'admin');
    expect(promoted.members.find((m) => m.userId === member.userId)?.role).toBe('admin');

    // The freshly-promoted member now genuinely holds admin authority server-side,
    // not just in the response shape — re-derived from the DB on every call
    // (requireGroupAdmin), same as every other admin-gated action in this file.
    const demoted = await setGroupMemberRole(group.id, member.userId, admin.userId, 'member');
    expect(demoted.members.find((m) => m.userId === admin.userId)?.role).toBe('member');
  });

  it('refuses to demote the group\'s last remaining admin', async () => {
    const { admin, group } = await setupGroup();

    await expect(setGroupMemberRole(group.id, admin.userId, admin.userId, 'member')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('demoting the last admin is fine once a second admin exists', async () => {
    const { admin, member, group } = await setupGroup();
    await setGroupMemberRole(group.id, admin.userId, member.userId, 'admin');

    const result = await setGroupMemberRole(group.id, admin.userId, admin.userId, 'member');
    expect(result.members.find((m) => m.userId === admin.userId)?.role).toBe('member');
    expect(result.members.find((m) => m.userId === member.userId)?.role).toBe('admin');
  });

  it('setting a role to what it already is is a harmless no-op', async () => {
    const { admin, group } = await setupGroup();
    const result = await setGroupMemberRole(group.id, admin.userId, admin.userId, 'admin');
    expect(result.members.find((m) => m.userId === admin.userId)?.role).toBe('admin');
  });

  it('rejects setting a role for someone not actually in the group', async () => {
    const { admin, group } = await setupGroup();
    const outsider = await makeMember('Outsider device');

    await expect(setGroupMemberRole(group.id, admin.userId, outsider.userId, 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
