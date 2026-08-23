'use client';

/**
 * Media bubble renderers shared between `message-thread.tsx` (1:1) and
 * `group-message-thread.tsx` (docs/13-roadmap.md's group chat pass) — extracted so
 * the two thread components don't carry independent copies of the exact same
 * decrypt/render logic, the same "one shared implementation, not two that could
 * drift" reasoning `lib/message-content.ts`'s `hasMediaBytes` extraction already
 * applies to elsewhere in this codebase.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { base64ToBytes } from '@comm/crypto';
import { cn } from '@/lib/cn';
import { formatFileSize, formatRecordingTime } from '@/lib/format';
import { decryptAttachment } from '@/lib/crypto/attachment-crypto';
import { downloadAttachmentCiphertext } from '@/lib/media-client';
import type { AttachmentDescriptor } from '@/lib/message-content';
import { IconPlay, IconPause, IconX, IconFile, IconDownload, IconEye, IconPlayCircle } from '../icons';

/** Shared by every attachment bubble below that needs its own decrypted bytes
 * fetched from object storage (unlike `VoiceBubble`/`ImageBubble`'s already-inline
 * base64) — one copy of the download+decrypt+blob-URL dance rather than a
 * duplicate in `MediaImageBubble` and `MediaVideoBubble` each. */
