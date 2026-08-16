/**
 * A Megolm-style group ratchet — a one-way symmetric chain-key ratchet, one per
 * sender per session, distinct from (and much simpler than) the Double Ratchet in
 * ../ratchet/double-ratchet.ts: there is no DH ratchet step here at all, because
 * group key *distribution* (not per-message forward secrecy against the whole
 * group) is what handles membership changes — see
 * docs/05-crypto-architecture.md#group-encryption for the full design and why a
 * one-way chain is the right shape for "many recipients, one sender, no shared
 * pairwise DH." Written in the same reviewable style as double-ratchet.ts: function
 * names/structure mirror it directly (kdfChainKey, deriveAeadMaterial, a bounded
 * skipped-key cache) so this can be read as "the same construction, applied
 * one-way" rather than a separate thing to review from scratch. Same primitives
 * (`primitives.ts`), same AEAD (ChaCha20-Poly1305) — "one audited cipher to review,"
 * this project's stated reasoning, applies here too.
 */
import { hkdfSha256, hmacSha256, aeadEncrypt, aeadDecrypt, randomBytes } from '../primitives';
import { bytesToBase64, concatBytes } from '../encoding';

const CHAIN_KDF_INFO = 'Comm_GR_MsgKey_v1'; // mirrors double-ratchet.ts's MSG_KDF_INFO naming
const AEAD_KEY_LEN = 32;
const AEAD_NONCE_LEN = 12;
const SESSION_ID_LEN = 16;
const CHAIN_KEY_LEN = 32;

/** Same DoS-guard reasoning as `MAX_SKIPPED_MESSAGE_KEYS` in double-ratchet.ts — a
 * malicious/corrupted header claiming a huge counter can't force unbounded skip-key
 * derivation/storage. Real out-of-order group delivery is nowhere near this. */
export const MAX_SKIPPED_GROUP_MESSAGE_KEYS = 1000;

export interface GroupOutboundSession {
  sessionId: Uint8Array; // 16 random bytes, minted once per (re)creation
  chainKey: Uint8Array;
  counter: number;
}

export interface GroupInboundSession {
  sessionId: Uint8Array;
  /** The chain key AT `counter` — i.e. not yet consumed for that counter. */
  chainKey: Uint8Array;
  counter: number;
  /** key: counter → message key. Same "delete on use, bounded size" contract as
   * double-ratchet.ts's `skippedMessageKeys`. */
  skippedMessageKeys: Map<number, Uint8Array>;
}

export interface GroupMessageHeader {
  sessionId: Uint8Array;
  counter: number;
}

function kdfChainKey(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  // Identical two-HMAC-output construction to double-ratchet.ts's own kdfChainKey —
  // deliberately the same reviewed technique, not a second one to audit.
  const messageKey = hmacSha256(chainKey, new Uint8Array([0x01]));
  const nextChainKey = hmacSha256(chainKey, new Uint8Array([0x02]));
  return { chainKey: nextChainKey, messageKey };
}

function deriveAeadMaterial(messageKey: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const okm = hkdfSha256(messageKey, new Uint8Array(32), CHAIN_KDF_INFO, AEAD_KEY_LEN + AEAD_NONCE_LEN);
  return { key: okm.slice(0, AEAD_KEY_LEN), nonce: okm.slice(AEAD_KEY_LEN) };
}

export function createOutboundGroupSession(): GroupOutboundSession {
  return { sessionId: randomBytes(SESSION_ID_LEN), chainKey: randomBytes(CHAIN_KEY_LEN), counter: 0 };
}

/** `chainKeyAtCounter` is whatever chain-key value the sender's outbound session held
 * at `counter` when it was shared (docs/05-crypto-architecture.md#group-encryption) —
 * this inbound session can derive every message key from `counter` onward, but never
 * backward (no retroactive history access for a newly-added member, by design). */
