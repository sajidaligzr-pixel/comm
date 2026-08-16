'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconSmile } from '../icons';

// A small curated set, not a full Unicode CLDR picker — fully functional (inserts
// real emoji into the composer) without pulling in an emoji-data dependency.
const EMOJI = [
  '😀', '😂', '😍', '😉', '😊', '🙂', '😘', '😅',
  '😢', '😭', '😡', '😮', '😴', '🤔', '🙄', '😎',
  '👍', '👎', '🙏', '👏', '💪', '🤝', '✌️', '👌',
  '❤️', '🔥', '🎉', '✅', '⭐', '💯', '😇', '🤗',
];

export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }): React.JSX.Element {
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
        aria-label="Insert emoji"
        aria-expanded={open}
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          open && 'bg-muted text-foreground',
        )}
      >
        <IconSmile className="h-6 w-6" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-2 grid w-64 grid-cols-8 gap-1 rounded-2xl border border-border bg-background p-2 shadow-lg"
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
