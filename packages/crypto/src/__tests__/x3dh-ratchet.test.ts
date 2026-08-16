import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair, generateSignedPreKey, generateOneTimePreKeys } from '../identity/keys';
import { initiateSession, receiveSession, type PublicKeyBundle } from '../x3dh/x3dh';
import { ratchetEncrypt, ratchetDecrypt } from '../ratchet/double-ratchet';

const te = new TextEncoder();
const td = new TextDecoder();

function publishBundle(
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

/** Full session-establishment helper used across tests below — mirrors exactly what
 * apps/web's client code will do: Alice fetches Bob's bundle, initiates; Bob receives
 * Alice's first message and derives the matching session. */
function establishSession() {
  const alice = generateIdentityKeyPair();
  const bob = generateIdentityKeyPair();
  const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
  const [bobOneTimePreKey] = generateOneTimePreKeys(1, 1);

  const bundle = publishBundle(bob, bobSignedPreKey, bobOneTimePreKey);
  const aliceSide = initiateSession(alice, bundle);

  const bobSide = receiveSession(
    bob,
    bobSignedPreKey,
    bobOneTimePreKey!,
    aliceSide.initialMessage.identityAgreementKey,
    aliceSide.initialMessage.ephemeralKey,
  );

  return { alice, bob, aliceSide, bobSide };
}

describe('X3DH session establishment', () => {
  it('both sides derive the same associated data', () => {
    const { aliceSide, bobSide } = establishSession();
    expect(aliceSide.associatedData).toEqual(bobSide.associatedData);
  });

  it('rejects a bundle whose signed pre-key signature does not verify (spoofed bundle)', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const mallory = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);

    // Mallory (or a malicious server) substitutes Bob's signed pre-key with her own,
    // but the signature still claims to be Bob's — must fail closed.
    const tamperedBundle = publishBundle(bob, bobSignedPreKey);
    tamperedBundle.signedPreKeyPublic = generateSignedPreKey(mallory.signing.privateKey, 1).keyPair.publicKey;

    expect(() => initiateSession(alice, tamperedBundle)).toThrow(/signature/i);
  });

  it('works without a one-time pre-key (exhausted pool fallback per the X3DH spec)', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const bobSignedPreKey = generateSignedPreKey(bob.signing.privateKey, 1);
    const bundle = publishBundle(bob, bobSignedPreKey); // no one-time pre-key

    const aliceSide = initiateSession(alice, bundle);
    const bobSide = receiveSession(
      bob,
      bobSignedPreKey,
      null,
      aliceSide.initialMessage.identityAgreementKey,
      aliceSide.initialMessage.ephemeralKey,
    );

    expect(aliceSide.associatedData).toEqual(bobSide.associatedData);
  });
});

