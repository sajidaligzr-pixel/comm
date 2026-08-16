# 09 — Trust Boundaries

Precisely what each component can see, stated without hedging. No "zero metadata" or "unhackable" claims anywhere below, per master-prompt §1/§74.

## Client (the user's own device)

Sees everything, by necessity — it's the only place plaintext ever legitimately exists:
- Plaintext message content, plaintext decrypted media
- Its own private identity/session/group ratchet keys
- Its own local message cache (IndexedDB), local search index

## Server (`apps/api`, `apps/worker`)

**Sees:**
- Ciphertext of every message and every attachment (opaque, not decryptable without keys it doesn't have)
- Routing metadata: who is a member of which conversation/group, when a message was sent/delivered (timestamps), message sizes, sender/recipient device IDs
- Account metadata: username, display name, about text, avatar, privacy settings, device list, security event history
- Connection metadata: which device is currently connected, coarse `last_active_at`, hashed IP addresses on login/session events (not raw IPs retained long-term — see [10-privacy-data-retention](10-privacy-data-retention.md))
- Call metadata: who called whom, call duration, call type (voice/video), and — only if a call falls back to relayed TURN media rather than direct P2P — the fact that media flowed through our own relay (not its content, since DTRLS-SRTP still encrypts it, but the relay does see participant IP addresses to each other in that path)
- Push token existence (which device wants pushes) — not push payload content, which is generic

**Does not see, structurally (no code path returns it because the data doesn't exist server-side):**
- Plaintext message content or plaintext media
- Private identity/session/group keys, at any point
- The user's password (only its Argon2id hash)
- A raw invite or refresh token (only their hashes — see [07-auth-architecture](07-auth-architecture.md))
- A raw contact/address-book upload (contact discovery is designed to avoid needing one — see below)

## Infrastructure (reverse proxy, hosting provider, coturn relay)

- The reverse proxy/hosting layer sees the same TLS-terminated traffic the API server sees (it's the same trust boundary in this deployment — see [11-deployment-architecture](11-deployment-architecture.md)), plus standard operational logs (request timing, status codes) subject to the retention limits in [10-privacy-data-retention](10-privacy-data-retention.md).
- coturn (self-hosted, our own infrastructure — see [08-threat-model](08-threat-model.md#call-security)) sees call signaling-adjacent network metadata and, only on the relayed (non-P2P) media path, participant IP-to-IP traffic — never call content, which stays DTLS-SRTP encrypted end-to-end through the relay.
- None of this infrastructure is a third party in this deployment (self-hosted per the confirmed decisions), so "infrastructure" and "server operator" are the same trust boundary here — stated explicitly since that's a meaningful difference from, e.g., relying on a third-party managed TURN/push provider.

## Push providers (Web Push service, and FCM once an Android client exists)

- See only that *a* push needs delivering to *a* registered endpoint, with a generic payload ("New message") — never message content. See [10-privacy-data-retention](10-privacy-data-retention.md) and master-prompt §27/§58.
- The push endpoint URL itself is treated as sensitive (it can identify a device to its browser vendor) and is stored encrypted at rest server-side (`push_tokens.endpoint_ciphertext`, [02-database-schema](02-database-schema.md)), decrypted only at the moment of dispatch.

## Contact discovery — no raw address book

If/when contact discovery ships (see [13-roadmap](13-roadmap.md) — not in the MVP scope, flagged here because it's a common place this boundary gets violated): the client never uploads a raw address book. The intended approach is a privacy-preserving matching scheme (e.g., client-side hashing of normalized contact identifiers with a private-set-intersection-style protocol, or at minimum k-anonymized/salted lookups rather than a bulk upload) — the exact mechanism gets its own design review before implementation, per master-prompt §98 ("when uncertain about a security-sensitive implementation, research established approaches, don't guess"). This document commits only to the constraint: no bulk plaintext address book ever reaches the server.

## Admin capability, precisely

Admins (`admins` table, [02-database-schema](02-database-schema.md)) can: provision accounts, issue reset invites, suspend/reactivate accounts, view abuse reports (including reporter-submitted evidence, which the reporter explicitly attached from their own decrypted view), view rate-limit/security-event aggregates, and revoke a device on behalf of a locked-out user. Admins **cannot**: read any user's message content, read any user's private keys (none exist server-side to read), or silently decrypt a conversation to "investigate" it without that conversation's own participants explicitly reporting/sharing content. This is the "admins operate the infrastructure; they do not own the user's private conversations" principle from master-prompt §60, made concrete.

## Summary table

| Data | Client | Server | Infra (self-hosted) | Push provider |
|---|---|---|---|---|
| Message plaintext | ✅ | ❌ | ❌ | ❌ |
| Message ciphertext | ✅ | ✅ | ✅ (transits) | ❌ |
| Private keys | ✅ (own only) | ❌ | ❌ | ❌ |
| Routing metadata (who/when) | ✅ | ✅ | ✅ (transits) | ❌ |
| Password | ✅ (own, transient) | Argon2id hash only | ❌ | ❌ |
| Call media content | ✅ | ❌ | ❌ (encrypted transit only) | n/a |
| Call metadata (who/when/duration) | ✅ | ✅ | ✅ | n/a |
| Push payload | ✅ (decrypted locally) | Opaque trigger only | n/a | Generic text only |
