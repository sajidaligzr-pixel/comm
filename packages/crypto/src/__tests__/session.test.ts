import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, generateOneTimePreKeys } from '../identity/keys';
import {
  createOutboundSession,
  createInboundSession,
  encryptMessage,
  decryptMessage,
  serializeSession,
  deserializeSession,
} from '../session/session';
import type { PublicKeyBundle } from '../x3dh/x3dh';

const te = new TextEncoder();
const td = new TextDecoder();

function bundleFor(
  identity: ReturnType<typeof generateIdentityKeyPair>,
  signedPreKey: ReturnType<typeof generateSignedPreKey>,
  oneTimePreKey?: ReturnType<typeof generateOneTimePreKeys>[number],
): PublicKeyBundle {
  return {
    identityAgreementKey: identity.agreement.publicKey,
    identitySigningKey: identity.signing.publicKey,
    signedPreKeyId: signedPreKey.keyId,
    signedPreKeyPublic: signedPreKey.keyPair.publicKey,
    signedPreKeySignature: signedPreKey.signature,
    oneTimePreKeyId: oneTimePreKey?.keyId ?? null,
    oneTimePreKeyPublic: oneTimePreKey?.keyPair.publicKey ?? null,
  };
}

describe('high-level session API', () => {
  it('end-to-end: Alice creates an outbound session, sends; Bob derives the matching inbound session from x3dhInit and decrypts', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
    const [bobOtk] = generateOneTimePreKeys(1, 1);

    const { session: aliceSession, x3dhInit } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey, bobOtk));
    const envelope = encryptMessage(aliceSession, te.encode('hello from alice'));

    const bobSession = createInboundSession(bob, bobSignedPreKey, bobOtk!, x3dhInit);
    const plaintext = decryptMessage(bobSession, envelope);

    expect(td.decode(plaintext)).toBe('hello from alice');
  });

  it('a message envelope is opaque base64 — never contains the plaintext as a substring', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);

    const { session } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey));
    const secret = 'the launch code is 4815162342';
    const envelope = encryptMessage(session, te.encode(secret));

    expect(envelope.ciphertext).not.toContain(Buffer.from(secret).toString('base64'));
    expect(JSON.stringify(envelope)).not.toContain('launch code');
  });

  it('session state survives a serialize → wrap-free round trip (simulating a page reload)', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
    const [bobOtk] = generateOneTimePreKeys(1, 1);

    const { session: aliceSession, x3dhInit } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey, bobOtk));
    const bobSession = createInboundSession(bob, bobSignedPreKey, bobOtk!, x3dhInit);

    const envelope1 = encryptMessage(aliceSession, te.encode('message before reload'));

    // Simulate Alice's tab reloading: her session is serialized, "stored", then
    // reconstituted from that stored form for her next send.
    const restoredAliceSession = deserializeSession(serializeSession(aliceSession));
    const envelope2 = encryptMessage(restoredAliceSession, te.encode('message after reload'));

    expect(td.decode(decryptMessage(bobSession, envelope1))).toBe('message before reload');
    expect(td.decode(decryptMessage(bobSession, envelope2))).toBe('message after reload');
  });

  it('a session derived against the wrong signed pre-key cannot decrypt the real conversation', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
    const wrongSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 2);

    const { session: aliceSession, x3dhInit } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey));
    const envelope = encryptMessage(aliceSession, te.encode('hello'));

    // Bob's server-side code looks up the pre-key by `x3dhInit.usedSignedPreKeyId`;
    // if that lookup were ever buggy and returned the wrong key, the resulting
    // session must simply fail to decrypt the real message rather than silently
    // "working" with mismatched keys.
    const bobSessionWithWrongKey = createInboundSession(bob, wrongSignedPreKey, null, x3dhInit);

    expect(() => decryptMessage(bobSessionWithWrongKey, envelope)).toThrow();
  });

  /**
   * Proves the crypto-level property `conversation-crypto.ts`'s `decryptFromDevice`
   * self-heal fallback relies on — see that function's own docstring for the real
   * stuck-forever conversation this was found fixing. A sender's local session for
   * a recipient can end up silently orphaned from what the recipient actually has
   * (closed at the source by `encryptForDevice`'s `confirmNewSession`); before this
   * fix, the only recovery on the receiving end was wiping local storage entirely.
   * Two things a self-heal-on-decrypt-failure strategy depends on: decrypting with
   * the wrong cached session fails closed (never silently returns garbage as if it
   * were real plaintext), and bootstrapping a fresh inbound session from that same
   * message's own `x3dhInit` recovers the real plaintext even though a different,
   * stale session for the same two parties already existed locally.
   */
  it('a stale cached session fails closed, then a fresh bootstrap from the message\'s own x3dhInit recovers the real plaintext', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
    const [bobOtkA, bobOtkB] = generateOneTimePreKeys(2, 1);

    // Session A: what Bob actually has cached — a genuine, real session both
    // sides once properly established together.
    const { session: aliceSessionA, x3dhInit: x3dhInitA } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey, bobOtkA));
    const bobSessionA = createInboundSession(bob, bobSignedPreKey, bobOtkA!, x3dhInitA);
    // Sanity: session A genuinely works before moving on — this isn't the
    // failure under test, just the "both sides once agreed" starting point.
    expect(td.decode(decryptMessage(bobSessionA, encryptMessage(aliceSessionA, te.encode('hi'))))).toBe('hi');

    // Session B: Alice independently creates a SECOND, unrelated session with
    // Bob (a fresh X3DH — a different ephemeral key and one-time pre-key),
    // mirroring exactly what `encryptForDevice` used to persist immediately
    // even when the message carrying it never actually reached Bob. Bob's
    // cache still only has session A; he was never given B.
    const { session: aliceSessionB, x3dhInit: x3dhInitB } = createOutboundSession(alice, bundleFor(bob, bobSignedPreKey, bobOtkB));
    const envelopeUnderB = encryptMessage(aliceSessionB, te.encode('real message'));

    // (1) Decrypting under the wrong (stale) cached session must fail closed.
    expect(() => decryptMessage(bobSessionA, envelopeUnderB)).toThrow();

    // (2) The exact fallback `decryptFromDevice` now performs: bootstrap a
    // fresh inbound session from this message's own x3dhInit, then retry.
    const recoveredSession = createInboundSession(bob, bobSignedPreKey, bobOtkB!, x3dhInitB);
    expect(td.decode(decryptMessage(recoveredSession, envelopeUnderB))).toBe('real message');
  });
});
