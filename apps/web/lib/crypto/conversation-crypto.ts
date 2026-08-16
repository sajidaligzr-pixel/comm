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
}

/**
 * Encrypts `plaintext` for a specific recipient device — reuses the existing
 * ratchet session if one is already established with that device, otherwise runs
 * X3DH against its published key bundle first. Session state is always
 * re-persisted after this call (the ratchet advanced), even on the very first
 * message of a new session.
 */
export async function encryptForDevice(
  recipientUserId: string,
  recipientDeviceId: string,
  plaintext: Uint8Array,
): Promise<OutgoingCiphertext> {
  const { identity, kek } = requireUnlocked();

  let session = await loadSession(kek, recipientDeviceId);
  let x3dhInit: X3dhInitPayload | null = null;

  if (!session) {
    const bundle = await fetchRemoteBundle(recipientUserId, recipientDeviceId);
    const result = createOutboundSession(identity, bundle);
    session = result.session;
    x3dhInit = result.x3dhInit;
  }

  const envelope = encryptMessage(session, plaintext);
  await saveSession(kek, recipientDeviceId, session);
  return { envelope, x3dhInit };
}

/**
 * Decrypts an incoming envelope from `senderDeviceId`. If no session exists yet and
 * the message carries `x3dhInit`, establishes the inbound session first (consuming
 * this device's matching one-time pre-key, if the sender's message used one — see
 * identity.ts's `consumeOneTimePreKey`). Throws if there's no session AND no
 * `x3dhInit` to bootstrap one from — a message that should never occur from a
 * correctly-behaving sender.
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
    const localIdentity = await loadStoredIdentity(kek);
    if (!localIdentity) {
      throw new Error('Local identity is not available.');
    }
    const oneTimePreKey = await consumeOneTimePreKey(kek, x3dhInit.usedOneTimePreKeyId);
    session = createInboundSession(localIdentity.identity, localIdentity.signedPreKey, oneTimePreKey, {
      identityAgreementKey: x3dhInit.identityAgreementKey,
      ephemeralKey: x3dhInit.ephemeralKey,
      usedSignedPreKeyId: x3dhInit.usedSignedPreKeyId,
      usedOneTimePreKeyId: x3dhInit.usedOneTimePreKeyId,
    });
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
