'use client';

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import {
  createOutboundGroupSession,
  createInboundGroupSession,
  encryptGroupMessage,
  decryptGroupMessage as ratchetDecryptGroupMessage,
  encodeGroupHeader,
  decodeGroupHeader,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
  bytesToUtf8,
  type GroupOutboundSession,
} from '@comm/crypto';
import type { GroupKeyShareDto, GroupSummary } from '@comm/types';
import { apiFetch } from '@/lib/api-client';
import { onRealtimeEvent } from '@/lib/realtime-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { encryptForDevice, decryptFromDeviceOnce } from '@/lib/crypto/conversation-crypto';
import {
  saveOutboundGroupSession,
  loadOutboundGroupSession,
  saveInboundGroupSession,
  loadInboundGroupSession,
} from '@/lib/crypto/group-sessions';

/**
 * The group-chat analog of `call-provider.tsx`: a state machine mounted once at the
 * app-shell level (docs/13-roadmap.md's group chat pass), owning everything about
 * group Megolm-style session lifecycle — creation, key distribution, epoch rotation
 * on removal, and the small "which sender's session don't I have yet" retry gap —
 * so `GroupMessageThread` only ever calls `encryptForGroup`/`decryptGroupMessageOnce`
 * and never touches ratchet state directly.
 *
 * Everything here rides the EXISTING 1:1 Double Ratchet (`encryptForDevice`/
 * `decryptFromDeviceOnce`, lib/crypto/conversation-crypto.ts) to move group session
 * key material between devices — zero changes to that code, confirmed reusable as-is
 * during design (docs/13-roadmap.md).
 */

interface GroupSessionDescriptor {
  groupId: string;
  epoch: number;
  sessionId: string; // base64
  chainKey: string; // base64
  counter: number;
}

function associatedDataFor(groupId: string, senderUserId: string): Uint8Array {
  return utf8ToBytes(`group:${groupId}:${senderUserId}`);
}

interface EncryptedGroupEnvelope {
  header: string; // base64
  ciphertext: string; // base64
}

interface GroupSessionContextValue {
  /** Encrypts for the group (creating + sharing a fresh outbound session first if
   * this device doesn't have one yet — e.g. the very first message it sends). */
  encryptForGroup: (groupId: string, plaintext: Uint8Array) => Promise<EncryptedGroupEnvelope>;
  /** Throws if there's no inbound session yet for this sender — callers should try
   * `ensureGroupKeysUpToDate` and retry once before giving up (mirrors the "skipped,
   * not shown as an error" posture message-thread.tsx already takes for undecryptable
   * 1:1 messages). Memoized by `messageId` — see the docstring above this function's
   * implementation for why that's required, not optional, for group messages. */
  decryptGroupMessageOnce: (
    messageId: string,
    groupId: string,
    senderUserId: string,
    envelope: EncryptedGroupEnvelope,
  ) => Promise<Uint8Array>;
  /** Fetches + applies any pending key shares for this group (REST catch-up) — call
   * on group-thread mount/reconnect and whenever a `group.key-share` ping arrives. */
  ensureGroupKeysUpToDate: (groupId: string) => Promise<void>;
  /** Seeds this group's known-member baseline so the next `group.members-changed`
   * event can correctly diff "who was added vs. removed" — call once when a group
   * thread mounts, before relying on live rotation/redistribution. */
  registerGroupMembership: (groupId: string) => Promise<void>;
}

const GroupSessionContext = createContext<GroupSessionContextValue | null>(null);

export function useGroupSession(): GroupSessionContextValue {
  const ctx = useContext(GroupSessionContext);
  if (!ctx) throw new Error('useGroupSession must be used within GroupSessionProvider');
  return ctx;
}

