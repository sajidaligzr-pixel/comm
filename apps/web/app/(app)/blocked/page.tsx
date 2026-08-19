import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { listBlockedUsers } from '@/server/modules/blocking/service';
import { BlockedUsersList } from '@/components/blocked-users-list';

export default async function BlockedUsersPage() {
  const ctx = await getAuthContextOrRedirect();
  const blocked = await listBlockedUsers(ctx.userId);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Blocked users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Blocked users can&apos;t message or call you, and you can&apos;t message or call them. Unblock anyone below
            to reverse that.
          </p>
        </div>
        <BlockedUsersList initialBlocked={blocked} />
      </div>
    </div>
  );
}
