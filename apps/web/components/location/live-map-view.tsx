'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LiveLocation } from '@comm/types';
import { onRealtimeEvent } from '@/lib/realtime-client';
import { colorFor, initialsFor } from '@/components/chat/avatar';

/**
 * The live map itself (docs/09-trust-boundaries.md's "Live location sharing"
 * exception) — rendered only inside `next/dynamic(..., { ssr: false })` by whichever
 * page mounts it (Leaflet touches `window` at import time, so it can never run during
 * SSR). Pulled in via `admin/map/page.tsx`'s server-fetched initial snapshot, then kept
 * live the same way `message-thread.tsx` keeps a thread live: subscribe to a
 * `onRealtimeEvent` type on mount, update local state, unsubscribe on unmount.
 *
 * OpenStreetMap raster tiles (open-source, no API key/billing) — matches what was
 * asked for over a proprietary provider like Google Maps/Mapbox. Requires
 * `Permissions-Policy: geolocation=(self)` (next.config.mjs) and the tile origin
 * added to the CSP's `img-src` (middleware.ts) — this component only renders once
 * both are already in place.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A colored circle + initials, matching `Avatar`'s own name-to-color mapping, rather
 * than Leaflet's default marker image (which needs its own bundler asset-path setup
 * this app has no other use for). */
function pinIcon(displayName: string): L.DivIcon {
  const color = colorFor(displayName || '?');
  const initials = initialsFor(displayName || '?');
  return L.divIcon({
    className: '',
    html: `<div style="
      width: 34px; height: 34px; border-radius: 9999px; background: ${color};
      display: flex; align-items: center; justify-content: center;
      color: white; font-weight: 600; font-size: 12px;
      border: 2px solid white; box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    ">${initials}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
  });
}

/** Fits the viewport to every current pin exactly once, right after the initial
 * snapshot loads — not on every subsequent live update, which would otherwise yank
 * the map out from under someone who's panned/zoomed to look at one person. */
function FitToMarkers({ locations }: { locations: LiveLocation[] }): null {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || locations.length === 0) return;
    fitted.current = true;
    if (locations.length === 1) {
      map.setView([locations[0]!.latitude, locations[0]!.longitude], 14);
    } else {
      map.fitBounds(L.latLngBounds(locations.map((l) => [l.latitude, l.longitude])), { padding: [40, 40] });
    }
  }, [locations, map]);
  return null;
}

export function LiveMapView({ initialLocations }: { initialLocations: LiveLocation[] }): React.JSX.Element {
  const [locations, setLocations] = useState<Map<string, LiveLocation>>(
    () => new Map(initialLocations.map((l) => [l.userId, l])),
  );

  useEffect(() => {
    const off = onRealtimeEvent('location.updated', (payload) => {
      const location = payload.location as LiveLocation;
      setLocations((prev) => new Map(prev).set(location.userId, location));
    });
    return off;
  }, []);

  const list = useMemo(() => [...locations.values()], [locations]);

  if (list.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No one has shared their location yet.
      </div>
    );
  }

  return (
    <MapContainer center={[list[0]!.latitude, list[0]!.longitude]} zoom={12} className="h-full w-full">
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
      <FitToMarkers locations={list} />
      {list.map((location) => (
        <Marker key={location.userId} position={[location.latitude, location.longitude]} icon={pinIcon(location.displayName)}>
          <Popup>
            <p className="font-medium">{location.displayName}</p>
            <p className="text-muted-foreground">@{location.username}</p>
            <p className="mt-1 text-xs text-muted-foreground">Updated {formatRelative(location.updatedAt)}</p>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
