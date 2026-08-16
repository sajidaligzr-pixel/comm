'use client';

/**
 * Per-remote-device Double Ratchet session storage — persisted across page loads so
 * a conversation doesn't have to re-run X3DH on every reload (docs/05-crypto-architecture.md).
 * Wrapped under the same local KEK as the device identity (identity.ts); the caller
 * supplies that KEK rather than this module re-deriving it, since a single unlock
 * per page-load should cover both.
 */
import { serializeSession, deserializeSession, wrapBytes, unwrapBytes, utf8ToBytes, bytesToUtf8, type Session } from '@comm/crypto';
import { putBlob, getBlob, deleteBlob } from './db';

function sessionStorageKey(remoteDeviceId: string): string {
  return `session:${remoteDeviceId}`;
}

export async function saveSession(kek: Uint8Array, remoteDeviceId: string, session: Session): Promise<void> {
  const json = JSON.stringify(serializeSession(session));
  const wrapped = wrapBytes(kek, utf8ToBytes(json));
  await putBlob(sessionStorageKey(remoteDeviceId), wrapped);
}

/**
 * A real, previously-unhandled bug found live: `unwrapBytes` throws (`"invalid
 * tag"`, an AEAD authentication failure) if `kek` doesn't match whatever key this
 * blob was wrapped under — which happens for real after a password change (a new
 * password derives a new KEK; a session cached under the old one is now permanently
 * unreadable with it) or any other local corruption. Without this try/catch, that
 * exception propagated straight out of `encryptForDevice`, permanently blocking
 * every future send to that one device with an opaque "invalid tag" error — the
 * session was gone either way, but the send path treated "can't read it" as fatal
 * instead of just falling back to establishing a fresh one, the same graceful
 * recovery `message-cache.ts#loadCachedMessages` already applies to the exact same
 * class of failure ("a KEK mismatch... is not a reason to crash the chat UI").
 * Returning `null` here does that: the caller's existing `if (!session)` branch
 * re-runs X3DH and starts a brand-new session, the only real fix once the old one
 * can't be decrypted — there is no way to recover the old ratchet state itself.
 */
export async function loadSession(kek: Uint8Array, remoteDeviceId: string): Promise<Session | null> {
  const wrapped = await getBlob(sessionStorageKey(remoteDeviceId));
  if (!wrapped) return null;
  try {
    const plaintext = unwrapBytes(kek, wrapped);
    return deserializeSession(JSON.parse(bytesToUtf8(plaintext)));
  } catch {
    return null;
  }
}

export async function deleteSession(remoteDeviceId: string): Promise<void> {
  await deleteBlob(sessionStorageKey(remoteDeviceId));
}
