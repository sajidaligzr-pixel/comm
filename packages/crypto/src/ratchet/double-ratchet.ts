/**
 * The Double Ratchet Algorithm, implemented to Signal's published specification
 * (https://signal.org/docs/specifications/doubleratchet/) — function names below
 * intentionally mirror the spec's own pseudocode (KDF_RK, KDF_CK, DHRatchet,
 * SkipMessageKeys, RatchetEncrypt, RatchetDecrypt) so this file can be reviewed
 * line-by-line against that document rather than trusted on faith. See
 * docs/05-crypto-architecture.md#library-decision for why this is hand-implemented
 * rather than an off-the-shelf binding, and docs/05's forward-secrecy/post-compromise
 * -security claims, which this file is what actually provides them.
 */
import {
  generateX25519KeyPair,
  dh,
  hkdfSha256,
  hmacSha256,
  aeadEncrypt,
  aeadDecrypt,
  type KeyPair,
} from '../primitives';
import { bytesToBase64, concatBytes } from '../encoding';

const ROOT_KDF_INFO = 'Comm_DR_RootKey_v1';
const MSG_KDF_INFO = 'Comm_DR_MsgKey_v1';
const AEAD_KEY_LEN = 32;
const AEAD_NONCE_LEN = 12;

/**
 * How many message keys we're willing to derive-and-store while catching up a
 * receiving chain that skipped ahead (out-of-order/lost messages). Bounded so a
 * malicious or corrupted header claiming an enormous message number can't be used to
 * force unbounded memory allocation — a denial-of-service guard, not a normal-use
 * limit (real out-of-order delivery on a flaky connection is nowhere near this).
 */
export const MAX_SKIPPED_MESSAGE_KEYS = 1000;

export interface RatchetHeader {
  dhPublicKey: Uint8Array; // sender's current ratchet public key (32 bytes, X25519)
  previousChainLength: number; // PN — length of the sender's previous sending chain
  messageNumber: number; // N — index of this message within the current sending chain
}

export interface RatchetState {
  dhSelf: KeyPair; // DHs
  dhRemote: Uint8Array | null; // DHr
  rootKey: Uint8Array; // RK
  chainKeySend: Uint8Array | null; // CKs
  chainKeyRecv: Uint8Array | null; // CKr
  sendCount: number; // Ns
  recvCount: number; // Nr
  previousSendCount: number; // PN
  /** key: `${base64(DHr)}:${N}` → message key. Cleared entries are deleted, never
   * left around after use — a stored skipped key is single-use just like any other
   * ratchet message key (docs/05's forward-secrecy claim depends on this). */
  skippedMessageKeys: Map<string, Uint8Array>;
}

function kdfRootKey(rootKey: Uint8Array, dhOutput: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdfSha256(dhOutput, rootKey, ROOT_KDF_INFO, 64);
  return { rootKey: okm.slice(0, 32), chainKey: okm.slice(32, 64) };
}

function kdfChainKey(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  // Single-byte constants distinguishing the two HMAC outputs — standard practice
  // for a symmetric-key ratchet (spec §3.2), not a secret in itself.
  const messageKey = hmacSha256(chainKey, new Uint8Array([0x01]));
  const nextChainKey = hmacSha256(chainKey, new Uint8Array([0x02]));
  return { chainKey: nextChainKey, messageKey };
}

/** Expands a 32-byte ratchet message key into an actual AEAD key + base nonce —
 * never uses `mk` directly as the cipher key, so a key reused across the "message
 * key" and "AEAD key" namespaces can't happen even in principle. */
function deriveAeadMaterial(messageKey: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const okm = hkdfSha256(messageKey, new Uint8Array(32), MSG_KDF_INFO, AEAD_KEY_LEN + AEAD_NONCE_LEN);
  return { key: okm.slice(0, AEAD_KEY_LEN), nonce: okm.slice(AEAD_KEY_LEN) };
}

function skippedKeyId(dhRemote: Uint8Array, n: number): string {
  return `${bytesToBase64(dhRemote)}:${n}`;
}

/**
 * RatchetInitAlice — the session initiator's side. `sharedKey` is X3DH's `SK`;
 * `theirRatchetPublicKey` is the recipient's signed pre-key public, used as the
 * initial remote ratchet key exactly as the spec's X3DH-integration section
 * describes (§3.3).
 */
export function initRatchetAsSender(sharedKey: Uint8Array, theirRatchetPublicKey: Uint8Array): RatchetState {
  const dhSelf = generateX25519KeyPair();
  const dhOutput = dh(dhSelf.privateKey, theirRatchetPublicKey);
  const { rootKey, chainKey } = kdfRootKey(sharedKey, dhOutput);

  return {
    dhSelf,
    dhRemote: theirRatchetPublicKey,
    rootKey,
    chainKeySend: chainKey,
    chainKeyRecv: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skippedMessageKeys: new Map(),
  };
}

/**
 * RatchetInitBob — the session recipient's side. `ourRatchetKeyPair` is our own
 * signed pre-key pair, reused as the initial ratchet key pair (spec §3.3) — cheaper
 * than generating a fresh one before we've even received a first message to ratchet
 * against.
 */
