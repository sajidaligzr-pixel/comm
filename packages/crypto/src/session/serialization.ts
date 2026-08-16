import { bytesToBase64, base64ToBytes } from '../encoding';
import type { RatchetState } from '../ratchet/double-ratchet';

/**
 * A JSON-safe mirror of `RatchetState` (Uint8Arrays → base64, Map → array of
 * entries) — this is what actually gets wrapped (storage/wrap.ts) and persisted to
 * IndexedDB, and what's reconstituted back into a live `RatchetState` on load. Kept
 * as its own module so the "how do we serialize a ratchet" question has exactly one
 * answer, reused by every caller instead of ad hoc `JSON.stringify` at call sites.
 */
export interface SerializedRatchetState {
  dhSelfPrivateKey: string;
  dhSelfPublicKey: string;
  dhRemote: string | null;
  rootKey: string;
  chainKeySend: string | null;
  chainKeyRecv: string | null;
  sendCount: number;
  recvCount: number;
  previousSendCount: number;
  skippedMessageKeys: Array<[string, string]>;
}

export function serializeRatchetState(state: RatchetState): SerializedRatchetState {
  return {
    dhSelfPrivateKey: bytesToBase64(state.dhSelf.privateKey),
    dhSelfPublicKey: bytesToBase64(state.dhSelf.publicKey),
    dhRemote: state.dhRemote ? bytesToBase64(state.dhRemote) : null,
    rootKey: bytesToBase64(state.rootKey),
    chainKeySend: state.chainKeySend ? bytesToBase64(state.chainKeySend) : null,
    chainKeyRecv: state.chainKeyRecv ? bytesToBase64(state.chainKeyRecv) : null,
    sendCount: state.sendCount,
    recvCount: state.recvCount,
    previousSendCount: state.previousSendCount,
    skippedMessageKeys: Array.from(state.skippedMessageKeys.entries()).map(([k, v]) => [k, bytesToBase64(v)]),
  };
}

export function deserializeRatchetState(serialized: SerializedRatchetState): RatchetState {
  return {
    dhSelf: {
      privateKey: base64ToBytes(serialized.dhSelfPrivateKey),
      publicKey: base64ToBytes(serialized.dhSelfPublicKey),
    },
    dhRemote: serialized.dhRemote ? base64ToBytes(serialized.dhRemote) : null,
    rootKey: base64ToBytes(serialized.rootKey),
    chainKeySend: serialized.chainKeySend ? base64ToBytes(serialized.chainKeySend) : null,
    chainKeyRecv: serialized.chainKeyRecv ? base64ToBytes(serialized.chainKeyRecv) : null,
    sendCount: serialized.sendCount,
    recvCount: serialized.recvCount,
    previousSendCount: serialized.previousSendCount,
    skippedMessageKeys: new Map(serialized.skippedMessageKeys.map(([k, v]) => [k, base64ToBytes(v)])),
  };
}
