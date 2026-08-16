# 05 — Cryptographic Architecture

**No cryptographic primitive or protocol in this document is invented here.** Everything below is either a direct use of an established, independently audited implementation, or (in the documented fallback) a from-spec implementation of a publicly published protocol built only from audited primitive libraries. This document is the one place a security reviewer needs to focus hardest, per the master prompt's review-gate requirement (§97–98).

**Status, stated plainly:** as of Phase 3, 1:1 message encryption described in this document is **implemented** — see [Library decision](#library-decision) for what actually shipped versus the Phase 1 draft's original recommendation, and [Group encryption](#group-encryption) for what's still Phase 5 work (groups aren't built yet). Phase 2's device-registration code used to submit placeholder key material (a throwaway Web Crypto ECDSA keypair) purely to exercise the storage pipeline before real crypto existed; that placeholder is gone as of Phase 3 — `packages/crypto` now generates and uses real key material end to end. Transport in production is still TLS/WSS end-to-end for every request (docs/11-deployment-architecture.md), which protects data in transit at the network layer regardless of phase; it is not a substitute for the application-layer E2E encryption this document describes, and the two are not conflated anywhere in this system's claims.

## Library decision
<a id="library-decision"></a>

**Decided: hand-implement X3DH + the Double Ratchet strictly to Signal's published specifications ([X3DH](https://signal.org/docs/specifications/x3dh/), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)), built only on audited primitive libraries** — `@noble/curves` (X25519 key agreement, Ed25519 signing), `@noble/hashes` (HKDF, SHA-256/512), `@noble/ciphers` (ChaCha20-Poly1305). This is the path the Phase 1 draft of this document flagged as the *documented alternative*, not the original primary pick — the decision-gate spike it called for was run properly (real npm-registry research, not a guess) before Phase 3 committed to code, and it changed the outcome. That research, and why it changed the recommendation, is worth recording rather than silently overwriting:

**What the spike actually found**, checking the real npm registry rather than assuming vodozemac's own audit extends to a browser package:

| Package | License | Maintenance | Fit |
|---|---|---|---|
| `@matrix-org/matrix-sdk-crypto-wasm` | Apache-2.0 | **Official** (matrixdotorg/Element), actively released (new version days before this check), 66+ published versions | Genuinely audited-lineage and production-proven (it's Element's real crypto engine) — but it's the **full Matrix `OlmMachine` layer** (~8.9 MB unpacked): rooms, sync tokens, cross-signing, key backup, SSSS. It's built for a Matrix-protocol client, not a device-centric REST/WS API like ours; adapting our data model to fit it, or fighting its opinionated state machine to use only a slice of it, was judged a worse fit than owning a focused implementation of the same underlying algorithm |
| `vodozemac-wasm-bindings` (community) | Apache-2.0 | Single maintainer, one release, no updates in over a year | Thin, matches our needs — but the WASM *bindings themselves* (as opposed to vodozemac's own Rust core) are an unaudited, effectively unmaintained trust surface. A bug at the JS↔WASM boundary of a hobby project is exactly the kind of thing this system is supposed to avoid depending on |
| `@towns-protocol/vodozemac` (community) | **Proprietary** | Single maintainer/org, one release, over a year old | License alone rules it out for a codebase that otherwise carries no proprietary dependencies |
| `@noble/curves` / `@noble/hashes` / `@noble/ciphers` (the path taken) | MIT | Actively maintained by paulmillr, all three re-released within the week of this check, tens of published versions each, used broadly in production JS cryptography (wallets, `ethers.js`, and others) | Thin, unopinionated, exactly matches what a from-spec Double Ratchet implementation needs — no Matrix-shaped baggage |

In short: there is currently no well-maintained, permissively-licensed, *thin* WASM binding for raw vodozemac in the npm ecosystem — only the full Matrix crypto stack (official but heavy and opinionated) or unmaintained/proprietary community bindings (thin but untrustworthy as a dependency). Given that, implementing the Double Ratchet + X3DH ourselves — a published, peer-reviewed protocol, not something invented here — on top of `noble`'s audited primitives is the better-fitting, lower-risk choice for this system specifically. This is **not** a shortcut: it means the ratchet state machine (DH ratchet steps, symmetric-chain advancement, skipped-message-key handling, X3DH bundle consumption) is code this project owns and must hold to the same review rigor as anything else security-critical — see [Cryptographic testing](#cryptographic-testing) for what that rigor looks like in practice, and `packages/crypto/src/**/__tests__` for where it lives.

Group encryption (Megolm-equivalent) is **not** decided by this choice — it's Phase 5 scope, revisited separately when groups are actually built, per [13-roadmap](13-roadmap.md).

## Key hierarchy

| Key | Algorithm | Lives | Purpose |
|---|---|---|---|
| Identity key | Ed25519 (signing) + its X25519 conversion for ECDH | Device, private half never leaves it | Long-lived per-device identity; public half is what a "security code"/QR comparison verifies (see [device verification](#device-verification)) |
| Signed pre-key | X25519, signed by the identity key | Device | Rotated periodically (e.g. weekly); lets a sender start a session with an offline recipient (asynchronous handshake) |
| One-time pre-keys | X25519 | Device, generated in batches | Each consumed exactly once (server enforces via `claimed_at`, see [02-database-schema](02-database-schema.md)) to give the *first* message in a session additional forward secrecy even if the signed pre-key is later compromised |
| Ratchet root/chain keys | Derived (HKDF-SHA256) | Device, in-memory + encrypted-at-rest per session | Advanced on every message (Double Ratchet), giving forward secrecy (past messages safe if a current key leaks) and post-compromise security (the ratchet heals after a DH ratchet step even if a chain key leaked) |
| Group session key (Phase 5, not yet built) | Symmetric ratchet | Device, per group per epoch | See [Group encryption](#group-encryption) — library choice deferred, not necessarily Megolm given the [Library decision](#library-decision) finding above |
| Attachment key | Random 256-bit, one per file | Ephemeral, carried inside the message envelope | See [Media encryption](#media-encryption) |
| Local storage KEK | Argon2id(password) | Derived at login, held in memory only | Wraps the above at rest in IndexedDB, see [Local key storage](#local-key-storage) |

## Session establishment (1:1)

1. Device B publishes its identity key, current signed pre-key, and a pool of one-time pre-keys to the server at registration/rotation time (`POST /keys/signed-prekey`, `/keys/one-time-prekeys`).
2. Device A, wanting to message B for the first time, fetches a bundle (`GET /keys/bundle/:userId/:deviceId`) — identity key + signed pre-key + one unclaimed one-time pre-key, atomically marked claimed so it's never reused.
3. A performs the X3DH handshake locally (`packages/crypto/src/x3dh`): verifies the signed pre-key's signature against B's identity key (this is what stops a malicious server from substituting its own key — the server relays the bundle but cannot forge a valid signature over a key it controls), then derives the initial shared secret via a sequence of X25519 ECDH operations combining both parties' identity and ephemeral/pre-keys, then HKDFs that into the ratchet's initial root key.
4. Every subsequent message advances the Double Ratchet: a symmetric-key ratchet step per message (forward secrecy) and a Diffie-Hellman ratchet step whenever the conversation "turns" (post-compromise security — see below).
5. If B has multiple devices, A establishes an independent session per device (see [06-device-architecture](06-device-architecture.md)) — there is no single "user-level" session; encryption targets devices, not accounts.

**Forward secrecy**: compromising a device's current ratchet state does not expose earlier messages — old chain keys are deleted immediately after use, not retained.

**Post-compromise security**: because the ratchet re-runs a fresh DH exchange on ongoing message turns, a device that was transiently compromised (attacker read its current chain key) heals — future messages become unreadable to the attacker again once a new DH ratchet step occurs, without any user action.

## Group encryption
<a id="group-encryption"></a>

**Shipped** (docs/13-roadmap.md's group chat pass, ahead of the rest of Phase 5) — exactly as designed below, no changes from the original draft. The [Library decision](#library-decision) finding held for group encryption too: no off-the-shelf Megolm bindings were adopted, for the same maintenance/licensing reasoning as the 1:1 Olm decision. `packages/crypto/src/group/ratchet.ts` is a from-spec group ratchet on the same `@noble/*` foundation as the 1:1 Double Ratchet — same primitives, same "throw on tamper, never return garbage" rule, same bounded skipped-message-key cache pattern (`MAX_SKIPPED_GROUP_MESSAGE_KEYS`) guarding against a malicious/buggy sender skipping a huge counter range to exhaust memory.

The master prompt is explicit that a group must **not** be "one global key forever." A Megolm-style design solves exactly this problem:

- Each group member's device runs its own **outbound** group session (a one-way ratchet) for messages *it* sends to the group, and holds **inbound** session state for every other member's device it has received the session key from (delivered 1:1, over each member's already-established Double Ratchet session — so the group key distribution itself is E2E encrypted device-to-device, never sent to the server in a form it can read).
- The ratchet advances on every message, so a member who joins mid-conversation cannot decrypt history sent before they received the current session's ratchet state (no retroactive access without an explicit "share history" action, which we do not implement by default).
- **On member removal**: the removing action bumps `group_sessions.epoch` in Postgres (bookkeeping only — see [02-database-schema](02-database-schema.md)); every remaining device rotates to a **new outbound group session** and redistributes the new session key 1:1 to only the current member set. The removed member's device still holds the *old* session's ratchet state and can technically advance it forward mathematically, but receives no new session key and is excluded from all future key distribution — so in practice they stop being able to decrypt anything sent after rotation. This is the standard, industry-accepted answer to "remove a member from a ratchet-encrypted group"; there is no cryptographic mechanism that also erases what a removed member already decrypted while they were a legitimate member (no messaging system can do this — flagged explicitly rather than implied).
- **On member addition**: the new member gets the group's *current* outbound session key from each existing member (again via 1:1 sessions), going forward only.

Key distribution itself rides a durable server-side outbox (`GroupKeyShare`, [02-database-schema](02-database-schema.md#group_key_shares)) rather than a fire-and-forget WS event only — this doc's original draft said "delivered 1:1 over each member's Double Ratchet session" without specifying a transport; the outbox is what makes that delivery durable for a member who's offline at share time (`GET /groups/:id/key-shares` catch-up on thread open/reconnect, [03-api-design](03-api-design.md#groups)). The envelope itself is opaque to the server exactly like a 1:1 message's — `encryptForDevice`/`decryptFromDeviceOnce` (`apps/web/lib/crypto/conversation-crypto.ts`) are reused unchanged for this, not reimplemented.

**What shipped doesn't cover yet**: group invite links (add/remove is admin-driven only), promote/demote role UI (the `role` column and its enforcement exist; no UI action to change it), group avatars, and a "seen by" receipt list on group messages (per-recipient delivery/read rows are still recorded, just not surfaced as an aggregated UI).

## Media encryption
<a id="media-encryption"></a>

**Shipped** (docs/13-roadmap.md's file-attachment pass, ahead of the rest of Phase 4) for general files — exactly as designed below, no changes from the original draft. `apps/web/lib/crypto/attachment-crypto.ts` implements the client-side AES-256-GCM step via the browser's native Web Crypto API (`crypto.subtle`) — a deliberately different implementation from the ratchet's own ChaCha20-Poly1305 (`packages/crypto/src/primitives.ts`), since this is a browser-native primitive well suited to large file bytes rather than something that needs to interoperate with the hand-implemented Double Ratchet.

Each attachment gets a fresh random 256-bit AES key and 96-bit nonce, generated client-side via `crypto.getRandomValues`. The file is encrypted with AES-256-GCM before upload; the key+nonce travel *inside* the already end-to-end-encrypted message envelope (so only conversation participants ever see them), never as a URL parameter or separate unencrypted channel. The server receives and stores only ciphertext bytes under a random, non-guessable object key (`crypto.randomUUID()`-derived path, not the original filename) in a private bucket; download requires a short-lived signed URL issued only after a conversation-membership check ([03-api-design](03-api-design.md#media)). GCM's authentication tag means any tampering with the stored ciphertext is detected on decrypt, not silently rendered.

**What shipped doesn't cover yet**: EXIF/metadata stripping (GPS, device info) — designed above as a client-side default per master-prompt §23, but not implemented for this general-file pipeline. Not a silent gap: the existing separate image-message path (`docs/13-roadmap.md`'s image-messages pass, `message-thread.tsx`'s `compressImageForSend`) already re-encodes photos to JPEG client-side, which incidentally strips EXIF as a side effect of the canvas round-trip — general (non-image) files sent through *this* pipeline carry whatever metadata they already had, since there's no generic way to "strip metadata" from an arbitrary file type. A visible per-file toggle is future work, not something to fake with a checkbox that doesn't do anything yet.

## Local key storage
<a id="local-key-storage"></a>

Given the confirmed auth model (username + password, no WebAuthn required for MVP — see [07-auth-architecture](07-auth-architecture.md)), the browser needs a way to protect long-lived identity/session key material at rest without relying on a platform authenticator:

1. At login, the client derives a **local storage key-encryption-key (KEK)** from the account password via **Argon2id** (WASM, e.g. `hash-wasm`), using a per-device random salt stored (not secret) alongside the encrypted blob.
2. `@noble/curves` operates on raw byte arrays, not opaque `CryptoKey` handles (unlike, say, WebCrypto's native ECDSA), so identity/session/group private key material cannot be marked non-extractable at the primitive-library level the way it could with a WebCrypto-native algorithm. The mitigation is at the storage layer instead: raw key material is wrapped with ChaCha20-Poly1305 (`packages/crypto/src/storage/wrap.ts`, the same AEAD construction message encryption itself uses — one audited cipher to review, not two) under the Argon2id-derived KEK before it ever touches IndexedDB, and the KEK — along with any decrypted private key bytes reconstituted for an active ratchet operation — lives only in memory for the session, held in `packages/crypto`'s session objects and never copied into component state, React context, or anywhere else re-renderable/inspectable beyond that. The KEK itself is derived via `hash-wasm`'s WASM Argon2id (browser-compatible; packages/security's Node-native `argon2` binding used for the login password hash cannot run client-side at all, so this is deliberately a separate implementation of the same algorithm for a different purpose — see `packages/crypto/src/storage/key-derivation.ts`).
3. Logging out (or session/device revocation) discards the in-memory KEK; the IndexedDB contents become inert ciphertext until the next successful login re-derives it.

This is **not** equivalent to OS-level secure-enclave storage — a compromised/malicious browser extension or an XSS bug that runs *while the KEK is in memory* can still misuse it (call sign/decrypt operations) even though it can't trivially dump the raw private key. That limitation is inherent to browser-based E2EE and is stated plainly, not hidden — see [08-threat-model](08-threat-model.md) ("compromised browser"). Passkey/WebAuthn as an optional additional unlock factor (Phase 9) would let us bind the KEK to a platform authenticator instead of/in addition to a password-derived one, raising the bar further for users who opt in.

## Device verification
<a id="device-verification"></a>

Each conversation exposes a **safety number / security code**: a human-comparable digest (rendered as both text and a QR code) derived by hashing the sorted identity public keys of the participants' devices. Two users can compare it out-of-band (in person, or read aloud) to confirm no man-in-the-middle substituted a key during the unauthenticated bundle fetch in step 2 of session establishment. The UI states plainly: "This conversation is end-to-end encrypted" with a path to "Verify security code" — not a claim of automatic, invisible verification, since nothing server-side can vouch for a device's identity key (that would reintroduce a trusted third party).

## Identity key changes
<a id="identity-key-changes"></a>

If a contact's identity key changes (device reset, reinstall, or — the case we must not paper over — a compromised server attempting to substitute a key), the client **never silently re-encrypts to the new key**. It surfaces "Security code changed" in the conversation, requires explicit acknowledgment before sending continues, and emits a `key.changed` WS event ([04-websocket-realtime](04-websocket-realtime.md)) so any of the user's other devices show the same warning.

## Cryptographic testing

Covered in depth in [12-testing-strategy](12-testing-strategy.md); summarized here because it's inseparable from the design: known-answer tests against the Signal spec's own published X3DH/Double Ratchet reference vectors where available, encrypt/decrypt round-trip tests, tamper-detection tests (flipped ciphertext bit → decrypt must fail, never silently return garbage), nonce-uniqueness property tests, session-establishment tests across multi-device fan-out, out-of-order/skipped-message-key delivery tests, and a forward-secrecy regression test (prove an old chain key cannot decrypt a message sent after a ratchet step even when handed to a test oracle with full session state). Live in `packages/crypto/src/**/__tests__`.

## What this document does *not* claim

No claim of "unbreakable" or "military-grade" encryption anywhere in this system. The claims are precise: messages are encrypted end-to-end using an independently audited protocol implementation; the server cannot decrypt them under normal operation; forward secrecy and post-compromise security hold for 1:1 and group sessions per the ratchet properties described above; browser-based key storage is protected but not immune to a compromised browser/device. See [09-trust-boundaries](09-trust-boundaries.md) for the full, honest scope statement.