export function createInboundGroupSession(
  sessionId: Uint8Array,
  chainKeyAtCounter: Uint8Array,
  counter: number,
): GroupInboundSession {
  return { sessionId, chainKey: chainKeyAtCounter, counter, skippedMessageKeys: new Map() };
}

export function encodeGroupHeader(header: GroupMessageHeader): Uint8Array {
  const counterBytes = new DataView(new ArrayBuffer(4));
  counterBytes.setUint32(0, header.counter, false);
  return concatBytes(header.sessionId, new Uint8Array(counterBytes.buffer));
}

export function decodeGroupHeader(bytes: Uint8Array): GroupMessageHeader {
  if (bytes.length !== SESSION_ID_LEN + 4) throw new Error('Malformed group ratchet header.');
  const sessionId = bytes.slice(0, SESSION_ID_LEN);
  const view = new DataView(bytes.buffer, bytes.byteOffset + SESSION_ID_LEN, 4);
  return { sessionId, counter: view.getUint32(0, false) };
}

export interface GroupEncryptResult {
  header: GroupMessageHeader;
  ciphertext: Uint8Array;
}

/** Advances the ratchet by exactly one step — never reversible, which is the whole
 * forward-secrecy property this session type provides (a later compromise of
 * `session.chainKey` cannot recover any message this sender already sent). */
export function encryptGroupMessage(
  session: GroupOutboundSession,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): GroupEncryptResult {
  const { chainKey, messageKey } = kdfChainKey(session.chainKey);
  const header: GroupMessageHeader = { sessionId: session.sessionId, counter: session.counter };
  session.chainKey = chainKey;
  session.counter += 1;

  const { key, nonce } = deriveAeadMaterial(messageKey);
  const aad = concatBytes(associatedData, encodeGroupHeader(header));
  const ciphertext = aeadEncrypt(key, nonce, plaintext, aad);
  return { header, ciphertext };
}

function skipGroupMessageKeys(session: GroupInboundSession, until: number): void {
  if (until - session.counter > MAX_SKIPPED_GROUP_MESSAGE_KEYS) {
    throw new Error('Too many skipped group messages in one session — refusing (DoS guard).');
  }
  while (session.counter < until) {
    const { chainKey, messageKey } = kdfChainKey(session.chainKey);
    session.chainKey = chainKey;
    session.skippedMessageKeys.set(session.counter, messageKey);
    session.counter += 1;
  }
}

/** Throws (never returns garbage) on: a header for a different session, a counter
 * this session has already advanced past with no cached skip-key for it (either a
 * duplicate delivery or genuinely unrecoverable), the DoS-guard bound, or an AEAD tag
 * mismatch (tamper detection) — matching double-ratchet.ts's `ratchetDecrypt`
 * contract exactly. */
export function decryptGroupMessage(
  session: GroupInboundSession,
  header: GroupMessageHeader,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  if (bytesToBase64(header.sessionId) !== bytesToBase64(session.sessionId)) {
    throw new Error('Message belongs to a different group session.');
  }

  const cached = session.skippedMessageKeys.get(header.counter);
  if (cached !== undefined) {
    session.skippedMessageKeys.delete(header.counter);
    const { key, nonce } = deriveAeadMaterial(cached);
    const aad = concatBytes(associatedData, encodeGroupHeader(header));
    return aeadDecrypt(key, nonce, ciphertext, aad);
  }

  if (header.counter < session.counter) {
    throw new Error('Cannot decrypt: this message key is no longer available.');
  }

  skipGroupMessageKeys(session, header.counter); // session.counter === header.counter now

  const { chainKey, messageKey } = kdfChainKey(session.chainKey);
  session.chainKey = chainKey;
  session.counter += 1;

  const { key, nonce } = deriveAeadMaterial(messageKey);
  const aad = concatBytes(associatedData, encodeGroupHeader(header));
  return aeadDecrypt(key, nonce, ciphertext, aad);
}
