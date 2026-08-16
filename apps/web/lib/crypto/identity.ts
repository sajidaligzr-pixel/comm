'use client';

/**
 * Client-side device identity: generation, password-protected local storage, and
 * unlock. This is what replaced the old Phase 2 placeholder — see
 * docs/05-crypto-architecture.md's status note. Real key generation happens here via
 * `@comm/crypto`; this file's own job is orchestration (generate → wrap under the
 * password-derived KEK → store) and never invents any cryptographic operation of its
 * own — every actual crypto call is a re-export from `@comm/crypto`.
 */
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  deriveKek,
  generateKekSalt,
  wrapBytes,
  unwrapBytes,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
  bytesToUtf8,
  type IdentityKeyPair,
  type SignedPreKey,
  type OneTimePreKey,
} from '@comm/crypto';
import type { DeviceKeyBundle } from '@comm/types';
import { putBlob, getBlob, deleteBlob } from './db';

const SALT_KEY = 'kek-salt';
const IDENTITY_KEY = 'identity-bundle';

/** How many one-time pre-keys a fresh device generates up front — see
 * docs/03-api-design.md's key-claim rate-limit note; a device tops this pool back up
 * later via the /keys routes (Phase 3 doesn't yet wire that top-up, tracked as a
 * follow-up alongside signed-prekey rotation). */
const INITIAL_ONE_TIME_PREKEY_COUNT = 20;

interface StoredIdentityBundle {
  identity: {
    signingPrivateKey: string;
    signingPublicKey: string;
    agreementPrivateKey: string;
    agreementPublicKey: string;
  };
  signedPreKey: { keyId: number; privateKey: string; publicKey: string; signature: string };
  oneTimePreKeys: Array<{ keyId: number; privateKey: string; publicKey: string }>;
}

function toStored(identity: IdentityKeyPair, signedPreKey: SignedPreKey, oneTimePreKeys: OneTimePreKey[]): StoredIdentityBundle {
  return {
    identity: {
      signingPrivateKey: bytesToBase64(identity.signing.privateKey),
      signingPublicKey: bytesToBase64(identity.signing.publicKey),
      agreementPrivateKey: bytesToBase64(identity.agreement.privateKey),
      agreementPublicKey: bytesToBase64(identity.agreement.publicKey),
    },
    signedPreKey: {
      keyId: signedPreKey.keyId,
      privateKey: bytesToBase64(signedPreKey.keyPair.privateKey),
      publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
      signature: bytesToBase64(signedPreKey.signature),
    },
    oneTimePreKeys: oneTimePreKeys.map((k) => ({
      keyId: k.keyId,
      privateKey: bytesToBase64(k.keyPair.privateKey),
      publicKey: bytesToBase64(k.keyPair.publicKey),
    })),
  };
}

export interface LocalIdentity {
  identity: IdentityKeyPair;
  signedPreKey: SignedPreKey;
  oneTimePreKeys: OneTimePreKey[];
}

function fromStored(stored: StoredIdentityBundle): LocalIdentity {
  return {
    identity: {
      signing: {
        privateKey: base64ToBytes(stored.identity.signingPrivateKey),
        publicKey: base64ToBytes(stored.identity.signingPublicKey),
      },
      agreement: {
        privateKey: base64ToBytes(stored.identity.agreementPrivateKey),
        publicKey: base64ToBytes(stored.identity.agreementPublicKey),
      },
    },
    signedPreKey: {
      keyId: stored.signedPreKey.keyId,
      keyPair: {
        privateKey: base64ToBytes(stored.signedPreKey.privateKey),
        publicKey: base64ToBytes(stored.signedPreKey.publicKey),
      },
      signature: base64ToBytes(stored.signedPreKey.signature),
    },
    oneTimePreKeys: stored.oneTimePreKeys.map((k) => ({
      keyId: k.keyId,
      keyPair: { privateKey: base64ToBytes(k.privateKey), publicKey: base64ToBytes(k.publicKey) },
    })),
  };
}

export async function hasLocalIdentity(): Promise<boolean> {
  return (await getBlob(IDENTITY_KEY)) !== null;
}

/**
 * Generates a brand-new device identity and stores it locally, wrapped under a key
 * derived from the account password (docs/05-crypto-architecture.md#local-key-storage).
 * Returns the public `DeviceKeyBundle` to upload via invite-redeem/login/device-link.
 * Called exactly once per device, at the moment that device is first registered.
 */
