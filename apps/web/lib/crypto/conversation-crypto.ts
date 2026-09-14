'use client';

/**
 * Orchestrates per-remote-device session establishment/reuse for the chat UI —
 * "encrypt this outgoing message" / "decrypt this incoming one" without the caller
 * needing to know whether a Double Ratchet session already exists or a fresh X3DH
 * handshake is needed first. All actual cryptographic work is `@comm/crypto`'s;
 * this file is glue (fetch a bundle over HTTP, look up/persist session state in
 * IndexedDB, decide which path applies).
 */
import {
  createOutboundSession,
  createInboundSession,
  encryptMessage,
  decryptMessage,
  base64ToBytes,
  type MessageEnvelope,
  type PublicKeyBundle,
} from '@comm/crypto';
import type { KeyBundleResponse, X3dhInitPayload } from '@comm/types';
import { apiFetch } from '../api-client';
import { getCurrentIdentity, getCurrentKek } from './kek-holder';
import { loadSession, saveSession } from './sessions';
import { consumeOneTimePreKey, loadStoredIdentity } from './identity';

function requireUnlocked() {
  const identity = getCurrentIdentity();
  const kek = getCurrentKek();
  if (!identity || !kek) {
    throw new Error('Local keys are locked — sign in again on this device.');
  }
  return { identity, kek };
}

async function fetchRemoteBundle(userId: string, deviceId: string): Promise<PublicKeyBundle> {
  const res = await apiFetch<KeyBundleResponse>(`/api/keys/bundle/${userId}/${deviceId}`);
  return {
    identityAgreementKey: base64ToBytes(res.identityKey.agreementPublicKey),
    identitySigningKey: base64ToBytes(res.identityKey.signingPublicKey),
    signedPreKeyId: res.signedPreKey.keyId,
    signedPreKeyPublic: base64ToBytes(res.signedPreKey.publicKey),
    signedPreKeySignature: base64ToBytes(res.signedPreKey.signature),
    oneTimePreKeyId: res.oneTimePreKey?.keyId ?? null,
    oneTimePreKeyPublic: res.oneTimePreKey ? base64ToBytes(res.oneTimePreKey.publicKey) : null,
  };
}

export interface OutgoingCiphertext {
  envelope: MessageEnvelope;
  x3dhInit: X3dhInitPayload | null;
  /**
   * Set only when this call had to create a brand-new session (a fresh X3DH
   * handshake) rather than reuse an already-established one. The caller MUST
   * call this — and only this — AFTER the server has actually accepted the
   * message, and must simply drop it if the send failed.
   *
   * Found live (2026-09, a real stuck-forever conversation traced through
   * production data): this function used to persist a brand-new session
   * immediately, before the caller had sent anything over the network. When
   * that particular send subsequently failed to actually deliver, this
   * device's local session was already saved as if the handshake had
   * succeeded. Every later message to that recipient then looked like an
   * ordinary ratchet continuation (no `x3dhInit` — a session already existed),
   * which the recipient — who never actually received the real handshake —
   * has no way to make sense of. No self-heal was possible from either side:
   * the recipient's `decryptFromDevice` never re-examines `x3dhInit` once it
   * already has any cached session, and this device kept believing its side
   * was fine.
   *
   * Deferring persistence closes this at the source: if the send fails, this
   * device simply forgets the new session ever existed, and the NEXT attempt
   * starts over with a genuinely fresh X3DH handshake — carrying `x3dhInit`
   * again, exactly as a first attempt would. A session that already existed
   * before this call (a normal ratchet continuation) is unaffected — those
   * keep persisting immediately, same as always; Double Ratchet's own
   * skipped-message-key handling already tolerates an occasional lost
   * continuation message on a chain the recipient has already established.
   */
  confirmNewSession: (() => Promise<void>) | null;
}

/**
 * Encrypts `plaintext` for a specific recipient device — reuses the existing
 * ratchet session if one is already established with that device, otherwise runs
 * X3DH against its published key bundle first. An existing session's advanced
 * state is always re-persisted immediately; a brand-new session is NOT — see
 * `OutgoingCiphertext.confirmNewSession`'s own docstring for why, and call it
 * once the caller has confirmed this message actually made it to the server.
 */
export async function encryptForDevice(
  recipientUserId: string,
  recipientDeviceId: string,
  plaintext: Uint8Array,
): Promise<OutgoingCiphertext> {
  const { identity, kek } = requireUnlocked();

  let session = await loadSession(kek, recipientDeviceId);
  const isNewSession = !session;
  let x3dhInit: X3dhInitPayload | null = null;

  if (!session) {
    const bundle = await fetchRemoteBundle(recipientUserId, recipientDeviceId);
    const result = createOutboundSession(identity, bundle);
    session = result.session;
    x3dhInit = result.x3dhInit;
  }

  const envelope = encryptMessage(session, plaintext);
  if (isNewSession) {
    const establishedSession = session;
    return {
      envelope,
      x3dhInit,
      confirmNewSession: () => saveSession(kek, recipientDeviceId, establishedSession),
    };
  }
  await saveSession(kek, recipientDeviceId, session);
  return { envelope, x3dhInit, confirmNewSession: null };
}

async function bootstrapInboundSession(kek: Uint8Array, x3dhInit: X3dhInitPayload) {
  const localIdentity = await loadStoredIdentity(kek);
  if (!localIdentity) {
    throw new Error('Local identity is not available.');
  }
  const oneTimePreKey = await consumeOneTimePreKey(kek, x3dhInit.usedOneTimePreKeyId);
  return createInboundSession(localIdentity.identity, localIdentity.signedPreKey, oneTimePreKey, {
    identityAgreementKey: x3dhInit.identityAgreementKey,
    ephemeralKey: x3dhInit.ephemeralKey,
    usedSignedPreKeyId: x3dhInit.usedSignedPreKeyId,
    usedOneTimePreKeyId: x3dhInit.usedOneTimePreKeyId,
  });
}

