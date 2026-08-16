# 10 — Privacy Model & Data Retention

## Principles (master-prompt §76, applied even though this is a closed platform in one jurisdiction initially)

Data minimization, purpose limitation, user control, deletion, export, transparency, security by design. Applied concretely below rather than left as a slogan.

## Metadata the server necessarily sees, and how it's minimized

Restating from [09-trust-boundaries](09-trust-boundaries.md) with retention specifics:

| Metadata | Why it's necessary | Minimization |
|---|---|---|
| Conversation membership | Required to route ciphertext at all | Kept only while the conversation exists; a left/deleted conversation's membership rows are removed |
| Message timestamps | Ordering, sync, delivery UX | Kept with the message; deleted when the message is (tombstoned or expired) |
| Sender/recipient device IDs | Routing | Same lifecycle as the message |
| IP addresses | Abuse/security investigation (brute force, credential stuffing) | **Stored as salted hashes (`ip_hash`), never raw**, on `sessions` and `security_events` only — not logged elsewhere; salted hashing lets us correlate "same IP repeatedly failing login" for abuse detection without retaining the actual address |
| Presence/typing state | Real-time UX | **Not persisted at all** — lives in Redis with short TTLs (typing ~10s, presence tied to socket liveness), never written to Postgres |
| Read receipts | UX (✓✓ Read) | Stored on `message_recipients`, subject to the recipient's own `read_receipts` privacy toggle — if off, `read_at` is simply never written, not written-then-hidden |
| Operational/access logs (Nginx/Caddy, app logs) | Debugging, uptime | Short retention window (target: 14–30 days), documented in [11-deployment-architecture](11-deployment-architecture.md); never contain request bodies for message-send routes |

## Retention periods

| Data class | Retention |
|---|---|
| Text message ciphertext | Until deleted by a participant, or disappearing-timer expiry, whichever first |
| Image/voice/file message content | **24 hours after sending, always** — see "Media retention" below — or sooner if manually deleted or the conversation's disappearing timer is shorter |
| Disappearing messages | Enforced by `apps/worker`'s sweep job against `messages.deleted_at`/`message_attachments.expires_at` per the conversation's `disappearing_timer` setting — see caveat below |
| Deleted/tombstoned messages | Ciphertext nulled immediately on delete (not just flagged) — see [02-database-schema](02-database-schema.md) |
| Operational logs | 14–30 days, rolling deletion |
| `security_events` | Longer, bounded retention (target: 180 days) — long enough to investigate a delayed abuse report, short enough not to become an indefinite surveillance log; user-visible the whole time as their own Security activity feed |
| Expired invites | Purged by `apps/worker` shortly after `expires_at` if never redeemed |
| Expired refresh tokens / revoked sessions | Purged periodically; not kept "just in case" |
| Push token endpoints | Removed when a device is revoked or a push provider reports the endpoint invalid |
| Account deletion | See below — not "soft delete forever" |

Storage being cheap is explicitly rejected as a reason to keep data past its stated purpose (master-prompt §75).

## Disappearing messages — honest scope

Configurable per conversation: Off / 24h / 7d / 30d. Enforcement is **client-driven for the reading device's local copy** (the client deletes its own decrypted local cache entry on expiry) **and server-driven for the ciphertext copy** (the worker sweep nulls/removes the server-held ciphertext and attachment blobs on the same schedule, so it isn't sitting there indefinitely even though the server couldn't read it anyway). What this does **not** and cannot prevent, stated to the user in-product, not buried: a recipient screenshotting, photographing, or copying the message before it expires. No claim of absolute deletion is made — master-prompt §11.

## Media retention — shipped, a storage default, not a privacy feature

Images, voice notes, and file attachments have their content erased **24 hours after being sent, unconditionally** — `apps/worker`'s `sweepExpiredMedia` job (jobs/cleanup.ts), which runs alongside but independently of the disappearing-timer sweep above. This exists to bound storage growth (media is the overwhelming majority of what this app stores; text is negligible by comparison), not as a privacy control — which is exactly why it's framed separately from "Disappearing messages" above rather than folded into it:

