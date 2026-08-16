'use client';

/**
 * Biometric (Touch ID / Face ID / Windows Hello / Android platform authenticator)
 * unlock — asked for directly, once as an idea ("can he turn on the fingerprint...
 * to login") and confirmed after explaining the constraint that actually shapes this
 * file: the login password isn't just a login check, it's what derives the KEK
 * protecting every local key/session/message (docs/05-crypto-architecture.md#local-key-storage).
 * This was already flagged in docs/13-roadmap.md as a real, buildable feature —
 * *layered on top of* the real password, never replacing or re-deriving it — using
 * WebAuthn's PRF extension, not implemented until now because it needed its own
 * pass rather than being bolted on mid-flight.
 *
 * How it actually works: a platform authenticator credential is registered with the
 * PRF extension requested. Evaluating that credential (which requires the actual
 * biometric/PIN gate — `userVerification: 'required'`) against a fixed, non-secret
 * salt deterministically produces the same secret bytes every time, *only* on this
 * device, *only* after a successful biometric check — the authenticator's own
 * hardware is what makes that secret unextractable, not anything this code does. That
 * secret (normalized to a proper key via HKDF) wraps the already-Argon2id-derived KEK
 * exactly the way `wrapBytes`/`unwrapBytes` already wrap every other piece of local
 * key material — this is not a new storage mechanism, just a new way to unlock an
 * existing one. The account password is never touched, stored, or weakened; a device
 * without biometric unlock enabled, or where it fails for any reason, always still
 * has the real password field as the actual fallback — see unlock-gate.tsx.
 *
 * PRF extension support is genuinely inconsistent across browsers/platforms (flagged
 * in the roadmap for exactly this reason) — every function here fails closed: no
 * PRF support, no enrollment, a stale/corrupt wrap, anything unexpected all resolve
 * to `false`/`null`, never a thrown error a caller has to specially handle. The
 * genuinely unlockable both ways for the same reason the password path already is.
 */
import { hkdfSha256, wrapBytes, unwrapBytes, KEK_LENGTH, type IdentityKeyPair } from '@comm/crypto';
import { putBlob, getBlob, deleteBlob } from './db';
import { loadStoredIdentity } from './identity';

const CREDENTIAL_ID_KEY = 'biometric-credential-id';
const WRAPPED_KEK_KEY = 'biometric-wrapped-kek';

// Non-secret, fixed, and constant across every user/device — the PRF extension's
// "salt" is a domain-separation input, not a secret; the actual security comes from
// the WebAuthn credential's own hardware-bound secret, unique per credential.
const PRF_SALT = new TextEncoder().encode('comm-biometric-unlock-v1-salt-000000');
const HKDF_SALT = new Uint8Array(32); // zero salt is fine — ikm (the PRF output) is already high-entropy

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

/** Whether this browser/OS combination even offers a platform authenticator at
 * all (Touch ID, Face ID, Windows Hello, Android biometrics) — checked before ever
 * showing a "set up biometric unlock" option. PRF support specifically can only be
 * confirmed by actually attempting registration (browsers don't expose it any other
 * way), so this is a necessary-but-not-sufficient pre-check. */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  return (await getBlob(CREDENTIAL_ID_KEY)) !== null;
}

/**
 * Registers a new platform-authenticator credential on this device and, if (and
 * only if) it actually supports the PRF extension, wraps the just-unlocked KEK
 * under a key derived from it. Must be called right after a real password unlock —
 * this never has its own path to the account password or a fresh KEK derivation.
 * Returns `false` (never throws) for every failure mode: no platform authenticator,
 * PRF unsupported, the user cancelling the OS biometric prompt, anything else — the
 * caller shows one generic "couldn't set this up on this device" message either way,
 * since none of those are actionable differently by the user.
 */
export async function enableBiometricUnlock(
  kek: Uint8Array,
  userId: string,
  username: string,
): Promise<boolean> {
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        // No relying-party server verification happens anywhere for this credential
        // (see the module docstring) — 'rp.id' defaults to the current origin, which
        // is all that matters: it scopes the credential to this site the same way a
        // cookie would.
        rp: { name: 'Comm' },
        user: {
          id: new TextEncoder().encode(userId),
          name: username,
          displayName: username,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 — universally supported
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // Touch ID/Face ID/Windows Hello, never a roaming USB key
          userVerification: 'required', // must actually gate on biometric/PIN, not just "a key is present"
          residentKey: 'preferred',
        },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!credential) return false;

    const createResults = credential.getClientExtensionResults() as PrfExtensionResults;
    if (!createResults.prf?.enabled) return false; // this authenticator doesn't support PRF — nothing more to try

    const prfOutput = await evaluatePrf(credential.rawId);
    if (!prfOutput) return false;

    const wrapKey = hkdfSha256(prfOutput, HKDF_SALT, 'comm-biometric-unlock-wrap-key', KEK_LENGTH);
    await putBlob(CREDENTIAL_ID_KEY, new Uint8Array(credential.rawId));
    await putBlob(WRAPPED_KEK_KEY, wrapBytes(wrapKey, kek));
    return true;
  } catch {
    return false;
  }
}

export async function disableBiometricUnlock(): Promise<void> {
  await deleteBlob(CREDENTIAL_ID_KEY);
  await deleteBlob(WRAPPED_KEK_KEY);
}

/** Evaluates the PRF extension against an already-registered credential — shared by
 * `enableBiometricUnlock` (to get a value to wrap with) and `unlockWithBiometrics`
 * (to get the same value back to unwrap with). Triggers the actual OS biometric
 * prompt. Returns `null`, never throws, on anything short of success. */
async function evaluatePrf(credentialId: ArrayBuffer | Uint8Array): Promise<Uint8Array | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: credentialId as BufferSource, type: 'public-key' }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return null;
    const results = assertion.getClientExtensionResults() as PrfExtensionResults;
    const first = results.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    // Includes the user cancelling the OS prompt (`NotAllowedError`) — not an error
    // to surface distinctly, the caller just falls back to the password field.
    return null;
  }
}

/**
 * The actual unlock — prompts for biometrics, and on success returns exactly what
 * `unlockLocalIdentity(password)` returns for a real login, so callers (unlock-gate.tsx)
 * can treat the two paths identically from this point on. Returns `null` for every
 * failure, including a wrap that no longer matches anything real (the same "stale
 * local data after a password change elsewhere" scenario `sessions.ts#loadSession`
 * already handles gracefully rather than throwing, applied here too — a biometric
 * enrollment predating a password change is exactly as unrecoverable as an old
 * session is, and exactly as safe to just fall back past rather than crash on).
 */
export async function unlockWithBiometrics(): Promise<{ kek: Uint8Array; identity: IdentityKeyPair } | null> {
  const credentialId = await getBlob(CREDENTIAL_ID_KEY);
  const wrappedKek = await getBlob(WRAPPED_KEK_KEY);
  if (!credentialId || !wrappedKek) return null;

  const prfOutput = await evaluatePrf(credentialId);
  if (!prfOutput) return null;

  try {
    const wrapKey = hkdfSha256(prfOutput, HKDF_SALT, 'comm-biometric-unlock-wrap-key', KEK_LENGTH);
    const kek = unwrapBytes(wrapKey, wrappedKek);
    const local = await loadStoredIdentity(kek);
    if (!local) return null;
    return { kek, identity: local.identity };
  } catch {
    return null;
  }
}
