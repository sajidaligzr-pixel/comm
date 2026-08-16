'use client';

/**
 * In-memory-only holder for the current tab's local-storage KEK — derived once at
 * unlock (login/invite-redeem/device-link), used to wrap/unwrap sessions for the
 * rest of that page's lifetime, never itself persisted (docs/05-crypto-architecture.md#local-key-storage:
 * "the KEK itself lives only in memory for the session"). A page reload or tab close
 * clears this by construction — the user unlocks again via `unlockLocalIdentity`.
 */
let currentKek: Uint8Array | null = null;
let currentIdentity: import('@comm/crypto').IdentityKeyPair | null = null;

export function setUnlockedIdentity(kek: Uint8Array, identity: import('@comm/crypto').IdentityKeyPair): void {
  currentKek = kek;
  currentIdentity = identity;
}

export function getCurrentKek(): Uint8Array | null {
  return currentKek;
}

export function getCurrentIdentity(): import('@comm/crypto').IdentityKeyPair | null {
  return currentIdentity;
}

export function clearUnlockedIdentity(): void {
  if (currentKek) currentKek.fill(0);
  currentKek = null;
  currentIdentity = null;
}
