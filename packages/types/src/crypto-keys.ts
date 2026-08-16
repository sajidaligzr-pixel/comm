import { z } from 'zod';

/**
 * Public key material travels as base64 over the wire. This module only shapes and
 * bounds-checks that transport encoding — it never touches private keys, and it does
 * not implement any cryptographic operation itself. See packages/crypto for the
 * actual key generation/session/X3DH code, and docs/05-crypto-architecture.md for
 * why the server only ever stores/relays these public values.
 */
const Base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+=*$/, 'Must be base64-encoded.')
  .max(4096, 'Key material exceeds the expected size for a public key/signature.');

/**
 * Two public keys, not one — Ed25519 for signing (verifies signed pre-keys) and
 * X25519 for Diffie-Hellman agreement (X3DH's DH1 step), per
 * docs/05-crypto-architecture.md's identity-key design. Distinct from the Phase 2
 * placeholder, which uploaded a single ECDSA key purely to exercise this pipeline
 * before real crypto existed.
 */
export const IdentityKeyUpload = z.object({
  signingPublicKey: Base64,
  agreementPublicKey: Base64,
});
export type IdentityKeyUpload = z.infer<typeof IdentityKeyUpload>;

export const SignedPreKeyUpload = z.object({
  keyId: z.number().int().nonnegative(),
  publicKey: Base64,
  signature: Base64,
});
export type SignedPreKeyUpload = z.infer<typeof SignedPreKeyUpload>;

export const OneTimePreKeyUpload = z.object({
  keyId: z.number().int().nonnegative(),
  publicKey: Base64,
});
export type OneTimePreKeyUpload = z.infer<typeof OneTimePreKeyUpload>;

/**
 * What a device submits at registration time (invite redemption, login from a new
 * device, or device-linking completion — see docs/06-device-architecture.md).
 */
export const DeviceKeyBundle = z.object({
  identityKey: IdentityKeyUpload,
  signedPreKey: SignedPreKeyUpload,
  oneTimePreKeys: z.array(OneTimePreKeyUpload).max(200).default([]),
});
export type DeviceKeyBundle = z.infer<typeof DeviceKeyBundle>;

/**
 * What `GET /keys/bundle/:userId/:deviceId` returns — a stranger's public key
 * material, enough for `packages/crypto`'s `createOutboundSession` to run X3DH
 * against. `oneTimePreKey` is null once a device's pool is exhausted (X3DH's
 * documented fallback — docs/05-crypto-architecture.md).
 */
export const KeyBundleResponse = z.object({
  identityKey: IdentityKeyUpload,
  signedPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: Base64,
    signature: Base64,
  }),
  oneTimePreKey: z
    .object({
      keyId: z.number().int().nonnegative(),
      publicKey: Base64,
    })
    .nullable(),
});
export type KeyBundleResponse = z.infer<typeof KeyBundleResponse>;

/** `POST /api/keys/signed-prekey` — a device rotating its own signed pre-key. */
export const UploadSignedPreKeyRequest = SignedPreKeyUpload;
export type UploadSignedPreKeyRequest = z.infer<typeof UploadSignedPreKeyRequest>;

/** `POST /api/keys/one-time-prekeys` — a device topping its own pool back up. */
export const UploadOneTimePreKeysRequest = z.object({
  oneTimePreKeys: z.array(OneTimePreKeyUpload).min(1).max(200),
});
export type UploadOneTimePreKeysRequest = z.infer<typeof UploadOneTimePreKeysRequest>;

export const OneTimePreKeyCountResponse = z.object({ remaining: z.number().int().nonnegative() });
export type OneTimePreKeyCountResponse = z.infer<typeof OneTimePreKeyCountResponse>;