/**
 * Decrypts an incoming envelope from `senderDeviceId`. If no session exists yet and
 * the message carries `x3dhInit`, establishes the inbound session first (consuming
 * this device's matching one-time pre-key, if the sender's message used one — see
 * identity.ts's `consumeOneTimePreKey`). Throws if there's no session AND no
 * `x3dhInit` to bootstrap one from — a message that should never occur from a
 * correctly-behaving sender.
 *
 * Self-heals a stale/wrong cached session: if a session already exists but fails to
 * decrypt this envelope, and the message carries `x3dhInit` anyway, that's the
 * sender telling us (whether it knows it or not) that IT thinks this is a fresh
 * handshake — re-bootstrap from that instead of giving up. Ordinarily a healthy
 * sender only attaches `x3dhInit` on the very first message of a session and never
 * again, so this branch costs nothing in the common case (the cached session
 * decrypts fine, `x3dhInit` is simply ignored). It matters for exactly the failure
 * mode `encryptForDevice`'s `confirmNewSession` docstring describes: this device's
 * cached session for that sender is the STALE side of a desync neither end can see
 * on its own. Previously the only way out was clearing this browser's local data
 * entirely (or the mobile equivalent, uninstalling and reinstalling) — which
 * "fixes" it only because that wipes local storage entirely, forcing a fresh
 * handshake with literally everyone. This is the same recovery, scoped to just the
 * one sender who actually needs it, and it now happens automatically the next time
 * they message us on a genuinely fresh session.
 */
export async function decryptFromDevice(
  senderDeviceId: string,
  envelope: MessageEnvelope,
  x3dhInit: X3dhInitPayload | null,
): Promise<Uint8Array> {
  const { kek } = requireUnlocked();

  let session = await loadSession(kek, senderDeviceId);

  if (!session) {
    if (!x3dhInit) {
      throw new Error('No existing session for this sender, and no session-establishment data on this message.');
    }
    session = await bootstrapInboundSession(kek, x3dhInit);
  } else if (x3dhInit) {
    try {
      const plaintext = decryptMessage(session, envelope);
      await saveSession(kek, senderDeviceId, session);
      return plaintext;
    } catch {
      session = await bootstrapInboundSession(kek, x3dhInit);
    }
  }

  const plaintext = decryptMessage(session, envelope);
  await saveSession(kek, senderDeviceId, session);
  return plaintext;
}

/**
 * A latent concurrency issue identified via code review while stress-testing the
 * calling/voice feature set (a live-test failure that morning turned out to have a
 * different, mundane cause — a malformed test-harness flag — but reading this path
 * closely afterward to rule it out surfaced a real, separate structural race worth
 * closing regardless): `chats-shell.tsx`'s sidebar-preview path and
 * `message-thread.tsx`'s own catch-up/live paths can both end up decrypting the SAME
 * incoming message — a message arrives while a user is on the plain `/chats` list
 * (no thread open), the sidebar starts decrypting it, and the user taps into that
 * conversation's thread *before* the sidebar's decrypt+cache-write has finished.
 * `MessageThread`'s own mount-time catch-up sees the message not yet in its local
 * cache (the sidebar's write hasn't landed yet) and starts a SECOND, concurrent
 * `decryptFromDevice` call for the exact same ciphertext. For the first message of a
 * brand-new session this would be actively destructive, not just wasteful: both
 * calls would race on `loadSession`/`consumeOneTimePreKey`/`saveSession` (see
 * `decryptFromDevice` above), and the loser could derive a different X3DH shared
 * secret (e.g. if its one-time-prekey lookup lost the race to the winner's) and
 * decrypt into garbage.
 *
 * The fix: memoize in-flight (and briefly, resolved) decrypts by the message's own
 * id — a client-generated UUID, globally unique — so no matter how many call sites
 * race to decrypt the same message, `decryptFromDevice` itself only ever actually
 * runs once. Every call site that decrypts an incoming message (chats-shell.tsx,
 * message-thread.tsx — 4 call sites total) MUST go through this, not
 * `decryptFromDevice` directly.
 */
const inFlightDecrypts = new Map<string, Promise<Uint8Array>>();
const DECRYPT_MEMO_TTL_MS = 10_000; // covers the race window, not meant to persist

export function decryptFromDeviceOnce(
  messageId: string,
  senderDeviceId: string,
  envelope: MessageEnvelope,
  x3dhInit: X3dhInitPayload | null,
): Promise<Uint8Array> {
  const existing = inFlightDecrypts.get(messageId);
  if (existing) return existing;

  const promise = decryptFromDevice(senderDeviceId, envelope, x3dhInit);
  inFlightDecrypts.set(messageId, promise);
  // Settle either way, then evict after a short delay — long enough to catch any
  // near-concurrent duplicate call for the same message, short enough not to leak
  // memory over a long-running tab (IndexedDB, via appendCachedMessage, is the real
  // durable idempotency guard beyond this window). `.then(cb, cb)` rather than
  // `.finally(cb)` deliberately — `.finally` returns a new promise that re-rejects on
  // failure, which nothing here would handle, producing a spurious unhandled-rejection
  // warning; `.then(onFulfilled, onRejected)` fully settles either branch itself.
  const scheduleEviction = () => {
    setTimeout(() => {
      if (inFlightDecrypts.get(messageId) === promise) inFlightDecrypts.delete(messageId);
    }, DECRYPT_MEMO_TTL_MS);
  };
  promise.then(scheduleEviction, scheduleEviction);
  return promise;
}
