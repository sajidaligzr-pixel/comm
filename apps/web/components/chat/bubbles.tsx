'use client';

/**
 * Media bubble renderers shared between `message-thread.tsx` (1:1) and
 * `group-message-thread.tsx` (docs/13-roadmap.md's group chat pass) — extracted so
 * the two thread components don't carry independent copies of the exact same
 * decrypt/render logic, the same "one shared implementation, not two that could
 * drift" reasoning `lib/message-content.ts`'s `hasMediaBytes` extraction already
 * applies to elsewhere in this codebase.
 */
import { useMemo, useRef, useState } from 'react';
import { base64ToBytes } from '@comm/crypto';
import { cn } from '@/lib/cn';
import { formatFileSize, formatRecordingTime } from '@/lib/format';
import { decryptAttachment } from '@/lib/crypto/attachment-crypto';
import { downloadAttachmentCiphertext } from '@/lib/media-client';
import type { AttachmentDescriptor } from '@/lib/message-content';
import { IconPlay, IconPause, IconX, IconFile, IconDownload } from '../icons';

export function VoiceBubble({ base64, durationHint, isOwn }: { base64: string; durationHint?: number; isOwn: boolean }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [currentTime, setCurrentTime] = useState(0);
  const src = useMemo(() => `data:audio/webm;base64,${base64}`, [base64]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play();
  }

  const displaySeconds = playing || currentTime > 0 ? currentTime : duration;

  return (
    <div className="flex min-w-[10rem] items-center gap-2 py-1">
      {/* A voice note has no captionable track; the play/pause control below (not
          native <audio> chrome, which stays hidden) is the accessible surface. */}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full',
          isOwn ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary',
        )}
      >
        {playing ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4 translate-x-0.5" />}
      </button>
      <div className="flex-1">
        <div className={cn('h-1 w-full overflow-hidden rounded-full', isOwn ? 'bg-primary-foreground/30' : 'bg-border')}>
          <div
            className={cn('h-full', isOwn ? 'bg-primary-foreground' : 'bg-primary')}
            style={{ width: duration > 0 ? `${Math.min(100, (currentTime / duration) * 100)}%` : '0%' }}
          />
        </div>
        <span className="mt-0.5 block text-[11px] opacity-80">{formatRecordingTime(displaySeconds)}</span>
      </div>
      <button
        type="button"
        onClick={() => saveDataUrlLocally(src, `voice-message-${Date.now()}.webm`)}
        aria-label="Download voice message"
        title="Download"
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100',
          isOwn ? 'text-primary-foreground' : 'text-foreground',
        )}
      >
        <IconDownload className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Saves an already-decrypted, already-in-memory `data:` URL locally — no network
 * round trip, since (unlike `FileBubble`'s attachment) there's nothing left to fetch.
 * Shared by `ImageBubble`/`VoiceBubble` below: both are inline media that, per
 * docs/10-privacy-data-retention.md's media retention pass, are erased server-side
 * 24h after sending regardless of whether anyone's looked at them — this is the
 * explicit "keep a copy" action that makes that default less surprising. */
function saveDataUrlLocally(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

/** A `data:` URL rendered straight from the decrypted bytes — no object storage, no
 * network request, same reasoning as `VoiceBubble` above. Click to expand into a
 * full-screen viewer (local component state, not a portal — `fixed inset-0` renders
 * full-viewport regardless of DOM nesting depth). The download button is deliberately
 * on the thumbnail itself, not just inside the expanded view — this photo has 24
 * hours before it's gone (docs/10-privacy-data-retention.md), so saving a copy
 * shouldn't need an extra tap to discover. */
export function ImageBubble({ base64 }: { base64: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const src = useMemo(() => `data:image/jpeg;base64,${base64}`, [base64]);

  function handleDownload(e: React.MouseEvent): void {
    e.stopPropagation();
    saveDataUrlLocally(src, `photo-${Date.now()}.jpg`);
  }

  return (
    <>
      <div className="relative">
        <button type="button" onClick={() => setExpanded(true)} className="block max-w-full">
          <img src={src} alt="Sent photo" className="max-h-72 w-full max-w-xs rounded-lg object-cover sm:max-w-sm" />
        </button>
        <button
          type="button"
          onClick={handleDownload}
          aria-label="Download photo"
          title="Download"
          className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
        >
          <IconDownload className="h-4 w-4" />
        </button>
      </div>
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => setExpanded(false)}>
          <button
            type="button"
            onClick={handleDownload}
            aria-label="Download photo"
            title="Download"
            className="absolute right-16 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <IconDownload className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <IconX className="h-5 w-5" />
          </button>
          <img src={src} alt="Sent photo" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </>
  );
}

/** A generic file bubble (docs/13-roadmap.md's media pass) — unlike `VoiceBubble`/
 * `ImageBubble`, there are no bytes to render inline: the ciphertext lives in object
 * storage, only fetched (and decrypted) when the user actually taps Download, since
 * eagerly downloading every file attachment in a thread would defeat the point of
 * not inlining them. */
export function FileBubble({ attachment, isOwn }: { attachment: AttachmentDescriptor; isOwn: boolean }): React.JSX.Element {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleDownload() {
    setDownloading(true);
    setError(undefined);
    try {
      const ciphertext = await downloadAttachmentCiphertext(attachment.objectKey);
      const plaintext = await decryptAttachment(ciphertext, base64ToBytes(attachment.key), base64ToBytes(attachment.nonce));
      const blob = new Blob([plaintext as BlobPart], { type: attachment.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download this file.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="min-w-[12rem]">
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={downloading}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left disabled:opacity-70',
          isOwn ? 'hover:bg-black/10' : 'hover:bg-muted',
        )}
      >
        <span
          className={cn(
            'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full',
            isOwn ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary',
          )}
        >
          <IconFile className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.fileName}</span>
          <span className="block text-xs opacity-70">{downloading ? 'Downloading…' : formatFileSize(attachment.sizeBytes)}</span>
        </span>
        <IconDownload className="h-4 w-4 flex-shrink-0 opacity-70" />
      </button>
      {error && <p className="mt-0.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
