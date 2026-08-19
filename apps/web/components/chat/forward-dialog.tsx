'use client';

/**
 * "Forward" (docs/13-roadmap.md) — the client already holds the decrypted plaintext
 * of any rendered bubble (that's the whole point of end-to-end encryption: the
 * SERVER never has it, but the reading client always does), and `encryptForDevice`/
 * `encryptForGroup` take raw plaintext regardless of where it came from. So
 * forwarding is genuinely just "re-run the normal send path against a different
 * conversation" — this dialog is a conversation picker plus that re-run, not a new
 * crypto primitive.
 *
 * A `media` (generic file) attachment is the one content type that needs real work
 * beyond re-encrypting the same bytes: its ciphertext already lives in object
 * storage under an authorization scope tied to the ORIGINAL message
 * (server/modules/media/service.ts's `claimPendingUpload` — a pending-upload record
 * is consumed exactly once), so the old `objectKey` cannot simply be attached to a
 * second message. This downloads + decrypts the original once, then re-encrypts and
 * re-uploads fresh for every target conversation, same pipeline `handleFileSelected`
 * (message-thread.tsx) already uses for a brand-new send.
 */
import { useEffect, useState } from 'react';
import type { ConversationSummary, DeviceSummary } from '@comm/types';
import { utf8ToBytes, base64ToBytes, bytesToBase64 } from '@comm/crypto';
import { cn } from '@/lib/cn';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { encryptForDevice } from '@/lib/crypto/conversation-crypto';
import { decryptAttachment, encryptAttachment } from '@/lib/crypto/attachment-crypto';
import { downloadAttachmentCiphertext, uploadAttachmentCiphertext } from '@/lib/media-client';
import { appendCachedMessage, type CachedMessage } from '@/lib/crypto/message-cache';
import { useGroupSession } from '@/components/group/group-session-provider';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { Avatar } from './avatar';
import { titleFor } from './conversation-list';
import { IconSearch, IconCheck } from '../icons';
import type { AttachmentDescriptor } from '@/lib/message-content';

export interface ForwardableContent {
  contentTypeHint: 'text' | 'voice' | 'image' | 'media';
  text: string;
  mediaBase64?: string;
  attachment?: AttachmentDescriptor;
  mediaDurationSec?: number;
}