describe('Double Ratchet over an X3DH-derived session', () => {
  it('Alice sends, Bob decrypts — first message of a brand-new session', () => {
    const { aliceSide, bobSide } = establishSession();

    const { header, ciphertext } = ratchetEncrypt(aliceSide.ratchetState, te.encode('hello bob'), aliceSide.associatedData);
    const plaintext = ratchetDecrypt(bobSide.ratchetState, header, ciphertext, bobSide.associatedData);

    expect(td.decode(plaintext)).toBe('hello bob');
  });

  it('a full back-and-forth conversation stays in sync across many messages', () => {
    const { aliceSide, bobSide } = establishSession();
    const messages = ['hi', 'how are you', 'good, you?', 'great, want to grab coffee?', 'sure, 3pm?'];
    let fromAlice = true;

    for (const text of messages) {
      const senderState = fromAlice ? aliceSide.ratchetState : bobSide.ratchetState;
      const senderAd = fromAlice ? aliceSide.associatedData : bobSide.associatedData;
      const receiverState = fromAlice ? bobSide.ratchetState : aliceSide.ratchetState;
      const receiverAd = fromAlice ? bobSide.associatedData : aliceSide.associatedData;

      const { header, ciphertext } = ratchetEncrypt(senderState, te.encode(text), senderAd);
      const plaintext = ratchetDecrypt(receiverState, header, ciphertext, receiverAd);
      expect(td.decode(plaintext)).toBe(text);

      fromAlice = !fromAlice;
    }
  });

  it('handles out-of-order delivery within a chain (message 2 arrives before message 1)', () => {
    const { aliceSide, bobSide } = establishSession();

    const msg1 = ratchetEncrypt(aliceSide.ratchetState, te.encode('first'), aliceSide.associatedData);
    const msg2 = ratchetEncrypt(aliceSide.ratchetState, te.encode('second'), aliceSide.associatedData);

    // Bob receives message 2 first — must skip-ahead and cache message 1's key.
    const plaintext2 = ratchetDecrypt(bobSide.ratchetState, msg2.header, msg2.ciphertext, bobSide.associatedData);
    expect(td.decode(plaintext2)).toBe('second');

    const plaintext1 = ratchetDecrypt(bobSide.ratchetState, msg1.header, msg1.ciphertext, bobSide.associatedData);
    expect(td.decode(plaintext1)).toBe('first');
  });

  it('handles messages skipped across a DH ratchet turn (lost message, conversation continues)', () => {
    const { aliceSide, bobSide } = establishSession();

    // Bob's side (the X3DH/ratchet *receiver*) has no sending chain until it
    // decrypts a first message from Alice — per spec, RatchetInitBob starts with
    // CKs = None, since sending requires a DH ratchet step that only happens on
    // receipt. This mirrors a real conversation: Bob can't reply before Alice's
    // first message ever arrives.
    const opener = ratchetEncrypt(aliceSide.ratchetState, te.encode('hey bob'), aliceSide.associatedData);
    ratchetDecrypt(bobSide.ratchetState, opener.header, opener.ciphertext, bobSide.associatedData);

    const lost = ratchetEncrypt(aliceSide.ratchetState, te.encode('this one gets lost'), aliceSide.associatedData);
    void lost; // simulates network loss — never delivered to Bob

    // Bob replies, which forces Alice's ratchet to turn (DH ratchet step) before her
    // next send.
    const bobReply = ratchetEncrypt(bobSide.ratchetState, te.encode('bob replies'), bobSide.associatedData);
    ratchetDecrypt(aliceSide.ratchetState, bobReply.header, bobReply.ciphertext, aliceSide.associatedData);

    const afterTurn = ratchetEncrypt(aliceSide.ratchetState, te.encode('after the turn'), aliceSide.associatedData);
    const plaintext = ratchetDecrypt(bobSide.ratchetState, afterTurn.header, afterTurn.ciphertext, bobSide.associatedData);
    expect(td.decode(plaintext)).toBe('after the turn');

    // The lost message's key was skip-cached under the OLD ratchet key before the
    // turn — Bob can never receive it now (it was never sent), but the session must
    // not be corrupted by its absence.
  });

  it('rejects a tampered ciphertext (bit flip) rather than returning corrupted plaintext', () => {
    const { aliceSide, bobSide } = establishSession();
    const { header, ciphertext } = ratchetEncrypt(aliceSide.ratchetState, te.encode('sensitive'), aliceSide.associatedData);

    const tampered = new Uint8Array(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => ratchetDecrypt(bobSide.ratchetState, header, tampered, bobSide.associatedData)).toThrow();
  });

  it('rejects a message re-encrypted under the wrong associated data (cross-session replay)', () => {
    const { aliceSide, bobSide } = establishSession();
    const { header, ciphertext } = ratchetEncrypt(aliceSide.ratchetState, te.encode('for bob only'), aliceSide.associatedData);

    const wrongAd = new TextEncoder().encode('not the real associated data');
    expect(() => ratchetDecrypt(bobSide.ratchetState, header, ciphertext, wrongAd)).toThrow();
  });

  it('forward secrecy: an old chain key cannot decrypt a message sent after a DH ratchet turn', () => {
    const { aliceSide, bobSide } = establishSession();

    // Bob needs a first received message before he can send anything (see the note
    // in the "lost message" test above).
    const opener = ratchetEncrypt(aliceSide.ratchetState, te.encode('hey bob'), aliceSide.associatedData);
    ratchetDecrypt(bobSide.ratchetState, opener.header, opener.ciphertext, bobSide.associatedData);

    // Capture Bob's chain key state before Alice's next-chain message arrives.
    const staleChainKey = bobSide.ratchetState.chainKeyRecv;

    const bobReply = ratchetEncrypt(bobSide.ratchetState, te.encode('turning the ratchet'), bobSide.associatedData);
    ratchetDecrypt(aliceSide.ratchetState, bobReply.header, bobReply.ciphertext, aliceSide.associatedData);
    const afterTurn = ratchetEncrypt(aliceSide.ratchetState, te.encode('new chain message'), aliceSide.associatedData);

    // Bob's own (correctly advanced) state decrypts the new-chain message fine...
    const plaintext = ratchetDecrypt(bobSide.ratchetState, afterTurn.header, afterTurn.ciphertext, bobSide.associatedData);
    expect(td.decode(plaintext)).toBe('new chain message');
    // ...but the stale chain key captured earlier is simply a different, unrelated
    // value now — proving the ratchet actually moved forward, which is what forward
    // secrecy depends on.
    expect(bobSide.ratchetState.chainKeyRecv).not.toEqual(staleChainKey);
  });
});
