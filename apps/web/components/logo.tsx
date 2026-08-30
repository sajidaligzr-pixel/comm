/**
 * Inlined (not <img src="/logo.svg">) so the wordmark's `currentColor` fill actually
 * inherits the surrounding text color and adapts to light/dark theme — an externally
 * referenced/`next/image`-loaded SVG is isolated from page CSS and `currentColor`
 * would resolve to black regardless of theme. public/logo.svg (same mark) still
 * exists as a static asset for anywhere outside a React tree (e.g. README/docs).
 */
export function Logo({ className, wordmark = true }: { className?: string; wordmark?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox={wordmark ? '0 0 148 32' : '0 0 32 32'}
      width={wordmark ? 148 : 32}
      height={32}
      role="img"
      aria-label="Comm"
      className={className}
    >
      <rect width="32" height="32" rx="9" fill="#25D366" />
      <path
        d="M7 12.5C7 9.46 9.46 7 12.5 7h7C22.54 7 25 9.46 25 12.5v4c0 3.04-2.46 5.5-5.5 5.5h-6.06L9 25v-4.35A5.5 5.5 0 0 1 7 16.5v-4Z"
        fill="#FFFFFF"
      />
      <path d="M17.6 12.3a1.6 1.6 0 1 0-2.6 1.25v1.55a1 1 0 0 0 2 0v-1.55c.37-.29.6-.74.6-1.25Z" fill="#25D366" />
      {wordmark && (
        <text
          x="42"
          y="22"
          fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
          fontSize="18"
          fontWeight={600}
          fill="currentColor"
        >
          Comm
        </text>
      )}
    </svg>
  );
}