export async function createLocalIdentity(
  password: string,
): Promise<{ keyBundle: DeviceKeyBundle; kek: Uint8Array; identity: IdentityKeyPair }> {
  const identity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKey(identity.signing.privateKey, 1);
  const oneTimePreKeys = generateOneTimePreKeys(INITIAL_ONE_TIME_PREKEY_COUNT, 1);

  const salt = generateKekSalt();
  const kek = await deriveKek(password, salt);
  const wrapped = wrapBytes(kek, utf8ToBytes(JSON.stringify(toStored(identity, signedPreKey, oneTimePreKeys))));

  await putBlob(SALT_KEY, salt);
  await putBlob(IDENTITY_KEY, wrapped);

  const keyBundle: DeviceKeyBundle = {
    identityKey: {
      signingPublicKey: bytesToBase64(identity.signing.publicKey),
      agreementPublicKey: bytesToBase64(identity.agreement.publicKey),
    },
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
      signature: bytesToBase64(signedPreKey.signature),
    },
    oneTimePreKeys: oneTimePreKeys.map((k) => ({ keyId: k.keyId, publicKey: bytesToBase64(k.keyPair.publicKey) })),
  };

  return { keyBundle, kek, identity };
}

/**
 * Unlocks the already-stored identity on a device that's logging back in — the
 * normal path for every login after the first, on the same browser. Returns `null`
 * on a wrong password (KEK derives to the wrong value, AEAD tag fails to verify —
 * `unwrapBytes` throws, caught here rather than propagated, since "wrong password"
 * is an expected outcome here, not a program error) or if nothing is stored yet
 * (a device that's never completed identity creation on this browser).
 */
export async function unlockLocalIdentity(password: string): Promise<(LocalIdentity & { kek: Uint8Array }) | null> {
  const salt = await getBlob(SALT_KEY);
  const wrapped = await getBlob(IDENTITY_KEY);
  if (!salt || !wrapped) return null;

  const kek = await deriveKek(password, salt);
  let plaintext: Uint8Array;
  try {
    plaintext = unwrapBytes(kek, wrapped);
  } catch {
    return null;
  } 

  return { ...fromStored(JSON.parse(bytesToUtf8(plaintext)) as StoredIdentityBundle), kek };
}

/**
 * Re-reads the current local identity (identity keys + current signed pre-key) using
 * an ALREADY-derived KEK — no Argon2id re-derivation, unlike `unlockLocalIdentity`.
 * Used mid-session (e.g. establishing an inbound X3DH session against an incoming
 * message) where the KEK is already sitting in `kek-holder.ts`'s memory and
 * re-running the password-hashing cost on every incoming message would be wasteful.
 */
export async function loadStoredIdentity(kek: Uint8Array): Promise<LocalIdentity | null> {
  const wrapped = await getBlob(IDENTITY_KEY);
  if (!wrapped) return null;
  const plaintext = unwrapBytes(kek, wrapped);
  return fromStored(JSON.parse(bytesToUtf8(plaintext)) as StoredIdentityBundle);
}

/** Called on logout/device revoke — see docs/32-local-data-storage.md's "clear
 * sensitive temporary data" rule. */
export async function wipeLocalIdentity(): Promise<void> {
  await deleteBlob(SALT_KEY);
  await deleteBlob(IDENTITY_KEY);
}

/**
 * Finds this device's own one-time pre-key by id (received in an incoming message's
 * `x3dhInit.usedOneTimePreKeyId`) and removes it from local storage — one-time
 * pre-keys are exactly that, so once consumed here for X3DH's DH4 step it must never
 * be reachable again, matching the server's own `claimed_at` enforcement
 * (docs/05-crypto-architecture.md). Returns `null` if `keyId` is `null` (the sender's
 * bundle had no unclaimed one-time pre-key available — X3DH's documented fallback,
 * not an error) or if this device has no record of that key at all (shouldn't
 * happen in normal operation; treated the same as "no key" rather than throwing, so
 * a single inconsistent key doesn't block session establishment outright).
 */
export async function consumeOneTimePreKey(kek: Uint8Array, keyId: number | null): Promise<OneTimePreKey | null> {
  if (keyId === null) return null;

  const wrapped = await getBlob(IDENTITY_KEY);
  if (!wrapped) return null;
  const stored = JSON.parse(bytesToUtf8(unwrapBytes(kek, wrapped))) as StoredIdentityBundle;

  const index = stored.oneTimePreKeys.findIndex((k) => k.keyId === keyId);
  if (index === -1) return null;

  const [consumed] = stored.oneTimePreKeys.splice(index, 1);
  const rewrapped = wrapBytes(kek, utf8ToBytes(JSON.stringify(stored)));
  await putBlob(IDENTITY_KEY, rewrapped);

  return {
    keyId: consumed!.keyId,
    keyPair: { privateKey: base64ToBytes(consumed!.privateKey), publicKey: base64ToBytes(consumed!.publicKey) },
  };
}
