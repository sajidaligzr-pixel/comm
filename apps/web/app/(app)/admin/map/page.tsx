import Link from 'next/link';
import { getLocationAccessContextOrRedirect } from '@/server/common/page-auth';
import { listLiveLocations } from '@/server/modules/locations/service';
import { isAdmin } from '@/server/modules/admin/service';
import { LiveMapLoader } from '@/components/location/live-map-loader';

export default async function LocationMapPage() {
  const ctx = await getLocationAccessContextOrRedirect();
  const [locations, admin] = await Promise.all([listLiveLocations(), isAdmin(ctx.userId)]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">Live location</h1>
          <p className="text-xs text-muted-foreground">Everyone currently sharing their location.</p>
        </div>
        {admin && (
          <Link href="/admin/location-viewers" className="text-sm text-primary hover:underline">
            Manage access
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <LiveMapLoader initialLocations={locations} />
      </div>
    </div>
  );
}
