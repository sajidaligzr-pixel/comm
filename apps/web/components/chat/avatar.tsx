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

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

function initialsFor(name: string): string {
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
  size = 'md',
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
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
