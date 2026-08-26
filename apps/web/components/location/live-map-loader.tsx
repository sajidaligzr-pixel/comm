'use client';

import dynamic from 'next/dynamic';
import type { LiveLocation } from '@comm/types';

/**
 * `next/dynamic(..., { ssr: false })` is only allowed inside a Client Component (Next
 * App Router rule) — `admin/map/page.tsx` is an async Server Component (it fetches the
 * initial snapshot server-side), so this thin wrapper is what actually does the
 * SSR-free dynamic import of `LiveMapView` (Leaflet touches `window` at import time).
 */
const LiveMapView = dynamic(() => import('./live-map-view').then((m) => m.LiveMapView), { ssr: false });

export function LiveMapLoader({ initialLocations }: { initialLocations: LiveLocation[] }): React.JSX.Element {
  return <LiveMapView initialLocations={initialLocations} />;
}
