import Link from 'next/link';
import { getAdminContextOrRedirect } from '@/server/common/page-auth';
import { listProvisionedUsers } from '@/server/modules/admin/service';
import { ProvisionUserForm } from '@/components/provision-user-form';
import { Card } from '@/components/ui/card';

export default async function AdminPage() {
  await getAdminContextOrRedirect();
  const users = await listProvisionedUsers();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Account provisioning, plus live location sharing — nothing here can read a user&apos;s message
            content (see docs/09-trust-boundaries.md, which documents live location as this app&apos;s one
            explicit exception to that).
          </p>
          <div className="mt-3 flex gap-4 text-sm">
            <Link href="/admin/map" className="text-primary hover:underline">
              Live location map
            </Link>
            <Link href="/admin/location-viewers" className="text-primary hover:underline">
              Manage location access
            </Link>
          </div>
        </div>

        <ProvisionUserForm />

        <div>
          <h2 className="text-sm font-semibold text-foreground">All accounts</h2>
          <div className="mt-2 space-y-2">
            {users.map((u) => (
              <Card key={u.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {u.displayName} <span className="text-muted-foreground">@{u.username}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {u.status} · created {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
