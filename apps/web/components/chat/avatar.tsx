import { cn } from '@/lib/cn';

// A fixed, deterministic palette (not random per-render) so the same person always
// gets the same color across the sidebar, thread header, etc. Picked for reasonable
// contrast with white initials in both themes.
const PALETTE = [
  '#7C6EF2', // violet
  '#2FA8A0', // teal
  '#E0724A', // burnt orange
  '#3E8ED0', // blue
  '#C24E7F', // rose
  '#5AA454', // green
  '#B08B2B', // amber
  '#8B5CF6', // purple
];

// Exported so other per-person visual treatments (e.g.
// components/location/live-map-view.tsx's map pins) can match the same
// name-to-color/initials mapping used here, rather than growing their own copy.
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-14 w-14 text-base',
} as const;

export function Avatar({
  name,
  imageUrl,
  size = 'md',
  className,
}: {
  name: string;
  /** A group's `avatarUrl` (GroupSummary) or, eventually, a user's own — a signed
   * download URL, already resolved server-side, not a raw object key. Renders the
   * initials fallback (unchanged) whenever this is null/undefined, exactly the same
   * as before this prop existed — every existing call site keeps working untouched. */
  imageUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  if (imageUrl) {
    return (
      // Plain <img>, not next/image — a signed, short-lived per-request URL (see
      // GroupSummary.avatarUrl's own docstring) isn't a stable asset next/image's
      // optimizer/cache should be handed.
      <img
        src={imageUrl}
        alt=""
        className={cn('flex-shrink-0 select-none rounded-full object-cover', SIZES[size], className)}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: colorFor(name || '?') }}
      aria-hidden="true"
    >
      {initialsFor(name || '?')}
    </span>
  );
}
