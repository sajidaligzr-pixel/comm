'use client';

/**
 * Which account's local crypto storage (db.ts's IndexedDB) is in scope for this tab
 * right now — set once, as early as possible, by whichever entry point knows the
 * account being signed into (login-form.tsx, unlock-gate.tsx, invite-redeem-form.tsx,
 * link-device-complete-form.tsx) before any of identity.ts / sessions.ts /
 * message-cache.ts / group-sessions.ts / biometric-unlock.ts's storage calls run.
 *
 * Why this exists: db.ts used to open one single, fixed-name IndexedDB database no
 * matter which account was signed in — a plain per-origin singleton, not scoped to
 * "who's logged in" at all. On a browser used for more than one account (two tabs,
 * two people sharing a machine to test, an admin checking a teammate's account from
 * the same browser they're also signed into themselves), the SECOND account's login
 * would silently reuse the FIRST account's already-stored identity/sessions/device —
 * at best confusing, at worst genuinely destructive: `identity.ts#createLocalIdentity`
 * unconditionally overwrites `identity-bundle`/`kek-salt`, so logging into a second
 * account on the same browser wipes out the first account's Double Ratchet identity
 * and every established session with it.
 *
 * Found live from a real cross-account test: a message showed "delivered" on the
 * sender's side but the recipient's own view showed nothing at all. Traced to the
 * recipient's browser having silently minted a brand-new device mid-session, because
 * an earlier login (a different account, same browser) had overwritten this account's
 * locally-stored identity out from under it — the fresh device had no session history
 * and no way to decrypt a message that was encrypted for the device it replaced.
 *
 * The fix is db.ts opening a separate IndexedDB database per account (see its own
 * comment) rather than trying to namespace individual keys within one shared
 * database — cheaper to reason about (two accounts' data literally cannot collide,
 * ever) and it means `wipeCryptoDb()` (logout/device-revoke) only ever touches the
 * signed-in account's own data, never anyone else's who happens to share the browser.
 */
let activeAccount: string | null = null;

/** Normalizes to the same key regardless of how the username was typed/returned —
 * usernames are already constrained to lowercase at signup (packages/database's
 * bootstrap script, server/modules/auth), so this is just defensive, not a real
 * source of collisions in practice. */
function normalize(usernameOrUserId: string): string {
  return usernameOrUserId.trim().toLowerCase();
}

export function setActiveAccount(usernameOrUserId: string): void {
  const normalized = normalize(usernameOrUserId);
  if (!normalized) throw new Error('setActiveAccount: empty account identifier.');
  activeAccount = normalized;
}

export function getActiveAccount(): string {
  if (!activeAccount) {
    throw new Error(
      'No active account set for local crypto storage — setActiveAccount(username) must run before any identity/session/cache call. See active-account.ts.',
    );
  }
  return activeAccount;
}
