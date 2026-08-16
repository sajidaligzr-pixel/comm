/**
 * The high-level API `apps/web`'s client code actually calls — everything else in
 * this package is the implementation those calls are built on. Combines X3DH session
 * establishment with the Double Ratchet into "create a session with this bundle" /
 * "encrypt this message" / "decrypt this envelope", and handles turning ratchet
 * state into something JSON-safe to persist between messages.
 */
import { initiateSession, receiveSession, type PublicKeyBundle } from '../x3dh/x3dh';
import { ratchetEncrypt, ratchetDecrypt, encodeHeader, decodeHeader, type RatchetState } from '../ratchet/double-ratchet';
import { serializeRatchetState, deserializeRatchetState, type SerializedRatchetState } from './serialization';
import { bytesToBase64, base64ToBytes } from '../encoding';
import type { IdentityKeyPair, SignedPreKey, OneTimePreKey } from '../identity/keys';

export interface Session {
  ratchetState: RatchetState;
  associatedData: Uint8Array;
}

/** JSON-safe form for IndexedDB storage (wrap/unwrap under the local KEK before
 * persisting — see storage/wrap.ts; this module doesn't do that itself, callers do,
 * so this stays a pure data-shape concern). */
export interface SerializedSession {
  ratchetState: SerializedRatchetState;
  associatedData: string; // base64
}

export function serializeSession(session: Session): SerializedSession {
  return {
    ratchetState: serializeRatchetState(session.ratchetState),
    associatedData: bytesToBase64(session.associatedData),
  };
}

export function deserializeSession(serialized: SerializedSession): Session {
  return {
    ratchetState: deserializeRatchetState(serialized.ratchetState),
    associatedData: base64ToBytes(serialized.associatedData),
  };
}

export interface OutboundSessionResult {
  session: Session;
  /** Carried alongside only the FIRST message sent on this session — the recipient
   * needs it to derive the matching session via `createInboundSession`. Every
   * subsequent message on the same session omits this. */
  x3dhInit: {
    identityAgreementKey: string;
    ephemeralKey: string;
    usedSignedPreKeyId: number;
    usedOneTimePreKeyId: number | null;
  };
}

/** Alice's side — call once per (our device, their device) pair, the first time we
 * ever message that device. `theirBundle` comes from `GET /keys/bundle/:userId/:deviceId`
 * (docs/03-api-design.md). */
export function createOutboundSession(ourIdentity: IdentityKeyPair, theirBundle: PublicKeyBundle): OutboundSessionResult {
  const result = initiateSession(ourIdentity, theirBundle);
  return {
    session: { ratchetState: result.ratchetState, associatedData: result.associatedData },
    x3dhInit: {
      identityAgreementKey: bytesToBase64(result.initialMessage.identityAgreementKey),
      ephemeralKey: bytesToBase64(result.initialMessage.ephemeralKey),
      usedSignedPreKeyId: result.initialMessage.usedSignedPreKeyId,
      usedOneTimePreKeyId: result.initialMessage.usedOneTimePreKeyId,
    },
  };
}

/** Bob's side — call once, when a message carrying `x3dhInit` arrives for a session
 * we don't already have. `ourOneTimePreKey` must be looked up locally by the id in
 * `x3dhInit.usedOneTimePreKeyId` (or `null` if that field is `null`) and deleted
 * immediately after this call — see identity/keys.ts's one-time-pre-key note. */
export function createInboundSession(
  ourIdentity: IdentityKeyPair,
  ourSignedPreKey: SignedPreKey,
  ourOneTimePreKey: OneTimePreKey | null,
  x3dhInit: OutboundSessionResult['x3dhInit'],
): Session {
  const result = receiveSession(
    ourIdentity,
    ourSignedPreKey,
    ourOneTimePreKey,
    base64ToBytes(x3dhInit.identityAgreementKey),
    base64ToBytes(x3dhInit.ephemeralKey),
  );
  return { ratchetState: result.ratchetState, associatedData: result.associatedData };
}

export interface MessageEnvelope {
  header: string; // base64(40-byte encoded ratchet header)
  ciphertext: string; // base64
}

/** Mutates `session.ratchetState` in place (advances the sending chain) — callers
 * MUST re-persist the session (serializeSession → wrap → IndexedDB) after this
 * returns, or a later message will re-derive from stale state and desync from the
 * recipient. */
export function encryptMessage(session: Session, plaintext: Uint8Array): MessageEnvelope {
  const { header, ciphertext } = ratchetEncrypt(session.ratchetState, plaintext, session.associatedData);
  return { header: bytesToBase64(encodeHeader(header)), ciphertext: bytesToBase64(ciphertext) };
}

/** Same persist-after-calling requirement as `encryptMessage` — decrypting also
 * advances ratchet state (and may perform a DH ratchet step). Throws on tamper or
 * an undecryptable message (docs/12-testing-strategy.md's tamper-detection case) —
 * never returns corrupted plaintext. */
export function decryptMessage(session: Session, envelope: MessageEnvelope): Uint8Array {
  const header = decodeHeader(base64ToBytes(envelope.header));
  const ciphertext = base64ToBytes(envelope.ciphertext);
  return ratchetDecrypt(session.ratchetState, header, ciphertext, session.associatedData);
}
