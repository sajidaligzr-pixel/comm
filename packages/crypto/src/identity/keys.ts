import { generateEd25519KeyPair, generateX25519KeyPair, sign, type KeyPair } from '../primitives';

/**
 * The identity key is a **pair of key pairs** — one Ed25519 (signing) and one X25519
 * (Diffie-Hellman) — rather than a single Curve25519 key reused for both via XEdDSA
 * conversion. The X3DH spec explicitly allows either approach (§2.1: "if it's not
 * important to save the extra 32 bytes... using distinct signing and DH keys is
 * simpler"); distinct keys avoid needing an Edwards↔Montgomery conversion step in
 * this codebase, at the cost of an extra 32 public + 32 private bytes per identity —
 * a rounding error against everything else this system already stores per device.
 */
export interface IdentityKeyPair {
  signing: KeyPair; // Ed25519 — signs signed-prekeys, verified by peers before trusting them
  agreement: KeyPair; // X25519 — used directly in X3DH's DH1 step
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  return {
    signing: generateEd25519KeyPair(),
    agreement: generateX25519KeyPair(),
  };
}

export interface SignedPreKey {
  keyId: number;
  keyPair: KeyPair; // X25519
  signature: Uint8Array; // Ed25519 signature over keyPair.publicKey, by the identity signing key
}

/**
 * Rotated periodically by the client (docs/05-crypto-architecture.md's key
 * hierarchy) — a fresh one replaces the old, the old is kept server-side briefly for
 * sessions already in flight, then garbage-collected (server-side concern, not this
 * package's).
 */
export function generateSignedPreKey(identitySigningPrivateKey: Uint8Array, keyId: number): SignedPreKey {
  const keyPair = generateX25519KeyPair();
  const signature = sign(identitySigningPrivateKey, keyPair.publicKey);
  return { keyId, keyPair, signature };
}

export interface OneTimePreKey {
  keyId: number;
  keyPair: KeyPair; // X25519
}

/**
 * Each one-time pre-key is consumed exactly once by whoever claims it first (server
 * enforces this via `one_time_pre_keys.claimed_at`, docs/02-database-schema.md) —
 * this function just generates a batch; the caller is responsible for keeping the
 * private halves until used and then deleting them (see session/session.ts's
 * inbound-session handling, which deletes the matching private key immediately
 * after a successful X3DH derivation).
 */
export function generateOneTimePreKeys(count: number, startKeyId: number): OneTimePreKey[] {
  return Array.from({ length: count }, (_, i) => ({
    keyId: startKeyId + i,
    keyPair: generateX25519KeyPair(),
  }));
}
