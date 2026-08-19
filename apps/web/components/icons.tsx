/**
 * Small hand-rolled SVG icon set — deliberately not a dependency (this app already
 * hand-draws its logo, see components/logo.tsx; a handful of 24x24 outline icons
 * doesn't justify pulling in an icon package). Every icon takes the same `className`
 * prop and uses `currentColor` so it inherits text color/theme automatically.
 */
type IconProps = { className?: string };

export function IconSearch({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function IconSend({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M3.4 20.6 21 12 3.4 3.4 3 10l12 2-12 2z" />
    </svg>
  );
}

export function IconCheck({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 8.5 6 12l7.5-8" />
    </svg>
  );
}

export function IconCheckDouble({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M1 8.5 4.5 12 12 4" />
      <path d="M7.5 8.5 11 12l7.5-8" />
    </svg>
  );
}

export function IconClock({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSmile({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 10.5v.01M15.5 10.5v.01" />
      <path d="M8 14.5c1 1.2 2.4 1.8 4 1.8s3-.6 4-1.8" />
    </svg>
  );
}

export function IconPaperclip({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M17.5 8.5 9.9 16a3 3 0 1 1-4.2-4.2l8-8a2 2 0 1 1 2.9 2.9l-7.6 7.6a1 1 0 1 1-1.4-1.4l6.9-6.9" />
    </svg>
  );
}

export function IconArrowLeft({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

export function IconTrash({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9 7V4.8c0-.4.4-.8.9-.8h4.2c.5 0 .9.4.9.8V7" />
      <path d="M6 7v12c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconReply({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 10 4 15l5 5" />
      <path d="M4 15h10a6 6 0 0 0 6-6V7" />
    </svg>
  );
}

/** `IconReply` mirrored — same curved-arrow shape pointing the other way, the
 * conventional "forward" glyph (WhatsApp/Telegram/Gmail all draw it this way). */
export function IconForward({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 10l5 5-5 5" />
      <path d="M20 15H10a6 6 0 0 1-6-6V7" />
    </svg>
  );
}

export function IconCopy({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function IconX({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function IconEdit({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

export function IconMoreVertical({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

export function IconChevronUp({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

export function IconChevronDown({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconPhone({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4.5 4.5h4l2 5-2.5 1.5a12 12 0 0 0 5.5 5.5L15 14l5 2v4a2 2 0 0 1-2 2C9.6 22 2 14.4 2 6.5a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

export function IconMic({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21M9 21h6" />
    </svg>
  );
}

export function IconPlay({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

export function IconPause({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

/** Call-history direction glyphs — an arrow into/out of a phone corner, the same
 * convention WhatsApp/every dialer uses (mirrors apps/mobile's `Icons.call_received`/
 * `Icons.call_made` in call_history_screen.dart). */
export function IconCallIncoming({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7 7v6h6" />
      <path d="M7 13 17 3" />
    </svg>
  );
}

export function IconCallOutgoing({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M11 3h6v6" />
      <path d="M17 3 7 13" />
    </svg>
  );
}

export function IconPhoneOff({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4.5 4.5h4l2 5-2.5 1.5a12 12 0 0 0 5.5 5.5L15 14l5 2v4a2 2 0 0 1-2 2c-2.4-.1-4.8-.8-7-1.9" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

export function IconMicOff({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 4.2A3 3 0 0 1 15 5.5v5c0 .3 0 .6-.1.9" />
      <path d="M9 9v2a3 3 0 0 0 4.3 2.7" />
      <path d="M5.5 11a6.5 6.5 0 0 0 9.3 5.9" />
      <path d="M12 17.5V21M9 21h6" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

export function IconImage({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5.5-5.5a1.5 1.5 0 0 0-2.1 0L4 19" />
    </svg>
  );
}

export function IconBell({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.5 6 2 6.5H4c.5-.5 2-2 2-6.5Z" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}

export function IconLock({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

export function IconFile({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function IconDownload({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function IconUsers({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
      <path d="M16 8.5a2.75 2.75 0 1 0 0-5.5" />
      <path d="M20.5 19c0-2.6-1.8-4.7-4.2-5.3" />
    </svg>
  );
}

export function IconArchive({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

/** Filled when a chat/message is pinned — `IconProps.className` alone drives
 * whether it reads as filled (pass a `fill-current` utility class) since this
 * one shape covers both the outline and filled treatments other icons here
 * don't need to distinguish. */
export function IconPin({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M8 11V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v5l2 3H6l2-3Z" />
    </svg>
  );
}

export function IconStar({ className, filled }: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m12 3 2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.9 6.4 20.1l1.4-6.3-4.8-4.3 6.4-.6L12 3Z" />
    </svg>
  );
}

export function IconEye({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconBlock({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.5 5.5 13 13" />
    </svg>
  );
}

export function IconFingerprint({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3a7 7 0 0 0-7 7v1c0 2.5.4 4.5 1.2 6.5" />
      <path d="M12 3a7 7 0 0 1 7 7v1c0 1.3-.1 2.4-.4 3.5" />
      <path d="M8.5 20c-.9-1.6-1.5-3.7-1.5-6.5v-1.5a5 5 0 0 1 10 0v1" />
      <path d="M12 9.5a3.5 3.5 0 0 0-3.5 3.5v1.5c0 2.3.5 4 1.3 5.5" />
      <path d="M12 9.5a3.5 3.5 0 0 1 3.5 3.5v2c0 1.1-.1 2-.4 3" />
      <path d="M15.8 7.5A6.9 6.9 0 0 1 17 11.5" />
    </svg>
  );
}

// Speaker-on/off pair for the in-call output toggle (call-overlay.tsx) — same
// two-icon-for-two-states pattern as IconMic/IconMicOff above.
export function IconVolume({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z" />
      <path d="M16 9.5a4 4 0 0 1 0 5" />
    </svg>
  );
}

export function IconVolumeOff({ className }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
