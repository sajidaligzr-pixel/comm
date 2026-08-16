# 07 — Authentication Architecture

## Confirmed model: closed registration, admin-provisioned accounts

There is no public sign-up route. Every account originates from an admin action. This is a deliberate departure from the master prompt's "passkey-first, self-serve" default, made explicit here per the "document the tradeoff" rule:

- **Gain**: the entire public-registration attack surface (fake accounts, registration spam, CAPTCHA arms race, phone-verification cost/abuse) doesn't exist. Every account is traceable to an admin decision.
- **Cost**: onboarding depends on an admin being available/trusted to provision accounts; it doesn't scale to open public sign-up without redesigning this flow later. Acceptable for the stated use case (closed platform).

## Provisioning flow

```
Admin (Settings → Admin → Create User)
  │  display name + username
  ▼
POST /admin/users  → users row (status = pending_invite, no password_hash yet)
  │
  ▼
invites row created: random 256-bit token generated server-side,
only its SHA-256 hash is stored (never the raw token — same
principle as password hashing: a DB read must not hand out a
live credential)
  │
  ▼
Admin shares the raw invite link/code with the person OUT OF BAND
(in person, a secure channel the admin already trusts — this
project does not attempt to secure that hand-off itself)
  │
  ▼
Invitee opens /invite/:token  →  GET /auth/invite/:token validates
(unexpired, unredeemed) before showing the "set your password" screen
  │
  ▼
Invitee sets password client-side → POST /auth/invite/redeem
  { token, password, deviceKeyBundle }
  │
  ▼
Server: Argon2id-hashes the password (raw password never logged,
never stored), marks invite redeemed, marks user active, creates
the first `devices` row from the submitted public key bundle
  │
  ▼
Account active. Admin never saw or received the password —
it existed only in the invitee's browser during that request.
```

This is the "recommended refinement" flagged during planning: **the admin sets identity (name/username), never the credential.** It's what lets a closed/admin-provisioned system still honestly claim the server/admin never possesses a user's password or private keys, matching [09-trust-boundaries](09-trust-boundaries.md).

Invite tokens are short-lived (default 72h, admin-configurable per invite), single-use (`redeemed_at` set atomically on first successful redemption — a race on two simultaneous redemption attempts is resolved by a DB unique constraint, not application logic), and rate-limited hard on the lookup/redeem routes (a guessable-token attack is the main risk here — 256 bits of entropy plus a short window plus rate limiting is the mitigation stack).

## Bootstrapping the first admin

Provisioning requires already being an admin — which is a real chicken-and-egg problem for the *very first* account on a new deployment. That one exception is `packages/database/scripts/bootstrap-admin.ts`, run once by whoever has direct database/environment access:

```
ADMIN_PASSWORD=... npm run db:bootstrap-admin -- --username=admin --name="Admin"
```

It is deliberately **not** an HTTP route — there is no way to reach this capability over the network, only via direct execution against the database. The password goes through an env var, never a CLI flag (flags land in shell history); if `ADMIN_PASSWORD` is omitted, the script generates a random one and prints it exactly once. Either way the account is created with `must_change_password = true` (below) — a script/operator-set credential is never treated as "the user's own" until it's rotated.

## Forced password change

`users.must_change_password` (default `false`) is set whenever a password was chosen by something other than the account's own owner — currently only the bootstrap script; a future admin-initiated recovery reset ([Account recovery](#account-recovery) below still lets the *user* pick their own password at redemption, so it does **not** set this flag).

