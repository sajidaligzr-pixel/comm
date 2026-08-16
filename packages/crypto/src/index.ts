// Public API — apps/web imports from here, never reaching into individual
// submodules directly, so this file is the one place the package's external
// contract is defined (docs/01-folder-structure.md).

export { bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } from './encoding';

export {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  type IdentityKeyPair,
  type SignedPreKey,
  type OneTimePreKey,
} from './identity/keys';

export type { PublicKeyBundle } from './x3dh/x3dh';

export {
  createOutboundSession,
  createInboundSession,
  encryptMessage,
  decryptMessage,
  serializeSession,
  deserializeSession,
  type Session,
  type SerializedSession,
  type MessageEnvelope,
  type OutboundSessionResult,
} from './session/session';

export { deriveKek, generateKekSalt, KEK_SALT_LENGTH, KEK_LENGTH } from './storage/key-derivation';
export { wrapBytes, unwrapBytes } from './storage/wrap';
// Exposed for lib/crypto/biometric-unlock.ts — normalizes a WebAuthn PRF extension's
// raw output (whose exact byte length isn't itself part of the spec's guarantees)
// into a proper KEK_LENGTH-byte key via HKDF, the standard way to turn arbitrary
// input keying material into a well-distributed key of a specific size, rather than
// truncating/padding it by hand.
export { hkdfSha256 } from './primitives';

export {
  createOutboundGroupSession,
  createInboundGroupSession,
  encryptGroupMessage,
  decryptGroupMessage,
  encodeGroupHeader,
  decodeGroupHeader,
  MAX_SKIPPED_GROUP_MESSAGE_KEYS,
  type GroupOutboundSession,
  type GroupInboundSession,
  type GroupMessageHeader,
  type GroupEncryptResult,
} from './group/ratchet';
export {
  serializeGroupOutboundSession,
  deserializeGroupOutboundSession,
  serializeGroupInboundSession,
  deserializeGroupInboundSession,
  type SerializedGroupOutboundSession,
  type SerializedGroupInboundSession,
} from './group/serialization';
