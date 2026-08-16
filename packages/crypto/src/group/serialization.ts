import { bytesToBase64, base64ToBytes } from '../encoding';
import type { GroupOutboundSession, GroupInboundSession } from './ratchet';

/**
 * JSON-safe mirrors of the group session types (Uint8Arrays → base64, Map → array of
 * entries) — same purpose as `../session/serialization.ts` for the 1:1 case: exactly
 * one place that knows how to persist/reconstitute group ratchet state, reused by
 * `apps/web/lib/crypto/group-sessions.ts` instead of ad hoc (de)serialization at
 * call sites.
 */
export interface SerializedGroupOutboundSession {
  sessionId: string;
  chainKey: string;
  counter: number;
}

export function serializeGroupOutboundSession(session: GroupOutboundSession): SerializedGroupOutboundSession {
  return {
    sessionId: bytesToBase64(session.sessionId),
    chainKey: bytesToBase64(session.chainKey),
    counter: session.counter,
  };
}

export function deserializeGroupOutboundSession(serialized: SerializedGroupOutboundSession): GroupOutboundSession {
  return {
    sessionId: base64ToBytes(serialized.sessionId),
    chainKey: base64ToBytes(serialized.chainKey),
    counter: serialized.counter,
  };
}

export interface SerializedGroupInboundSession {
  sessionId: string;
  chainKey: string;
  counter: number;
  skippedMessageKeys: Array<[number, string]>;
}

export function serializeGroupInboundSession(session: GroupInboundSession): SerializedGroupInboundSession {
  return {
    sessionId: bytesToBase64(session.sessionId),
    chainKey: bytesToBase64(session.chainKey),
    counter: session.counter,
    skippedMessageKeys: Array.from(session.skippedMessageKeys.entries()).map(([k, v]) => [k, bytesToBase64(v)]),
  };
}

export function deserializeGroupInboundSession(serialized: SerializedGroupInboundSession): GroupInboundSession {
  return {
    sessionId: base64ToBytes(serialized.sessionId),
    chainKey: base64ToBytes(serialized.chainKey),
    counter: serialized.counter,
    skippedMessageKeys: new Map(serialized.skippedMessageKeys.map(([k, v]) => [k, base64ToBytes(v)])),
  };
}