export function ForwardDialog({
  open,
  onClose,
  currentUserId,
  content,
}: {
  open: boolean;
  onClose: () => void;
  currentUserId: string;
  content: ForwardableContent;
}): React.JSX.Element | null {
  const { encryptForGroup } = useGroupSession();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch('');
    setError(undefined);
    setDone(false);
    apiFetch<ConversationSummary[]>('/api/conversations')
      .then(setConversations)
      .catch(() => setError('Could not load your chats.'));
  }, [open]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Re-derives fresh plaintext bytes (and, for `media`, a fresh uploaded copy)
   * every call rather than once up front — the ONE exception is the decrypted
   * source file itself, downloaded once outside the per-target loop below, since
   * that download/decrypt doesn't depend on which conversation it's headed to.
   * `descriptor` (the full key/nonce/mimeType/fileName/sizeBytes) is what this
   * device's own cache needs to be able to show/download its own forwarded copy
   * later — `attachmentRef` (objectKey + encryptedSizeBytes only) is the smaller
   * shape `SendMessageRequest.attachment` actually carries over the wire. */
  async function resolvePlaintext(
    decryptedFile: Uint8Array | null,
  ): Promise<{
    plaintext: Uint8Array;
    attachmentRef?: { objectKey: string; encryptedSizeBytes: number };
    descriptor?: AttachmentDescriptor;
  }> {
    if (content.contentTypeHint === 'text') {
      return { plaintext: utf8ToBytes(content.text) };
    }
    if (content.contentTypeHint === 'voice' || content.contentTypeHint === 'image') {
      return { plaintext: base64ToBytes(content.mediaBase64 ?? '') };
    }
    // media — re-encrypt+re-upload a fresh copy for THIS target, since the
    // original objectKey's pending-upload authorization is single-use.
    if (!decryptedFile) throw new Error('That file could not be forwarded.');
    const { ciphertext, key, nonce } = await encryptAttachment(decryptedFile);
    const { objectKey, encryptedSizeBytes } = await uploadAttachmentCiphertext(ciphertext);
    const descriptor: AttachmentDescriptor = {
      objectKey,
      key: bytesToBase64(key),
      nonce: bytesToBase64(nonce),
      mimeType: content.attachment?.mimeType ?? 'application/octet-stream',
      fileName: content.attachment?.fileName ?? 'File',
      sizeBytes: content.attachment?.sizeBytes ?? decryptedFile.byteLength,
    };
    return { plaintext: utf8ToBytes(JSON.stringify(descriptor)), attachmentRef: { objectKey, encryptedSizeBytes }, descriptor };
  }

  async function sendToConversation(
    target: ConversationSummary,
    plaintext: Uint8Array,
    attachmentRef?: { objectKey: string; encryptedSizeBytes: number },
    descriptor?: AttachmentDescriptor,
  ) {
    const kek = getCurrentKek();
    if (!kek) throw new Error('This device is locked. Please sign in again.');
    const messageId = crypto.randomUUID();
    const sentAt = new Date().toISOString();

    if (target.type === 'group') {
      const envelope = await encryptForGroup(target.group.id, plaintext);
      await apiFetch(`/api/conversations/${target.id}/messages`, {
        method: 'POST',
        body: {
          messageId,
          envelopeType: 'megolm_group',
          envelope,
          x3dhInit: null,
          contentTypeHint: content.contentTypeHint,
          replyToMessageId: null,
          sentAt,
          attachment: attachmentRef,
        },
      });
    } else {
      const [otherMemberDevices, ownDevices] = await Promise.all([
        apiFetch<Array<{ userId: string; deviceId: string }>>(`/api/conversations/${target.id}/recipient-devices`),
        apiFetch<DeviceSummary[]>('/api/devices'),
      ]);
      const ownOtherDevices = ownDevices
        .filter((d) => !d.isCurrentDevice && d.status === 'active')
        .map((d) => ({ userId: currentUserId, deviceId: d.id }));
      const targets = [...otherMemberDevices, ...ownOtherDevices];
      if (targets.length === 0) throw new Error(`${titleFor(target)} has no reachable device right now.`);
      const recipients = await Promise.all(
        targets.map(async (t) => {
          const { envelope, x3dhInit } = await encryptForDevice(t.userId, t.deviceId, plaintext);
          return { deviceId: t.deviceId, envelope, x3dhInit };
        }),
      );
      await apiFetch(`/api/conversations/${target.id}/messages`, {
        method: 'POST',
        body: {
          messageId,
          envelopeType: 'x3dh_ratchet_1to1',
          recipients,
          contentTypeHint: content.contentTypeHint,
          replyToMessageId: null,
          sentAt,
          attachment: attachmentRef,
        },
      });
    }

    // Own outgoing messages are only ever knowable to this device at the instant
    // they're sent (same forward-secrecy reasoning as every other send path in
    // this app) — without caching it here, forwarding into a conversation whose
    // thread isn't currently open would leave this device permanently unable to
    // show its own forwarded copy, since the catch-up fetch deliberately skips
    // re-decrypting a caller's own messages (message-thread.tsx's `load()`).
    const cached: CachedMessage = {
      id: messageId,
      conversationId: target.id,
      senderUserId: currentUserId,
      isOwn: true,
      contentTypeHint: content.contentTypeHint,
      text: content.text,
      mediaBase64: content.mediaBase64,
      attachment: descriptor,
      mediaDurationSec: content.mediaDurationSec,
      sentAt,
      replyToMessageId: null,
    };
    await appendCachedMessage(kek, cached);
  }

  async function handleForward() {
    if (selected.size === 0 || !conversations) return;
    setSending(true);
    setError(undefined);
    try {
      let decryptedFile: Uint8Array | null = null;
      if (content.contentTypeHint === 'media' && content.attachment) {
        const ciphertext = await downloadAttachmentCiphertext(content.attachment.objectKey);
        decryptedFile = await decryptAttachment(ciphertext, base64ToBytes(content.attachment.key), base64ToBytes(content.attachment.nonce));
      }
      const targets = conversations.filter((c) => selected.has(c.id));
      for (const target of targets) {
        const { plaintext, attachmentRef, descriptor } = await resolvePlaintext(decryptedFile);
        await sendToConversation(target, plaintext, attachmentRef, descriptor);
      }
      setDone(true);
      setTimeout(onClose, 700);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not forward that message.');
    } finally {
      setSending(false);
    }
  }

  const query = search.trim().toLowerCase();
  const filtered = (conversations ?? []).filter((c) => titleFor(c).toLowerCase().includes(query));

  return (
    <Dialog open={open} onClose={onClose} title="Forward message">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-10 rounded-full bg-muted pl-10"
          />
        </div>

        {conversations === null && !error && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {conversations !== null && filtered.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No chats found.</p>
        )}

        <div className="-mx-1 max-h-72 overflow-y-auto">
          {filtered.map((c) => {
            const isSelected = selected.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className="flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-muted"
              >
                <Avatar name={titleFor(c)} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{titleFor(c)}</span>
                <span
                  className={cn(
                    'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border',
                    isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                >
                  {isSelected && <IconCheck className="h-3 w-3" />}
                </span>
              </button>
            );
          })}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {done && <p className="text-sm text-primary">Forwarded.</p>}

        <button
          type="button"
          onClick={() => void handleForward()}
          disabled={selected.size === 0 || sending}
          className="mt-1 flex h-10 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Forwarding…' : selected.size > 0 ? `Forward to ${selected.size}` : 'Forward'}
        </button>
      </div>
    </Dialog>
  );
}
