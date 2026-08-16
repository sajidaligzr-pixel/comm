'use client';

/**
 * Local storage for group ratchet state (docs/13-roadmap.md's group chat pass,
 * docs/05-crypto-architecture.md#group-encryption) — the client-side counterpart to
 * `sessions.ts`'s 1:1 session storage, same KEK-wrapped IndexedDB pattern.
 *
 * One OUTBOUND session per group this device is a member of (the chain IT advances
 * when sending). One INBOUND session per *other member* per group (the chain that
 * member's own outbound session produces) — keyed by `(groupId, senderUserId)`, not
 * by device, since group key distribution targets whichever of a member's devices is
 * primary but the resulting inbound ratchet state belongs to the sender's identity,
 * not a specific device.
 */
import {
  serializeGroupOutboundSession,
  deserializeGroupOutboundSession,
  serializeGroupInboundSession,
  deserializeGroupInboundSession,
  wrapBytes,
  unwrapBytes,
  utf8ToBytes,
  bytesToUtf8,
  type GroupOutboundSession,
  type GroupInboundSession,
} from '@comm/crypto';
import { putBlob, getBlob } from './db';

function outboundKey(groupId: string): string {
  return `group-outbound:${groupId}`;
}

function inboundKey(groupId: string, senderUserId: string): string {
  return `group-inbound:${groupId}:${senderUserId}`;
}

export async function saveOutboundGroupSession(kek: Uint8Array, groupId: string, session: GroupOutboundSession): Promise<void> {
  const json = JSON.stringify(serializeGroupOutboundSession(session));
  await putBlob(outboundKey(groupId), wrapBytes(kek, utf8ToBytes(json)));
}

/** Returns `null` (not a thrown error) if `unwrapBytes` fails — see
 * `sessions.ts#loadSession`'s docstring for why: a KEK mismatch (a password change,
 * most concretely) leaves an old cached session permanently unreadable, and the
 * correct recovery is the caller starting a fresh one, not a crashed send. */
export async function loadOutboundGroupSession(kek: Uint8Array, groupId: string): Promise<GroupOutboundSession | null> {
  const wrapped = await getBlob(outboundKey(groupId));
  if (!wrapped) return null;
  try {
    return deserializeGroupOutboundSession(JSON.parse(bytesToUtf8(unwrapBytes(kek, wrapped))));
  } catch {
    return null;
  }
}

export async function saveInboundGroupSession(
  kek: Uint8Array,
  groupId: string,
  senderUserId: string,
  session: GroupInboundSession,
): Promise<void> {
  const json = JSON.stringify(serializeGroupInboundSession(session));
  await putBlob(inboundKey(groupId, senderUserId), wrapBytes(kek, utf8ToBytes(json)));
}

/** Same "return null, don't throw" reasoning as `loadOutboundGroupSession` above. */
export async function loadInboundGroupSession(
  kek: Uint8Array,
  groupId: string,
  senderUserId: string,
): Promise<GroupInboundSession | null> {
  const wrapped = await getBlob(inboundKey(groupId, senderUserId));
  if (!wrapped) return null;
  try {
    return deserializeGroupInboundSession(JSON.parse(bytesToUtf8(unwrapBytes(kek, wrapped))));
  } catch {
    return null;
  }
}