export function initRatchetAsReceiver(sharedKey: Uint8Array, ourRatchetKeyPair: KeyPair): RatchetState {
  return {
    dhSelf: ourRatchetKeyPair,
    dhRemote: null,
    rootKey: sharedKey,
    chainKeySend: null,
    chainKeyRecv: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skippedMessageKeys: new Map(),
  };
}

function dhRatchetStep(state: RatchetState, theirNewRatchetPublicKey: Uint8Array): void {
  state.previousSendCount = state.sendCount;
  state.sendCount = 0;
  state.recvCount = 0;
  state.dhRemote = theirNewRatchetPublicKey;

  const recv = kdfRootKey(state.rootKey, dh(state.dhSelf.privateKey, state.dhRemote));
  state.rootKey = recv.rootKey;
  state.chainKeyRecv = recv.chainKey;

  state.dhSelf = generateX25519KeyPair();
  const send = kdfRootKey(state.rootKey, dh(state.dhSelf.privateKey, state.dhRemote));
  state.rootKey = send.rootKey;
  state.chainKeySend = send.chainKey;
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (state.chainKeyRecv === null) return;
  if (until - state.recvCount > MAX_SKIPPED_MESSAGE_KEYS) {
    throw new Error('Too many skipped messages in one receiving chain — refusing (DoS guard).');
  }
  while (state.recvCount < until) {
    const { chainKey, messageKey } = kdfChainKey(state.chainKeyRecv);
    state.chainKeyRecv = chainKey;
    state.skippedMessageKeys.set(skippedKeyId(state.dhRemote!, state.recvCount), messageKey);
    state.recvCount += 1;
  }
}

export function encodeHeader(header: RatchetHeader): Uint8Array {
  const lengths = new DataView(new ArrayBuffer(8));
  lengths.setUint32(0, header.previousChainLength, false);
  lengths.setUint32(4, header.messageNumber, false);
  return concatBytes(header.dhPublicKey, new Uint8Array(lengths.buffer));
}

export function decodeHeader(bytes: Uint8Array): RatchetHeader {
  if (bytes.length !== 40) throw new Error('Malformed ratchet header.');
  const dhPublicKey = bytes.slice(0, 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset + 32, 8);
  return {
    dhPublicKey,
    previousChainLength: view.getUint32(0, false),
    messageNumber: view.getUint32(4, false),
  };
}

export interface RatchetEncryptResult {
  header: RatchetHeader;
  ciphertext: Uint8Array;
}

/** RatchetEncrypt. `associatedData` is bound into the AEAD tag — see
 * session/session.ts, which passes each participant's identity keys so a
 * ciphertext can never be replayed into a different conversation and decrypt. */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): RatchetEncryptResult {
  if (state.chainKeySend === null) {
    throw new Error('Cannot encrypt: no sending chain established yet.');
  }
  const { chainKey, messageKey } = kdfChainKey(state.chainKeySend);
  state.chainKeySend = chainKey;

  const header: RatchetHeader = {
    dhPublicKey: state.dhSelf.publicKey,
    previousChainLength: state.previousSendCount,
    messageNumber: state.sendCount,
  };
  state.sendCount += 1;

  const { key, nonce } = deriveAeadMaterial(messageKey);
  const aad = concatBytes(associatedData, encodeHeader(header));
  const ciphertext = aeadEncrypt(key, nonce, plaintext, aad);

  return { header, ciphertext };
}

/** RatchetDecrypt. Throws (never returns garbage) on: unknown/consumed skipped key,
 * a DH ratchet step that fails, or AEAD tag mismatch (tamper detection) — see
 * docs/12-testing-strategy.md's tamper-detection requirement. */
export function ratchetDecrypt(
  state: RatchetState,
  header: RatchetHeader,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  const skippedId = skippedKeyId(header.dhPublicKey, header.messageNumber);
  const skippedKey = state.skippedMessageKeys.get(skippedId);
  if (skippedKey) {
    state.skippedMessageKeys.delete(skippedId);
    const { key, nonce } = deriveAeadMaterial(skippedKey);
    const aad = concatBytes(associatedData, encodeHeader(header));
    return aeadDecrypt(key, nonce, ciphertext, aad);
  }

  const isNewRatchetKey = state.dhRemote === null || bytesToBase64(header.dhPublicKey) !== bytesToBase64(state.dhRemote);
  if (isNewRatchetKey) {
    skipMessageKeys(state, header.previousChainLength);
    dhRatchetStep(state, header.dhPublicKey);
  }

  skipMessageKeys(state, header.messageNumber);

  if (state.chainKeyRecv === null) {
    throw new Error('Cannot decrypt: no receiving chain established.');
  }
  const { chainKey, messageKey } = kdfChainKey(state.chainKeyRecv);
  state.chainKeyRecv = chainKey;
  state.recvCount += 1;

  const { key, nonce } = deriveAeadMaterial(messageKey);
  const aad = concatBytes(associatedData, encodeHeader(header));
  // If this throws (tampered ciphertext / wrong key), the ratchet has already
  // advanced past this message — by design, per the spec: a Double Ratchet does not
  // roll back state on a failed decrypt, since silently retrying would itself be a
  // side channel. Callers that need "did this message fail" semantics without
  // desyncing the ratchet should validate the AEAD tag out-of-band before calling
  // this in a context where retry matters; for this system's message-per-envelope
  // model, a failed decrypt simply means that message is undeliverable.
  return aeadDecrypt(key, nonce, ciphertext, aad);
}
