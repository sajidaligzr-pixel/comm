import { prisma } from '@comm/database';
import { AppError, type UpdateProfileRequest, type UserProfile } from '@comm/types';

function toProfile(user: {
  id: string;
  username: string;
  displayName: string;
  about: string | null;
  avatarObjectKey: string | null;
  status: string;
  createdAt: Date;
}): UserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    about: user.about ?? undefined,
    avatarObjectKey: user.avatarObjectKey,
    status: user.status as UserProfile['status'],
    createdAt: user.createdAt.toISOString(),
  };
}

export async function getOwnProfile(userId: string): Promise<UserProfile> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return toProfile(user);
}

export async function updateOwnProfile(userId: string, input: UpdateProfileRequest): Promise<UserProfile> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.about !== undefined ? { about: input.about } : {}),
    },
  });
  return toProfile(user);
}

/**
 * Privacy-filtered lookup by username — see docs/03-api-design.md's `/users/:username`
 * note: fields are withheld server-side per the target's own privacy settings, never
 * fetched-then-hidden client-side. Phase 2 doesn't yet have a "contacts" relationship
 * to evaluate the `contacts`-only visibility tier against (that ships with the
 * contacts module, docs/13-roadmap.md), so until then `contacts`-scoped fields behave
 * as `nobody` for any viewer who isn't the profile owner — the conservative direction
 * to fail in, not the permissive one.
 */
export async function getPublicProfile(
  viewerUserId: string,
  username: string,
): Promise<Pick<UserProfile, 'id' | 'username' | 'displayName' | 'status'> & Partial<UserProfile>> {
  const user = await prisma.user.findUnique({
    where: { username },
    include: { privacySettings: true },
  });
  if (!user || user.status !== 'active') {
    throw new AppError('NOT_FOUND', 'User not found.');
  }

  const isSelf = user.id === viewerUserId;
  const settings = user.privacySettings;

  const canSee = (level: 'everyone' | 'contacts' | 'nobody' | undefined): boolean => {
    if (isSelf) return true;
    if (level === 'everyone') return true;
    // 'contacts' collapses to false until the contacts module exists — see doc comment above.
    return false;
  };

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    about: canSee(settings?.about) ? (user.about ?? undefined) : undefined,
    avatarObjectKey: canSee(settings?.profilePhoto) ? user.avatarObjectKey : null,
  };
}