Enforcement is server-side, on every request, not a one-time post-login redirect: `apps/web/app/(app)/layout.tsx` — the layout every authenticated page under `(app)` renders through — re-checks this flag on every request and redirects to `/change-password` if it's set, before rendering anything else. `/change-password` itself lives outside the `(app)` route group specifically so that redirect can't loop back onto it. `POST /api/auth/change-password` requires the *current* password (session possession alone is deliberately not sufficient to change a credential — see [08-threat-model](08-threat-model.md)'s session-theft case), and on success revokes every other session on the account while leaving the one making the request valid, on the same "a password change is a strong signal to invalidate anything that might be a stolen session elsewhere" reasoning as refresh-token-reuse detection above.

## Login

Username + password only for MVP, per the confirmed decision:

1. `POST /auth/login { username, password, deviceKeyBundle? }`.
2. Server looks up the user, verifies the password against the stored Argon2id hash (constant-time comparison is Argon2id's verify function's job, not something we implement ourselves).
3. On success: if this is a device the account hasn't seen before, a `devices` row is created from `deviceKeyBundle` (exactly as at invite redemption) and a `security_events` row (`new_device_linked`) is recorded — surfaced to the user's other devices so an unexpected new login is visible, not silent.
4. Issues a short-lived access token (JWT, ~15 min) and a refresh token (opaque random, stored only as a hash — see `sessions.refresh_token_hash` in [02-database-schema](02-database-schema.md)), both delivered as `HttpOnly; Secure; SameSite=Strict` cookies — **not** `localStorage**, precisely so a successful XSS can't trivially read them out via `document.cookie`/`localStorage` (see [08-threat-model](08-threat-model.md), XSS). CSRF protection is required *because* we use cookies: a double-submit CSRF token header, checked on all state-changing requests.

**Argon2id parameters**: memory-hard, tuned for the deployment host (documented, not copy-pasted) — target ≥64 MiB memory, ≥3 iterations, 1 lane as a starting point, re-benchmarked against actual production hardware before launch and revisited if hardware changes; parameters are versioned alongside the hash (Argon2id encodes its own parameters in the stored hash string) so they can be upgraded without breaking existing users' ability to log in.

## Brute-force & credential-stuffing protection

- Per-account and per-IP rate limiting on `/auth/login`, independent buckets (an attacker spraying one password across many accounts from one IP is throttled by the IP bucket even if each account's own bucket is fresh).
- Progressive backoff / temporary lockout after repeated failures, with the lockout itself rate-limited so it can't be used to lock a victim out indefinitely via deliberate failed attempts (a bounded lockout window, not permanent).
- `login_failed` and `login_success` both recorded in `security_events` (hashed IP only, no password, no token — see logging rules in [10-privacy-data-retention](10-privacy-data-retention.md)) so patterns (many failures then a success) are visible for suspicious-login detection.
- No password ever appears in a log line, error message, or `security_events.metadata` — enforced by never passing the raw password past the point where it's hashed/verified in the auth service.

## Session/token rotation

Refresh tokens rotate on every use (`POST /auth/refresh` issues a new refresh token and revokes the old one within the same `access_token_family`). **Reuse of an already-rotated-away refresh token revokes the entire family** — this is the standard signal that a refresh token was stolen and both the legitimate holder and the attacker are now racing to use it; revoking on first detected reuse errs toward locking the legitimate user out (forcing re-login) over leaving a stolen token valid.

## Optional step-up factors (Phase 9, not MVP-blocking)

Password is the baseline. WebAuthn/passkey registration and TOTP are designed as **additive** factors a user can enable in Settings → Security once the platform exists, not required to ship v1:

- **WebAuthn/passkey**: adds a `webauthn_credentials` table (deferred from the v1 schema, see [02-database-schema](02-database-schema.md), "Deliberately absent") storing only the public key/credential ID per platform authenticator, never anything that could reconstruct the private key (which never leaves the authenticator by design).
- **TOTP**: standard shared-secret + time-window verification, secret stored encrypted at rest, shown to the user once at enrollment.

This satisfies the master prompt's "optional MFA" language without forcing WebAuthn complexity into the MVP auth flow the user explicitly asked to keep simple.

## Account recovery

Because there's no self-serve password reset flow implied by "admin creates users," recovery for a forgotten password is **admin-mediated**: an admin can trigger a new one-time invite-style reset link for an existing account (same mechanism as initial provisioning, reused), which the user redeems to set a new password. This is explicitly **account recovery** (regaining login access), not **message/key recovery** — resetting the password does **not** recover a lost device's private keys or the messages encrypted to it (see [05-crypto-architecture](05-crypto-architecture.md) and the encrypted-backup note in [13-roadmap](13-roadmap.md), which is out of scope for MVP). This distinction is shown to the user plainly wherever recovery is offered, per master-prompt §43: regaining your account is not the same as recovering old encrypted history if you've lost every device that held the keys.