- **Not configurable per conversation.** Unlike the disappearing-message timer, there's no "off" setting — every image, voice note, and file is on this clock regardless of what the conversation's disappearing-timer is set to. A per-conversation override (e.g. "keep media forever in this chat") is a real, tracked follow-up — see [13-roadmap](13-roadmap.md) — not built this pass, because it needs its own opt-out UI and a decision about what "off" even means for a default that exists to bound *server* storage rather than protect the user's privacy.
- **Text is never touched by this sweep.** A caption-less photo message's entire plaintext IS the image bytes (there's no separate caption field this pass — see [02-database-schema](02-database-schema.md)), so expiring the media necessarily tombstones that whole message, the same way a manual delete or disappearing-timer expiry does. A text message is unaffected regardless of age.
- **Whichever sweep gets there first wins.** If a conversation's disappearing timer is shorter than 24h (only `h24` ties it exactly), that message would already be tombstoned by the disappearing sweep before the media sweep ever sees it — the two never fight over the same row, they're just two independent queries that both filter on `deleted_at: null`.
- **The client is told, not just silently deleted.** The tombstone placeholder distinguishes *why* a message is gone — "This photo has expired" (media retention) reads differently from "This message was deleted" (manual) or the disappearing-timer case — so a returning user isn't left wondering whether something broke. An explicit Download button is also on every image/voice bubble specifically because of this 24h clock — there's no separate "you have N hours left" warning, so the button being always-visible (not hidden behind a menu) is the mitigation for someone who wants to keep a copy.
- **File attachments are actually reclaimed, not just hidden.** For a `media`-type (file) message, the sweep deletes the underlying object-storage blob (`.data/media-objects/` in dev, the S3 bucket in production) before tombstoning the message row — the storage is genuinely freed, not merely made unreachable through the app.

**24h expiry bounds how long anything sticks around, but not how fast an account can write in the meantime** — a second, independent layer closes that: a per-account running-total quota (`MEDIA_ACCOUNT_QUOTA_BYTES`, default 500 MiB) on live file-attachment bytes, a tighter dedicated rate limit for inline `image`/`voice` sends (which never touch the upload route the quota is enforced on), and a shortened 1-hour reclaim window for uploads that were never linked to a sent message — see [03-api-design](03-api-design.md#rate-limiting-by-route-class) for the specifics. This matters more here than it would on a managed cloud bucket: the whole point of the local-fs storage adapter is running this on the operator's own server, where disk is a real, finite resource, not something that silently scales with a cloud bill.

## Push notifications never contain content

Payloads are limited to generic text ("New message", "New group message") plus enough routing metadata for the client to know which conversation to fetch/decrypt (`conversationId`) — never sender name, message preview, or plaintext, even though many popular messengers do show previews by default. `notification_preferences.show_preview` exists as a **client-side, opt-in-only** setting for whether the *client itself*, after decrypting locally, renders a preview in the OS notification — the server-sent push payload is identical either way. Default is off (master-prompt §51/§92 — privacy is the default, not an opt-out).

## Search stays local

No message content is ever sent to the server for search purposes — see [03-api-design](03-api-design.md#search). This is as much a privacy decision as an architectural one: a server-side search index would be a plaintext copy of message content somewhere the E2E design specifically avoids creating.

## Account deletion & export

- **Delete account**: removes the `users` row's identifying fields, revokes all sessions/devices immediately, and triggers cascading cleanup of the account's conversation memberships. Messages the deleted user sent inside conversations that *other* still-active users are part of are **not** retroactively deleted from those other users' devices/server-held ciphertext (an account owner does not get to erase a group conversation for everyone else by deleting their own account) — this is called out explicitly in the account-deletion UI so it isn't a surprise.
- **Export**: a user can request an export of their own account metadata (profile, device list, security event history, privacy settings) — not other users' data, and not a server-side "export all my message plaintext" feature, since the server doesn't have plaintext to export; message history export is a **client-side** operation against the user's own local decrypted cache.
- Both actions are described in-product in plain language about what is and isn't recoverable, per master-prompt §77.

## No dark patterns (master-prompt §92)

Privacy settings default to the more private option where a reasonable default exists (see `user_privacy_settings` defaults in [02-database-schema](02-database-schema.md) — `contacts`, not `everyone`, for last-seen/photo/about/calls). Deletion and privacy controls are not buried behind extra confirmation friction beyond what prevents accidental clicks. No feature silently uploads a contact list, defaults notification previews on, or makes account deletion harder to find than account creation.
