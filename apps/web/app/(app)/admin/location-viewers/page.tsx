import { getAdminContextOrRedirect } from '@/server/common/page-auth';
import { listLocationViewers } from '@/server/modules/locations/service';
import { LocationViewersList } from '@/components/location/location-viewers-list';

export default async function LocationViewersPage() {
  await getAdminContextOrRedirect();
  const viewers = await listLocationViewers();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Location access</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Controls who besides admins can see the live location map (see docs/09-trust-boundaries.md).
          </p>
        </div>
        <LocationViewersList initialViewers={viewers} />
      </div>
    </div>
  );
}
