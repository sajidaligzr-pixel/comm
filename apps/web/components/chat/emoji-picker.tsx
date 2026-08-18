'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconSmile } from '../icons';

// A small curated set, not a full Unicode CLDR picker — fully functional (inserts
// real emoji into the composer, or reacts to a message with one) without pulling in
// an emoji-data dependency.
const EMOJI = [
  '😀', '😂', '😍', '😉', '😊', '🙂', '😘', '😅',
  '😢', '😭', '😡', '😮', '😴', '🤔', '🙄', '😎',
  '👍', '👎', '🙏', '👏', '💪', '🤝', '✌️', '👌',
  '❤️', '🔥', '🎉', '✅', '⭐', '💯', '😇', '🤗',
];

export function EmojiPicker({
  onSelect,
  size = 'md',
  align = 'left',
  ariaLabel = 'Insert emoji',
}: {
  onSelect: (emoji: string) => void;
  /** `sm` is what message-thread.tsx/group-message-thread.tsx use for the
   * per-bubble "react" trigger — sized to match the `IconMoreVertical` button it
   * sits next to rather than the taller compose-bar toolbar buttons. */
  size?: 'sm' | 'md';
  /** Which edge the dropdown grid hangs from — `right` for a per-message trigger
   * on an own (right-aligned) bubble, so the grid doesn't overflow past the edge
   * of the scroll container. */
  align?: 'left' | 'right';
  ariaLabel?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-expanded={open}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
          open && 'bg-muted text-foreground',
        )}
      >
        <IconSmile className={size === 'sm' ? 'h-4 w-4' : 'h-6 w-6'} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute bottom-full z-20 mb-2 grid w-64 grid-cols-8 gap-1 rounded-2xl border border-border bg-background p-2 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelect(emoji);
                setOpen(false);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-muted"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
