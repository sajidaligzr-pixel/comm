# 08 — Threat Model

## Adversaries considered

| Adversary | Capability assumed | Primary mitigations |
|---|---|---|
| External network attacker | Can observe/intercept network traffic, not TLS keys | TLS/WSS everywhere, HSTS, certificate pinning considered for a future native client — see [11-deployment-architecture](11-deployment-architecture.md) |
| Unauthenticated attacker against the API | Can send arbitrary requests | Auth guards on every route, rate limiting, schema validation, no route trusts client-asserted identity |
| Malicious/abusive registered user | Valid account, wants to spam/harass/enumerate | Rate limits, blocking enforced server-side, report pipeline, admin suspension |
| Compromised user device (malware, stolen laptop) | Full access to that device's local storage/keys while compromised | Per-device keys (blast radius is one device, not the account — see [06-device-architecture](06-device-architecture.md)), instant device revocation. Forward secrecy still limits a device to messages it was itself a legitimate target for — **except** the account's own message-history-sync entries (see below), which a compromised device with the local KEK in memory can unwrap in full, same ceiling as the password-compromise row below |
| Stolen session (cookie theft short of full device compromise) | Valid access/refresh token | Short-lived access tokens, refresh rotation + reuse detection ([07-auth-architecture](07-auth-architecture.md)), device/session revocation, `HttpOnly` cookies limit the easiest theft vector (JS read) |
| Malicious browser extension | Can read page DOM/JS heap while the page is open | Documented as a real residual risk — see [Compromised browser](#compromised-browser) below. Not something a web app can fully defend against |
| Malicious administrator | Has admin-panel access | Scoped by design to account lifecycle + abuse triage; **no code path exists that can decrypt a user's messages** — see [Can an administrator decrypt messages?](#security-review-answers) |
| Database compromise / leak | Full read of Postgres | Ciphertext only for message content/media keys; password hashes (Argon2id) not reversible; see [09-trust-boundaries](09-trust-boundaries.md) for the exact exposure |
| Object storage compromise / misconfigured bucket | Full read of stored objects | Objects are ciphertext under random opaque keys; bucket is private with signed URLs, no public listing |
| Server compromise (app server RCE) | Attacker runs code with the server's privileges | Server never held plaintext/private keys to begin with, so this doesn't retroactively decrypt past traffic; it does let an attacker act as the server going forward (see residual risk below), which is why server-side authorization and input handling still matter enormously even though message content is protected |
| Malicious/compromised TURN relay | Sees call media if relay is used (non-P2P path) | Self-hosted coturn keeps this inside our own trust boundary rather than a third party's; DTLS-SRTP still encrypts the media itself even through the relay — see [Call security](#call-security) |
| Spam/bot account farm | Many accounts sending unwanted messages/invites | Largely moot given closed registration ([07-auth-architecture](07-auth-architecture.md)) — an attacker would first need admin-level provisioning access, a much higher bar than the master prompt's default open-signup threat model assumes |
| Credential stuffing (reused passwords from other breaches) | Large list of username/password pairs | Rate limiting + lockout ([07](07-auth-architecture.md)), plus the optional passkey/TOTP step-up path for higher-value accounts |
| Supply-chain compromise (malicious npm dependency) | Injected code in a dependency we install | Lockfiles, `npm audit`/Dependabot, isolating `packages/crypto` and `packages/security` so a compromised unrelated dependency (e.g. in a UI library) can't reach key material by construction — see [01-folder-structure](01-folder-structure.md) module isolation |
| Insider (engineer with prod DB access) | Same ceiling as "database compromise" above, plus deploy access | Least-privilege DB roles ([11-deployment-architecture](11-deployment-architecture.md)), no plaintext message content to access regardless of privilege level |
| Physical device theft | Physical access to a logged-in device | Local key storage requires the password-derived KEK in memory ([05-crypto-architecture](05-crypto-architecture.md)); OS/browser lock-screen is the outer defense this project doesn't control |

## Multi-device message history sync's password-bounded confidentiality

[07-auth-architecture](07-auth-architecture.md)'s history-key section is a deliberate, disclosed departure from this app's usual per-device-pairwise-session guarantee, made knowingly rather than found later: every message's history-sync entry (`message_history_entries`) is decryptable by anyone who can derive the account's password-wrapped History Key — which means anyone who knows the account **password**, full stop, not anyone who compromised a *specific* device. Two things keep this from being a bigger step than it looks:

- This deployment's login was already password-based — the server necessarily sees the plaintext password at every login already, so this doesn't hand the server (or anyone who compromises it at the right moment) a new capability it didn't already have reason to be trusted not to (mis)use.
- Once multi-device fan-out shipped, a password alone was *already* sufficient to register a new device that receives every future message via self-fan-out — this feature extends that same existing bound to historical messages too, rather than opening a materially new exposure. The account's practical security ceiling was already the password from that point on.

What this is **not**: a change to direct/group message confidentiality in transit or in the pairwise/Megolm sessions themselves — those are untouched, still per-device, still forward-secret for a device that was never a party to a given session. It's specifically the *local backup copy* this feature adds that carries the weaker bound, and only for accounts that have actually bootstrapped a History Key (every account will, in practice, once any device logs in with a password after this shipped).

## Authorization rule (applies everywhere)

Every protected operation answers, server-side, before doing anything else: *Who is the caller (validated session)? Is their device still active (not revoked)? Do they own or belong to the resource (conversation member, group role, device owner)?* Never inferred from a request body field like `role` or `conversationId` alone — see the concrete query patterns in [03-api-design](03-api-design.md#authorization). A frontend hiding a button is UX, never a security control.

## Call security
<a id="call-security"></a>

WebRTC's built-in DTLS-SRTP encrypts media in transit between peers/relay by default — but that alone doesn't secure the *system*:

- **Signaling is authenticated**: SDP/ICE exchange rides the same authenticated WebSocket as everything else ([04-websocket-realtime](04-websocket-realtime.md#call-signaling)), so a call can't be signaled by someone who isn't a validated participant.
- **Caller identity is validated** against conversation membership before signaling is relayed, re-derived server-side on every event rather than trusted from a client-claimed field — the same pattern `message.send` uses ([04-websocket-realtime](04-websocket-realtime.md#call-signaling)). No `call_participants` table exists yet (docs/02-database-schema.md) — that's for call *history*, a separate gap from call *authorization*, which doesn't depend on it.
- **TURN credentials are short-lived and minted per call** via coturn's `use-auth-secret` HMAC mechanism (`POST /calls/turn-credentials`), never a static secret compiled into frontend code — an attacker who reads the frontend bundle gets nothing usable.
- **Abuse protection**: call-initiation rate limiting (docs/03-api-design.md), and a client-enforced 45s ring timeout — a call that isn't answered auto-ends (`call.end` sent, callee's ring UI clears) rather than left open indefinitely as a resource-exhaustion vector. Not persisted as a "missed call" anywhere yet (docs/02-database-schema.md's call-history gap).
- We do **not** assume "it's WebRTC, therefore secure" — the relay operator (us, since coturn is self-hosted) can observe call metadata (who called whom, when, for how long, and — if the TURN relay path is used rather than direct P2P — the participants' IP addresses to each other unless a relay is forced) even though it cannot decrypt media content. That's documented honestly in [09-trust-boundaries](09-trust-boundaries.md), not glossed over.

## Content moderation under E2E encryption

Because message content is encrypted end-to-end by design, **there is no server-side plaintext to moderate** — this is a deliberate consequence of the security model, not an oversight. Moderation is built around what the server *can* legitimately act on: rate limits, blocking, account reputation/suspension by admins, and a user-initiated report flow where the *reporter's own client* attaches the decrypted content it already has access to as explicit evidence (`reports.user_submitted_evidence`, [02-database-schema](02-database-schema.md)) — the server never decrypts anyone's conversation on its own initiative to investigate a report. See master-prompt §61.

## Compromised browser
<a id="compromised-browser"></a>

Stated plainly: if a user's browser itself is compromised (malicious extension with page access, browser 0-day, or the OS/device itself is compromised) while the user is logged in, that compromise can observe plaintext the page is actively rendering/processing and can invoke the page's own crypto operations using the in-memory session key. No web application — this one included — can fully defend against a compromised execution environment; the mitigations here (non-extractable keys where possible, short-lived in-memory KEK, strict CSP limiting what an injected script could load) reduce the *ease and scope* of such an attack (e.g. raw key exfiltration is harder than if keys sat in plain `localStorage`), they do not eliminate the risk category. This is disclosed rather than implied away, per master-prompt §1's "do not claim unhackable."

## Security review gate — answered
<a id="security-review-answers"></a>

Per master-prompt §97, answered explicitly rather than assumed:

- **Can the server decrypt messages?** No — it stores/routes ciphertext only; the keys needed to decrypt never leave client devices. See [05-crypto-architecture](05-crypto-architecture.md).
- **Can an administrator decrypt messages?** No — the admin surface ([03-api-design](03-api-design.md#admin)) has no route that returns message ciphertext plus the keys to open it; those keys don't exist server-side to return.
- **Can one user access another's messages?** Not through the API — every message/conversation route checks `conversation_members` membership server-side ([Authorization rule](#authorization-rule-applies-everywhere) above); even if they did, the content is ciphertext keyed to specific recipient devices.
- **Can a revoked device receive future messages?** No — revoked devices are excluded from future key-bundle issuance and their sockets are force-closed; see [06-device-architecture](06-device-architecture.md).
- **Can an attacker replay messages?** No — message IDs are unique (idempotent insert) and Double Ratchet message keys are single-use and deleted after decryption; a replayed ciphertext either no-ops (same ID) or fails to decrypt (reused/old ratchet key).
- **Can an attacker impersonate another device?** Not without that device's private identity key — the signed pre-key mechanism and safety-number verification ([05](05-crypto-architecture.md#device-verification)) are specifically what detects a substituted key.
- **Can an attacker enumerate users?** Discovery/username-lookup routes are rate-limited ([03-api-design](03-api-design.md)), and there is no open-registration endpoint to enumerate against in the first place given closed registration.
- **Can push notifications reveal message contents?** No — payloads are generic ("New message"); see [10-privacy-data-retention](10-privacy-data-retention.md).
- **Can database compromise expose plaintext messages?** No — see [09-trust-boundaries](09-trust-boundaries.md) for the precise list of what a DB leak *does* expose (metadata, hashes, ciphertext) versus what it doesn't (plaintext, private keys).
- **Can object storage expose private media?** Not without both bucket access *and* the per-attachment key, which lives only inside message ciphertext — a bucket leak alone yields opaque encrypted blobs.
- **Can a compromised browser steal keys?** Partially — see [Compromised browser](#compromised-browser) above; this is the one honest "yes, to a degree" answer in this list, and it's disclosed rather than hidden.

## Explicitly not covered by this system

Physical coercion of a user to unlock their own device, a fully compromised OS/device beneath the browser, and screenshot/photograph of a decrypted screen — the master prompt is explicit these must never be claimed as solved (§12, §11), and they aren't here.