export function GroupSessionProvider({
  currentUserId,
  children,
}: {
  currentUserId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  // groupId -> last-known member user ids, used purely to diff an incoming
  // group.members-changed event into "who got added" vs. "who got removed" (the
  // event itself only says "something changed," not what — see docs/13-roadmap.md).
  const knownMembersRef = useRef<Map<string, Set<string>>>(new Map());

  /**
   * A real race found auditing this file, the group-ratchet analog of the
   * `message-cache.ts` write race already found and fixed live-testing media
   * retention: every read-mutate-write against a group session (encrypt-and-advance
   * the outbound chain, decrypt-and-advance an inbound one, or splice in a freshly
   * received key share) was unserialized — load, mutate in memory, save the whole
   * blob back. `decryptGroupMessageOnce` above only dedupes the *same* message id
   * (React StrictMode double-invoking the same decrypt); it does nothing for two
   * *different* messages from the same sender arriving close together, which is a
   * completely ordinary case (someone sends a couple of messages back to back) —
   * both would load the same starting ratchet state, each advance their own
   * in-memory copy independently, and whichever save wins overwrites the other's
   * advance rather than the two composing. Unlike message-cache.ts's version of this
   * bug (a UI desync, fixed by reloading), losing an advance here is real ratchet
   * *state* — the lost message's key was still consumed to decrypt it, just never
   * durably recorded, so a later redelivery or the next message in sequence can
   * legitimately fail to decrypt, with no local recovery. Fixed the identical way:
   * a per-key promise-chain mutex, so every load-mutate-save for the same
   * (groupId) outbound chain or (groupId, senderUserId) inbound chain runs
   * one at a time, in arrival order, each seeing the previous one's actual result.
   */
  const groupSessionLocks = useRef<Map<string, Promise<unknown>>>(new Map());
  const withGroupSessionLock = useCallback(<T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const locks = groupSessionLocks.current;
    const prior = locks.get(key) ?? Promise.resolve();
    const result = prior.then(run, run); // run regardless of whether the prior queued op threw
    // a rejection here must never wedge the queue for later callers
    const queued = result.catch(() => undefined);
    locks.set(key, queued);
    // A real leak found auditing this for production deployment: every (groupId)/
    // (groupId, senderUserId) key ever locked stayed in this map forever, for the
    // life of the tab — unbounded over a long PWA session across many groups/
    // senders. Evicted the same compare-and-delete way
    // conversation-crypto.ts#decryptFromDeviceOnce's decrypt memo already does, so a
    // genuinely new operation that queued behind this one in the meantime is never
    // evicted out from under it.
    void queued.then(() => {
      if (locks.get(key) === queued) locks.delete(key);
    });
    return result;
  }, []);

  const shareSessionTo = useCallback(
    async (groupId: string, epoch: number, session: GroupOutboundSession, targets: Array<{ userId: string; deviceId: string }>) => {
      const descriptor: GroupSessionDescriptor = {
        groupId,
        epoch,
        sessionId: bytesToBase64(session.sessionId),
        chainKey: bytesToBase64(session.chainKey),
        counter: session.counter,
      };
      const plaintext = utf8ToBytes(JSON.stringify(descriptor));
      for (const target of targets) {
        try {
          const { envelope, x3dhInit } = await encryptForDevice(target.userId, target.deviceId, plaintext);
          // REST, not `sendRealtimeEvent` — a real bug found via live testing: a
          // fire-and-forget WS send silently drops if the socket isn't open yet
          // (lib/realtime-client.ts's own documented behavior), which reliably
          // happened for a group's very first message, sent immediately after
          // creating the group, before the just-mounted thread's socket had
          // finished connecting. This POST guarantees the durable GroupKeyShare row
          // gets created regardless of socket timing; the server still publishes
          // the same live `group.key-share` nudge afterward if a socket happens to
          // be connected.
          await apiFetch(`/api/groups/${groupId}/key-shares`, {
            body: { groupId, epoch, toDeviceId: target.deviceId, envelope, x3dhInit },
          });
        } catch {
          // One member's device being briefly unreachable shouldn't abort sharing
          // with everyone else — swallowed, not thrown, same "best effort per
          // target" posture the call-signaling ICE loop already takes.
        }
      }
    },
    [],
  );

  const createAndShareNewOutboundSession = useCallback(
    async (groupId: string): Promise<GroupOutboundSession> => {
      const kek = getCurrentKek();
      if (!kek) throw new Error('This device is locked. Please sign in again.');
      const session = createOutboundGroupSession();
      await saveOutboundGroupSession(kek, groupId, session);
      const targets = await apiFetch<Array<{ userId: string; deviceId: string }>>(`/api/groups/${groupId}/member-devices`);
      // Epoch is server-side bookkeeping only (docs/05-crypto-architecture.md) — the
      // client doesn't need to track it precisely to redistribute correctly, since
      // inbound sessions key off sessionId, not epoch number. 0 here is just a
      // placeholder value carried along for observability.
      await shareSessionTo(groupId, 0, session, targets);
      return session;
    },
    [shareSessionTo],
  );

  const encryptForGroup = useCallback(
    async (groupId: string, plaintext: Uint8Array): Promise<EncryptedGroupEnvelope> => {
      return withGroupSessionLock(`outbound:${groupId}`, async () => {
        const kek = getCurrentKek();
        if (!kek) throw new Error('This device is locked. Please sign in again.');
        let session = await loadOutboundGroupSession(kek, groupId);
        if (!session) {
          session = await createAndShareNewOutboundSession(groupId);
        }
        // Mutates `session` in place (chainKey/counter advance) — same contract as
        // the 1:1 ratchet's encryptMessage; must be re-persisted after every call.
        const { header, ciphertext } = encryptGroupMessage(session, plaintext, associatedDataFor(groupId, currentUserId));
        await saveOutboundGroupSession(kek, groupId, session);
        return { header: bytesToBase64(encodeGroupHeader(header)), ciphertext: bytesToBase64(ciphertext) };
      });
    },
    [createAndShareNewOutboundSession, currentUserId, withGroupSessionLock],
  );

  const decryptGroupMessageUnmemoized = useCallback(
    async (groupId: string, senderUserId: string, envelope: EncryptedGroupEnvelope): Promise<Uint8Array> => {
      return withGroupSessionLock(`inbound:${groupId}:${senderUserId}`, async () => {
        const kek = getCurrentKek();
        if (!kek) throw new Error('This device is locked. Please sign in again.');
        const session = await loadInboundGroupSession(kek, groupId, senderUserId);
        if (!session) {
          throw new Error('No group session yet for this sender.');
        }
        const header = decodeGroupHeader(base64ToBytes(envelope.header));
        const plaintext = ratchetDecryptGroupMessage(session, header, base64ToBytes(envelope.ciphertext), associatedDataFor(groupId, senderUserId));
        await saveInboundGroupSession(kek, groupId, senderUserId, session);
        return plaintext;
      });
    },
    [withGroupSessionLock],
  );

  /**
   * A real bug found via live testing, the group-message analog of
   * `conversation-crypto.ts`'s `decryptFromDeviceOnce`: React 18/Next dev mode's
   * StrictMode double-invokes effects (mount → cleanup → mount again) specifically
   * to surface exactly this class of bug. `GroupMessageThread`'s mount-time catch-up
   * effect running twice meant the SAME group message got decrypted twice — the
   * first call correctly advances the one-way group ratchet past that message's
   * counter, so the second call legitimately fails ("this message key is no longer
   * available," by design — the ratchet has no way to know the two calls were for
   * the "same" logical decrypt rather than a genuine replay). The 1:1 path never hit
   * this because `decryptFromDeviceOnce` already memoized by message id; this is the
   * same fix, applied here. See docs/13-roadmap.md.
   */
  const inFlightGroupDecrypts = useRef<Map<string, Promise<Uint8Array>>>(new Map());
  const decryptGroupMessageOnce = useCallback(
    (messageId: string, groupId: string, senderUserId: string, envelope: EncryptedGroupEnvelope): Promise<Uint8Array> => {
      const existing = inFlightGroupDecrypts.current.get(messageId);
      if (existing) return existing;
      const promise = decryptGroupMessageUnmemoized(groupId, senderUserId, envelope);
      inFlightGroupDecrypts.current.set(messageId, promise);
      const evict = () => {
        setTimeout(() => {
          if (inFlightGroupDecrypts.current.get(messageId) === promise) inFlightGroupDecrypts.current.delete(messageId);
        }, 10_000);
      };
      promise.then(evict, evict);
      return promise;
    },
    [decryptGroupMessageUnmemoized],
  );

  const ensureGroupKeysUpToDate = useCallback(async (groupId: string): Promise<void> => {
    const kek = getCurrentKek();
    if (!kek) return;
    let shares: GroupKeyShareDto[];
    try {
      shares = await apiFetch<GroupKeyShareDto[]>(`/api/groups/${groupId}/key-shares`);
    } catch {
      return;
    }
    for (const share of shares) {
      try {
        // Rides the EXISTING 1:1 session between the sender's device and this one —
        // deduplicated the same way any other incoming message is (a key-share and a
        // chat message from the same sender device share one ratchet session, so
        // decryptFromDeviceOnce's per-message-id memoization applies identically).
        const plaintext = await decryptFromDeviceOnce(share.id, share.fromDeviceId, share.envelope, share.x3dhInit);
        const descriptor = JSON.parse(bytesToUtf8(plaintext)) as GroupSessionDescriptor;

        // Same lock key `decryptGroupMessageUnmemoized` uses for this (groupId,
        // senderUserId) pair — a key-share and an actual incoming message from that
        // same sender racing each other for the same inbound-session slot is exactly
        // the class of concurrent write this component's write race was about; both
        // paths have to serialize against each other, not just against themselves.
        await withGroupSessionLock(`inbound:${groupId}:${share.fromUserId}`, async () => {
          const existing = await loadInboundGroupSession(kek, groupId, share.fromUserId);
          if (existing && bytesToBase64(existing.sessionId) === descriptor.sessionId) {
            return; // already have this exact session (possibly further advanced) — never regress it
          }
          const inbound = createInboundGroupSession(base64ToBytes(descriptor.sessionId), base64ToBytes(descriptor.chainKey), descriptor.counter);
          await saveInboundGroupSession(kek, groupId, share.fromUserId, inbound);
        });
      } catch {
        // Skipped rather than aborting the rest of the batch, so one bad share
        // can't block every other pending one from being applied. Not a
        // recoverable gap once skipped, though: `GET /groups/:id/key-shares`
        // marks a row consumed the moment it's fetched (server/modules/groups/
        // key-share-service.ts), so a share that fails to apply here won't be
        // re-delivered — an honest limitation, same posture as the "skipped, not
        // shown as an error" framing message-thread.tsx already takes for an
        // undecryptable 1:1 message.
      }
    }
  }, [withGroupSessionLock]);

  const registerGroupMembership = useCallback(async (groupId: string): Promise<void> => {
    if (knownMembersRef.current.has(groupId)) return;
    try {
      const summary = await apiFetch<GroupSummary>(`/api/groups/${groupId}`);
      knownMembersRef.current.set(groupId, new Set(summary.members.map((m) => m.userId)));
    } catch {
      // Not (or no longer) a member, or a transient failure — nothing to seed;
      // the next successful call will seed it.
    }
  }, []);

  useEffect(() => {
    const offKeyShare = onRealtimeEvent('group.key-share', (payload) => {
      const groupId = payload.groupId as string;
      void ensureGroupKeysUpToDate(groupId);
    });

    const offMembersChanged = onRealtimeEvent('group.members-changed', (payload) => {
      const groupId = payload.groupId as string;
      void (async () => {
        const previous = knownMembersRef.current.get(groupId) ?? null;
        let summary: GroupSummary;
        try {
          summary = await apiFetch<GroupSummary>(`/api/groups/${groupId}`);
        } catch {
          // Most likely: this device's own membership was just removed — nothing to
          // redistribute since we can no longer participate.
          return;
        }
        const current = new Set(summary.members.map((m) => m.userId));
        knownMembersRef.current.set(groupId, current);
        if (!previous) return; // first observation — nothing to diff against yet

        const removed = [...previous].filter((id) => !current.has(id));
        const added = [...current].filter((id) => !previous.has(id) && id !== currentUserId);

        const kek = getCurrentKek();
        if (!kek) return;

        if (removed.length > 0) {
          // A member was removed — rotate to a fresh outbound session and
          // redistribute to everyone CURRENTLY in the group, excluding the removed
          // member from all future key distribution by construction (they simply
          // never receive this new session) — docs/05-crypto-architecture.md's
          // documented answer to "remove a member from a ratchet-encrypted group."
          await createAndShareNewOutboundSession(groupId);
        } else if (added.length > 0) {
          // A member was added — share the CURRENT session (not a new one) with only
          // the new member's device, going forward only (no retroactive history
          // access, per docs/05).
          const existing = await loadOutboundGroupSession(kek, groupId);
          if (!existing) return; // nothing sent yet in this group from this device
          const allTargets = await apiFetch<Array<{ userId: string; deviceId: string }>>(`/api/groups/${groupId}/member-devices`);
          const newTargets = allTargets.filter((t) => added.includes(t.userId));
          await shareSessionTo(groupId, 0, existing, newTargets);
        }
      })();
    });

    return () => {
      offKeyShare();
      offMembersChanged();
    };
  }, [currentUserId, ensureGroupKeysUpToDate, createAndShareNewOutboundSession, shareSessionTo]);

  const value: GroupSessionContextValue = {
    encryptForGroup,
    decryptGroupMessageOnce,
    ensureGroupKeysUpToDate,
    registerGroupMembership,
  };

  return <GroupSessionContext.Provider value={value}>{children}</GroupSessionContext.Provider>;
}
