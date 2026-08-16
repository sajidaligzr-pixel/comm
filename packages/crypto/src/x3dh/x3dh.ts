/**
 * X3DH (Extended Triple Diffie-Hellman), implemented to Signal's published
 * specification (https://signal.org/docs/specifications/x3dh/). This is the
 * asynchronous handshake that lets Alice start a session with Bob's device while
 * Bob is offline — see docs/05-crypto-architecture.md#session-establishment-1-1.
 * Produces the initial root key handed to ratchet/double-ratchet.ts's
 * `initRatchetAsSender`/`initRatchetAsReceiver`.
 */
import { generateX25519KeyPair, dh, hkdfSha256, verify, wipe, type KeyPair } from '../primitives';
import { concatBytes } from '../encoding';
import type { IdentityKeyPair, SignedPreKey, OneTimePreKey } from '../identity/keys';
import { initRatchetAsSender, initRatchetAsReceiver, type RatchetState } from '../ratchet/double-ratchet';

const X3DH_KDF_INFO = 'Comm_X3DH_v1';
// 32 bytes of 0xFF prepended to the DH outputs before the KDF, per the spec's
// recommendation (§2.2) — domain-separates X3DH-derived keys from any other use of
// HKDF over raw X25519 output in a way that doesn't depend on us getting every other
// domain-separation label right elsewhere; cheap insurance the spec asks for.
const X3DH_F = new Uint8Array(32).fill(0xff);

/** What a device publishes so others can start a session with it (docs/03-api-design.md's
 * `/keys/bundle/:userId/:deviceId`) — public material only. */
export interface PublicKeyBundle {
  identityAgreementKey: Uint8Array; // X25519 public
  identitySigningKey: Uint8Array; // Ed25519 public
  signedPreKeyId: number;
  signedPreKeyPublic: Uint8Array;
  signedPreKeySignature: Uint8Array;
  oneTimePreKeyId: number | null;
  oneTimePreKeyPublic: Uint8Array | null;
}

export interface X3dhInitiatorResult {
  ratchetState: RatchetState;
  associatedData: Uint8Array;
  /** What the initiator sends to the recipient alongside their first ratchet-encrypted
   * message, so the recipient can derive the same SK — docs/04-websocket-realtime.md's
   * message envelope carries this on the first message of a new session only. */
  initialMessage: {
    identityAgreementKey: Uint8Array;
    ephemeralKey: Uint8Array;
    usedSignedPreKeyId: number;
    usedOneTimePreKeyId: number | null;
  };
}

/**
 * Alice's side. Throws if the recipient's signed pre-key signature doesn't verify
 * against their identity key — this is the check that stops a malicious/compromised
 * server from substituting a key of its own into the bundle it relays
 * (docs/05-crypto-architecture.md's session-establishment step 3).
 */
export function initiateSession(ourIdentity: IdentityKeyPair, theirBundle: PublicKeyBundle): X3dhInitiatorResult {
  const signatureValid = verify(
    theirBundle.identitySigningKey,
    theirBundle.signedPreKeyPublic,
    theirBundle.signedPreKeySignature,
  );
  if (!signatureValid) {
    throw new Error('Signed pre-key signature is invalid — refusing to establish a session with this bundle.');
  }

  const ephemeral: KeyPair = generateX25519KeyPair();

  const dh1 = dh(ourIdentity.agreement.privateKey, theirBundle.signedPreKeyPublic);
  const dh2 = dh(ephemeral.privateKey, theirBundle.identityAgreementKey);
  const dh3 = dh(ephemeral.privateKey, theirBundle.signedPreKeyPublic);
  const dh4 = theirBundle.oneTimePreKeyPublic ? dh(ephemeral.privateKey, theirBundle.oneTimePreKeyPublic) : new Uint8Array(0);

  const ikm = concatBytes(X3DH_F, dh1, dh2, dh3, dh4);
  const sharedKey = hkdfSha256(ikm, new Uint8Array(32), X3DH_KDF_INFO, 32);

  // Initiator's identity goes first in the associated data, consistently on both
  // sides — see receiveSession's matching construction.
  const associatedData = concatBytes(ourIdentity.agreement.publicKey, theirBundle.identityAgreementKey);

  const ratchetState = initRatchetAsSender(sharedKey, theirBundle.signedPreKeyPublic);

  wipe(dh1);
  wipe(dh2);
  wipe(dh3);
  wipe(dh4);
  wipe(ikm);
  wipe(ephemeral.privateKey);

  return {
    ratchetState,
    associatedData,
    initialMessage: {
      identityAgreementKey: ourIdentity.agreement.publicKey,
      ephemeralKey: ephemeral.publicKey,
      usedSignedPreKeyId: theirBundle.signedPreKeyId,
      usedOneTimePreKeyId: theirBundle.oneTimePreKeyId,
    },
  };
}

export interface X3dhReceiverResult {
  ratchetState: RatchetState;
  associatedData: Uint8Array;
}

/**
 * Bob's side — called once, when the first message referencing a not-yet-established
 * session arrives. `ourOneTimePreKey` must be the specific one the initiator's
 * message says it used (looked up by id, then deleted by the caller after this
 * returns — one-time pre-keys are exactly that).
 */
export function receiveSession(
  ourIdentity: IdentityKeyPair,
  ourSignedPreKey: SignedPreKey,
  ourOneTimePreKey: OneTimePreKey | null,
  theirIdentityAgreementKey: Uint8Array,
  theirEphemeralKey: Uint8Array,
): X3dhReceiverResult {
  const dh1 = dh(ourSignedPreKey.keyPair.privateKey, theirIdentityAgreementKey);
  const dh2 = dh(ourIdentity.agreement.privateKey, theirEphemeralKey);
  const dh3 = dh(ourSignedPreKey.keyPair.privateKey, theirEphemeralKey);
  const dh4 = ourOneTimePreKey ? dh(ourOneTimePreKey.keyPair.privateKey, theirEphemeralKey) : new Uint8Array(0);

  const ikm = concatBytes(X3DH_F, dh1, dh2, dh3, dh4);
  const sharedKey = hkdfSha256(ikm, new Uint8Array(32), X3DH_KDF_INFO, 32);

  // Same order as initiateSession: initiator (them) first, responder (us) second.
  const associatedData = concatBytes(theirIdentityAgreementKey, ourIdentity.agreement.publicKey);

  const ratchetState = initRatchetAsReceiver(sharedKey, ourSignedPreKey.keyPair);

  wipe(dh1);
  wipe(dh2);
  wipe(dh3);
  wipe(dh4);
  wipe(ikm);
  if (ourOneTimePreKey) wipe(ourOneTimePreKey.keyPair.privateKey);

  return { ratchetState, associatedData };
}