function useDecryptedAttachmentUrl(attachment: AttachmentDescriptor, autoFetch: boolean) {
  const [url, setUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const urlRef = useRef<string | undefined>(undefined);

  async function fetchNow() {
    if (urlRef.current || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const ciphertext = await downloadAttachmentCiphertext(attachment.objectKey);
      const plaintext = await decryptAttachment(ciphertext, base64ToBytes(attachment.key), base64ToBytes(attachment.nonce));
      const blob = new Blob([plaintext as BlobPart], { type: attachment.mimeType });
      const created = URL.createObjectURL(blob);
      urlRef.current = created;
      setUrl(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this file.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoFetch) void fetchNow();
    // Revoke on unmount only — a re-render with the same attachment shouldn't
    // re-fetch or re-revoke, only the component actually going away should.
    // Deliberately depends on `attachment.objectKey` alone, not `autoFetch` or
    // `fetchNow` (a new function identity every render) — either would re-run
    // this effect (and re-fetch/re-revoke) on every unrelated re-render instead
    // of only when the attachment itself actually changes.
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [attachment.objectKey]);

  return { url, loading, error, fetchNow };
}

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

/** The thumbnail + full-screen-lightbox chrome shared by `ImageBubble` (bytes
 * already inline) and `MediaImageBubble` below (bytes fetched from object
 * storage first) — one copy of the expand/download UI rather than two that could
 * drift. Click to expand into a full-screen viewer (local component state, not a
 * portal — `fixed inset-0` renders full-viewport regardless of DOM nesting
 * depth). The download button is deliberately on the thumbnail itself, not just
 * inside the expanded view, so saving a copy never needs an extra tap to
 * discover. */
function ImageBubbleView({ src, onDownload }: { src: string; onDownload: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  function handleDownload(e: React.MouseEvent): void {
    e.stopPropagation();
    onDownload();
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

/** A `data:` URL rendered straight from the decrypted bytes — no object storage, no
 * network request, same reasoning as `VoiceBubble` above. This photo has 24
 * hours before it's gone (docs/10-privacy-data-retention.md), so saving a copy
 * shouldn't need an extra tap to discover — see `ImageBubbleView`'s own docstring. */
export function ImageBubble({ base64 }: { base64: string }): React.JSX.Element {
  const src = useMemo(() => `data:image/jpeg;base64,${base64}`, [base64]);
  return <ImageBubbleView src={src} onDownload={() => saveDataUrlLocally(src, `photo-${Date.now()}.jpg`)} />;
}

/**
 * A `contentTypeHint: 'media'` attachment whose mimeType is `image/*` — unlike
 * `ImageBubble` above, the bytes aren't already inline (the `media` pipeline only
 * carries a small descriptor; the ciphertext lives in object storage), so this
 * fetches+decrypts them on mount and shows a skeleton meanwhile. Only images get
 * this eager-fetch treatment: a picked photo is small/expected enough that
 * matching WhatsApp's inline-thumbnail behavior is worth it, unlike an arbitrary
 * file (still `FileBubble`'s plain download-on-tap row) or a video
 * (`MediaVideoBubble` below, deliberately lazy — see its own docstring).
 */
export function MediaImageBubble({ attachment }: { attachment: AttachmentDescriptor; isOwn: boolean }): React.JSX.Element {
  const { url, loading, error, fetchNow } = useDecryptedAttachmentUrl(attachment, true);

  if (error) {
    return (
      <button
        type="button"
        onClick={() => void fetchNow()}
        className="flex h-40 w-56 flex-col items-center justify-center gap-1.5 rounded-lg bg-black/10 text-current"
      >
        <IconFile className="h-6 w-6" />
        <span className="text-xs">Couldn&apos;t load photo — tap to retry</span>
      </button>
    );
  }
  if (!url || loading) {
    return (
      <div className="flex h-40 w-56 items-center justify-center rounded-lg bg-black/10">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
      </div>
    );
  }
  return <ImageBubbleView src={url} onDownload={() => saveDataUrlLocally(url, attachment.fileName)} />;
}

/**
 * A `contentTypeHint: 'media'` attachment whose mimeType is `video/*`.
 * Deliberately lazy, unlike `MediaImageBubble` above: a video can be large
 * enough that eagerly fetching one just to show a thumbnail would be exactly the
 * "defeats the point of the object-storage pipeline" cost `FileBubble`'s own
 * docstring already avoids for arbitrary files. Clicking the placeholder
 * downloads+decrypts (spinner meanwhile) and opens the same full-screen overlay
 * `ImageBubbleView` uses, playing the video with native browser controls rather
 * than hand-rolled scrubber UI.
 */
export function MediaVideoBubble({ attachment }: { attachment: AttachmentDescriptor; isOwn: boolean }): React.JSX.Element {
  const { url, loading, error, fetchNow } = useDecryptedAttachmentUrl(attachment, false);
  const [expanded, setExpanded] = useState(false);

  async function handleOpen() {
    if (!url) await fetchNow();
    setExpanded(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleOpen()}
        className="flex h-40 w-56 flex-col items-center justify-center gap-1.5 rounded-lg bg-black/80 text-white"
      >
        {loading ? (
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-white border-t-transparent" />
        ) : (
          <IconPlayCircle className="h-10 w-10" />
        )}
        <span className="text-xs opacity-80">{error ?? formatFileSize(attachment.sizeBytes)}</span>
      </button>
      {expanded && url && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => setExpanded(false)}>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <IconX className="h-5 w-5" />
          </button>
          {/* No caption track to offer — a personal E2E chat attachment, not published media. */}
          <video
            src={url}
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg"
          />
        </div>
      )}
    </>
  );
}

/**
 * A view-once photo (docs/13-roadmap.md), the RECIPIENT's side only — the
 * sender's own copy just renders as a normal `ImageBubble` (see the callers in
 * message-thread.tsx/group-message-thread.tsx), since the "one look" promise is
 * about the person receiving it, not the person who already has it. Locked
 * behind a tap-to-reveal placeholder; opening it fires `onOpen` exactly once
 * (the `opened` guard), which the caller uses to trigger the actual
 * self-tombstone request (DELETE /api/messages/:id — now dual-authorized for a
 * genuine recipient of a `view_once` message, see deleteMessage's own
 * docstring). Deliberately no download button, unlike `ImageBubble` — the
 * entire point is that this isn't meant to be kept.
 */
export function ViewOnceImageBubble({ base64, onOpen }: { base64: string; onOpen: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const src = useMemo(() => `data:image/jpeg;base64,${base64}`, [base64]);

  function handleOpen() {
    if (!opened) {
      setOpened(true);
      onOpen();
    }
    setExpanded(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="flex h-28 w-44 flex-col items-center justify-center gap-1.5 rounded-lg bg-black/10 text-current"
      >
        <IconEye className="h-6 w-6" />
        <span className="text-xs font-medium">Tap to view photo</span>
      </button>
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => setExpanded(false)}>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <IconX className="h-5 w-5" />
          </button>
          <img src={src} alt="View-once photo" className="max-h-full max-w-full rounded-lg object-contain" />
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
