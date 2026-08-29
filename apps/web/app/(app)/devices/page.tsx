import Link from 'next/link';
import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { listDevices } from '@/server/modules/devices/service';
import { getOwnProfile } from '@/server/modules/users/service';
import { DevicesList } from '@/components/devices-list';
import { LinkDevicePanel } from '@/components/link-device-panel';
import { BiometricUnlockToggle } from '@/components/biometric-unlock-toggle';
import { DeleteAccountSection } from '@/components/delete-account-section';

export default async function DevicesPage() {
  const ctx = await getAuthContextOrRedirect();
  const [devices, profile] = await Promise.all([listDevices(ctx.userId, ctx.deviceId), getOwnProfile(ctx.userId)]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Linked devices</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every device below can read new messages sent to you. Revoke anything you don&apos;t recognize.
          </p>
        </div>
        <BiometricUnlockToggle userId={ctx.userId} username={profile.username} />
        <DevicesList initialDevices={devices} />
        <LinkDevicePanel />
        <Link href="/blocked" className="block text-sm font-medium text-primary hover:underline">
          Blocked users
        </Link>
        <DeleteAccountSection />
      </div>
    </div>
  );
}
