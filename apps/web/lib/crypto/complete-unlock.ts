'use client';

/**
 * Every unlock path (login, invite redeem, device-link, biometric/password
 * unlock-gate) calls this instead of `setUnlockedIdentity` directly — the KEK
 * becoming available is also the one moment message-cache.ts's one-time
 * legacy-blob-cache migration can run (see that function's own docstring).
 * Fire-and-forget: a slow/failed migration must never block unlocking the app
 * itself, and it's a safe no-op to retry on the next unlock if it didn't fully
 * finish. Mirrors apps/mobile/lib/features/auth/auth_controller.dart's
 * identically-purposed `_completeUnlock` wrapper exactly — kept as its own
 * file rather than folded into kek-holder.ts, which stays a plain in-memory
 * holder with no storage-layer knowledge, same layering kek-holder.ts's own
 * docstring already establishes.
 */
import type { IdentityKeyPair } from '@comm/crypto';
import { setUnlockedIdentity } from './kek-holder';
import { migrateLegacyMessageCache } from './message-cache';

export function completeUnlock(kek: Uint8Array, identity: IdentityKeyPair): void {
  setUnlockedIdentity(kek, identity);
  void migrateLegacyMessageCache(kek);
}
