import { describe, it, expect } from 'vitest';
import {
  createOutboundGroupSession,
  createInboundGroupSession,
  encryptGroupMessage,
  decryptGroupMessage,
  MAX_SKIPPED_GROUP_MESSAGE_KEYS,
} from '../group/ratchet';

const te = new TextEncoder();
const td = new TextDecoder();
const ad = te.encode('group-associated-data');

function joinAtCurrent(outbound: ReturnType<typeof createOutboundGroupSession>) {
  return createInboundGroupSession(outbound.sessionId, outbound.chainKey, outbound.counter);
}

describe('Group ratchet (Megolm-style, one-way per-sender chain)', () => {
  it('a member sends, another decrypts — first message of a brand-new session', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);

    const { header, ciphertext } = encryptGroupMessage(outbound, te.encode('hello group'), ad);
    const plaintext = decryptGroupMessage(inbound, header, ciphertext, ad);

    expect(td.decode(plaintext)).toBe('hello group');
  });

  it('a run of messages from one sender stays in sync for a receiver who joined at counter 0', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);
    const messages = ['one', 'two', 'three', 'four', 'five'];

    for (const text of messages) {
      const { header, ciphertext } = encryptGroupMessage(outbound, te.encode(text), ad);
      const plaintext = decryptGroupMessage(inbound, header, ciphertext, ad);
      expect(td.decode(plaintext)).toBe(text);
    }
  });

  it('handles out-of-order delivery (message 2 arrives before message 1)', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);

    const msg1 = encryptGroupMessage(outbound, te.encode('first'), ad);
    const msg2 = encryptGroupMessage(outbound, te.encode('second'), ad);

    const plaintext2 = decryptGroupMessage(inbound, msg2.header, msg2.ciphertext, ad);
    expect(td.decode(plaintext2)).toBe('second');

    const plaintext1 = decryptGroupMessage(inbound, msg1.header, msg1.ciphertext, ad);
    expect(td.decode(plaintext1)).toBe('first');
  });

  it('a member who joins mid-conversation cannot decrypt history from before they joined (no retroactive access)', () => {
    const outbound = createOutboundGroupSession();

    // Two messages sent before the new member has any session for this sender.
    const before1 = encryptGroupMessage(outbound, te.encode('sent before joining #1'), ad);
    const before2 = encryptGroupMessage(outbound, te.encode('sent before joining #2'), ad);

    // The new member's inbound session starts at the sender's CURRENT counter —
    // exactly what a real group.key-share delivers (docs/13-roadmap.md).
    const lateJoiner = joinAtCurrent(outbound);

    expect(() => decryptGroupMessage(lateJoiner, before1.header, before1.ciphertext, ad)).toThrow();
    expect(() => decryptGroupMessage(lateJoiner, before2.header, before2.ciphertext, ad)).toThrow();

    // But a message sent after they joined decrypts fine.
    const after = encryptGroupMessage(outbound, te.encode('sent after joining'), ad);
    const plaintext = decryptGroupMessage(lateJoiner, after.header, after.ciphertext, ad);
    expect(td.decode(plaintext)).toBe('sent after joining');
  });

  it('epoch rotation: a removed member holding the old session cannot decrypt messages under the new one', () => {
    const oldOutbound = createOutboundGroupSession();
    const removedMember = joinAtCurrent(oldOutbound); // holds the pre-rotation session

    // Remaining members rotate to a brand-new outbound session (docs/05-crypto-architecture.md's
    // "on member removal" design) — the removed member never receives this one.
    const newOutbound = createOutboundGroupSession();
    const remainingMember = joinAtCurrent(newOutbound);

    const postRotation = encryptGroupMessage(newOutbound, te.encode('after removal'), ad);

    // The remaining member (who has the new session) decrypts fine...
    const plaintext = decryptGroupMessage(remainingMember, postRotation.header, postRotation.ciphertext, ad);
    expect(td.decode(plaintext)).toBe('after removal');

    // ...but the removed member's stale session is for a DIFFERENT sessionId entirely
    // and throws rather than producing garbage.
    expect(() => decryptGroupMessage(removedMember, postRotation.header, postRotation.ciphertext, ad)).toThrow(/different group session/);
  });

  it('forward secrecy: advancing the outbound chain means an earlier chain key cannot be recovered', () => {
    const outbound = createOutboundGroupSession();
    const staleChainKey = outbound.chainKey;

    encryptGroupMessage(outbound, te.encode('first'), ad);
    encryptGroupMessage(outbound, te.encode('second'), ad);

    expect(outbound.chainKey).not.toEqual(staleChainKey);
  });

  it('rejects a tampered ciphertext (bit flip) rather than returning corrupted plaintext', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);
    const { header, ciphertext } = encryptGroupMessage(outbound, te.encode('sensitive'), ad);

    const tampered = new Uint8Array(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => decryptGroupMessage(inbound, header, tampered, ad)).toThrow();
  });

  it('rejects a message re-encrypted under the wrong associated data (cross-group replay)', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);
    const { header, ciphertext } = encryptGroupMessage(outbound, te.encode('for this group only'), ad);

    const wrongAd = te.encode('a different group entirely');
    expect(() => decryptGroupMessage(inbound, header, ciphertext, wrongAd)).toThrow();
  });

  it('rejects re-decrypting an already-consumed counter with no skip cache entry (replay/duplicate)', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);
    const { header, ciphertext } = encryptGroupMessage(outbound, te.encode('once only'), ad);

    decryptGroupMessage(inbound, header, ciphertext, ad); // consumes counter 0
    expect(() => decryptGroupMessage(inbound, header, ciphertext, ad)).toThrow(/no longer available/);
  });

  it('bounds skipped-key derivation — refuses an absurd counter jump rather than allocating unboundedly (DoS guard)', () => {
    const outbound = createOutboundGroupSession();
    const inbound = joinAtCurrent(outbound);

    // Fabricate a header claiming a counter far beyond the bound, as if a malicious
    // sender (or corrupted delivery) tried to force a huge skip-key derivation.
    const { ciphertext } = encryptGroupMessage(outbound, te.encode('whatever'), ad);
    const maliciousHeader = { sessionId: outbound.sessionId, counter: MAX_SKIPPED_GROUP_MESSAGE_KEYS + 10 };

    expect(() => decryptGroupMessage(inbound, maliciousHeader, ciphertext, ad)).toThrow(/DoS guard/);
  });
});
