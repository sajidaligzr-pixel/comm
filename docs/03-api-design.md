# 03 — API Design

**Revision note**: the API is implemented as Next.js App Router Route Handlers inside `apps/web` (no separate NestJS service) — see [00-overview](00-overview.md) and [01-folder-structure](01-folder-structure.md). Route paths below map to Next.js's file-based dynamic segments (e.g. `/devices/:id` is the folder `app/api/devices/[id]/route.ts`); the `:param` notation is kept here as the framework-agnostic way to describe the contract.

**Shipped status**: `/auth`, `/users`, `/devices`, `/admin`, `/audit` (Phase 2), `/keys`, `/conversations`, `/messages` sans reactions (Phase 3), `/calls/turn-credentials` (a Phase 6 slice shipped early), `/push/subscribe`+`/push/unsubscribe` (a Phase 7 slice shipped early), `/media` (the rest of Phase 4 shipped early), and most of `/groups` (Phase 5 shipped early — see below) are implemented and tested. `/contacts`, `/calls/:id/history`, `/privacy`, and the remaining `/groups` routes (invite links, role changes) are forward design for their respective later phases ([13-roadmap](13-roadmap.md)) — not built yet, called out inline.

## Contract approach

Zod schemas in `packages/types` are the single source of truth for every request/response shape. Every Route Handler validates its input through a shared `parseBody()`/`parseQuery()` helper (`apps/web/server/common/validate.ts`) built on those same schemas — rejects on the first schema failure, returns a typed `AppError`, never a stack trace. The rest of `apps/web` imports the same schemas so `tsc` fails the build if client and server drift. An OpenAPI document is generated from the Zod schemas (via `zod-to-openapi`) for external reference/future Android client use — it is generated, not hand-maintained, so it can't silently go stale.

REST is used for request/response CRUD-shaped operations; the WebSocket channel ([04-websocket-realtime](04-websocket-realtime.md)) carries anything push-driven or high-frequency (new messages, typing, presence, call signaling). Nothing is duplicated between the two without a reason — e.g. sending a message is a WS operation with a REST fallback for offline queue flush, not two independent code paths.

## Standard envelope

All responses: `{ ok: true, data: T }` or `{ ok: false, error: { code: AppErrorCode, message: string } }`. `message` is always a safe, user-presentable string — see [Error codes](#error-codes). Pagination uses cursor-based `{ items, nextCursor }`, never offset (offset pagination over a live message table is both slow and racy).

## Module → route map

Every route below starts its handler with `requireAuth(req)` (validates the access token, confirms the session's device isn't revoked, returns `{ userId, deviceId, sessionId }` or throws `AUTH_INVALID`/`AUTH_EXPIRED`) unless marked **public**. Every handler then calls into its module's service function, which runs an authorization check specific to the resource (see [Authorization](#authorization) below) — `requireAuth` proves *who*, the service proves *may they touch this*.

### `/auth`
| Route | Method | Notes |
|---|---|---|
| `/auth/invite/:token` | GET **public** | Validate an invite token before showing the "set your password" screen; rate-limited hard (token-guessing target) |
| `/auth/invite/redeem` | POST **public** | Body: token + password + device's initial key bundle. Creates the device, hashes the password, activates the user. See [07-auth-architecture](07-auth-architecture.md) |
| `/auth/login` | POST **public** | username + password (+ device key bundle if new device). Rate-limited + lockout, see [08-threat-model](08-threat-model.md) |
| `/auth/refresh` | POST | Rotates refresh token (reuse of an old one revokes the whole family — theft signal) |
| `/auth/logout` | POST | Revokes current session only |

### `/users`
| Route | Method | Notes |
|---|---|---|
| `/users/me` | GET/PATCH | display_name, about, avatar |
| `/users/:username` | GET | Returns only fields the requester is allowed to see per the target's `user_privacy_settings` — enforced server-side, not filtered client-side |
| `/users/username-availability` | GET | Only usable by admins when provisioning — not public, since there's no self-serve signup |

### `/devices`
| Route | Method | Notes |
|---|---|---|
| `/devices` | GET | List the caller's own linked devices |
| `/devices/link/start` | POST | Existing authenticated device requests a linking challenge (QR payload), see [06-device-architecture](06-device-architecture.md) |
| `/devices/link/complete` | POST | New device submits proof + its key bundle |
| `/devices/:id` | DELETE | Revoke — caller must own the device (or be the account owner revoking another of their own devices) |

### `/keys`
| Route | Method | Notes |
|---|---|---|
| `/keys/bundle/:userId/:deviceId` | GET | Fetch identity + signed-prekey + one unclaimed one-time-prekey to start an X3DH session ([05-crypto-architecture](05-crypto-architecture.md#library-decision) — not Olm); the returned one-time key is atomically marked claimed |
| `/keys/signed-prekey` | POST | Device uploads a new rotated signed prekey |
| `/keys/one-time-prekeys` | POST | Device tops up its one-time prekey pool |
| `/keys/one-time-prekeys/count` | GET | Device checks its own remaining count |

### `/conversations`, `/messages`
**Shipped, direct (1:1) conversations only.**
| Route | Method | Notes |
|---|---|---|
| `/conversations` | GET | Caller's conversations, cursor-paginated by last activity |
| `/conversations/direct` | POST | Get-or-create a 1:1 conversation with another user |
| `/conversations/:id/messages` | GET | Ciphertext (+ envelope header + x3dhInit where present) page, cursor by `server_received_at` — used for initial sync/backfill; live delivery is WS |
| `/conversations/:id/messages` | POST | REST fallback for offline-queued sends (WS is primary path) |
| `/conversations/:id/read` | POST | Marks the conversation read up to a given message id; publishes a read-receipt event to the other member |
| `/conversations/:id/recipient-device` | GET | Resolves the other member's current active device id for session establishment — membership-gated, see [Authorization](#authorization) |
| `/conversations/:id` | PATCH | Updates `disappearingTimer` (the only mutable conversation setting so far) — either member may change it, enforced by `apps/worker`'s hourly sweep, see [13-roadmap](13-roadmap.md) |
| `/messages/:id` | DELETE | Tombstones + nulls ciphertext/envelope/x3dhInit, see [02-database-schema](02-database-schema.md); also publishes a live `deleted` WS event so the other participant's locally-decrypted cache is scrubbed too, not just the server row |

**Not yet shipped**: blocked-user check on `/conversations/direct` (`blocked_users` table doesn't exist yet — Phase 9's contacts/safety work), `/messages/:id/reactions` (table exists, no route yet).

**Phase 3 scope note**: message sends currently address exactly one recipient device (the other participant's single active device), not true multi-device fan-out — see [02-database-schema](02-database-schema.md#conversations--messages) and the docstring on `getPrimaryRecipientDevice`.

### `/groups` — **shipped** (docs/13-roadmap.md's group chat pass, ahead of the original Phase 5 slot)
| Route | Method | Notes | Status |
|---|---|---|---|
| `/groups` | POST | Creates the group, its conversation, and every initial member's rows in one transaction | Shipped |
| `/groups/:id` | GET/PATCH | PATCH (name/description/`onlyAdminsCanMessage`) requires admin role in `group_members` | Shipped |
| `/groups/:id/members` | POST | Add — any current member may add another | Shipped |
| `/groups/:id/members/:userId` | DELETE | Remove — admin-only, bumps `group_sessions.epoch`, see [05-crypto-architecture](05-crypto-architecture.md#group-encryption) | Shipped |
| `/groups/:id/member-devices` | GET | Resolves each other member's primary device id — what the client targets a key-share at, the group analog of `/conversations/:id/recipient-device` | Shipped |
| `/groups/:id/key-shares` | GET | REST catch-up for pending group session key material (consumed on fetch) | Shipped |
| `/groups/:id/key-shares` | POST | Primary send path for a key-share (durable regardless of WS socket timing — see docs/13-roadmap.md's bug note) | Shipped |
| `/groups/:id/members/:userId/role` | PATCH | Promote/demote — not built; `role` exists and is enforced, no route changes it post-creation | Not yet shipped |
| `/groups/:id/invite-links` | POST/DELETE | Create/revoke | Not yet shipped |
| `/groups/invite-links/:token` | POST | Redeem — joins caller, subject to the group's current settings | Not yet shipped |

### `/media` — **shipped** (docs/13-roadmap.md's file-attachment pass, the rest of Phase 4 shipped early)
| Route | Method | Notes |
|---|---|---|
| `/media/upload-url` | POST | Returns an upload target (a local dev-mode PUT URL, or a real S3 presigned POST with a `content-length-range` condition in production — see [11-deployment-architecture](11-deployment-architecture.md)) + a server-generated random object key; body only declares encrypted size, never the plaintext filename or mime type |
| `/media/:objectKey/download-url` | GET | Short-lived signed GET URL, issued only if caller is a member of the conversation the attachment belongs to |

Differs slightly from this section's original sketch: the request that actually links an uploaded object to a message is `POST /conversations/:id/messages` itself (`SendMessageRequest.attachment`, `apps/web/server/modules/messages/service.ts`), not a separate `/media` call — the object key is claimed against a short-lived Redis pending-upload record (mirrors the one-time-prekey `claimed_at` consumption pattern) inside the same transaction as the message insert, so a message row can never reference an attachment that wasn't actually uploaded by its own sender. The file's key/nonce/filename/mime-type/size travel as a small JSON descriptor inside the ordinary E2E message envelope (`contentTypeHint: 'media'`) — this module never sees or stores any of that, only an encrypted byte count.

### `/contacts` — not yet shipped (Phase 9, per [13-roadmap](13-roadmap.md)'s "deferred" list)
| Route | Method | Notes |
|---|---|---|
| `/contacts` | GET/POST/DELETE | |
| `/contacts/discover` | POST | Privacy-preserving lookup, see [08-threat-model](08-threat-model.md) — never accepts a raw address book |
| `/contacts/block`, `/contacts/unblock` | POST | |
| `/contacts/report` | POST | Maps to `reports` table, requires explicit `user_submitted_evidence` payload the client attaches from its own decrypted view |

### `/calls`
**Live signaling shipped (1:1 audio) — see [04-websocket-realtime](04-websocket-realtime.md#call-signaling) for the actual call setup/teardown, which rides the WS channel, not REST.** This section is just the one REST endpoint calling needs.
| Route | Method | Notes | Status |
|---|---|---|---|
| `/calls/turn-credentials` | POST | Mints a short-lived coturn credential (HMAC `use-auth-secret`, 10-minute TTL), not a static secret — see [11-deployment-architecture](11-deployment-architecture.md). Returns an empty `iceServers` list (not an error) if `TURN_SHARED_SECRET`/`TURN_URLS` aren't configured yet, which is enough for same-network/localhost testing but not real-world NAT traversal | **Shipped** |
| `/calls/:id/history` | GET | Metadata only (duration, participants), never media — waits on the `calls`/`call_participants` tables (docs/02-database-schema.md), not built yet | Not yet shipped |

### `/admin`, `/audit` — shipped (Phase 2)
`POST /admin/users` (provision + generate invite), `POST /admin/users/:id/suspend`, `GET /audit/security-events` (self-scoped) — **no route in `/admin` reads message content, by construction there is no service method that could return it.** `GET /admin/reports` waits on the `reports` table (Phase 9).

### `/privacy` — not yet shipped
Schema (`user_privacy_settings`) exists and is seeded with defaults on invite redemption ([02-database-schema](02-database-schema.md)); no CRUD route over it yet. Straightforward once scheduled — not a design gap, just not built.

### `/push` — **shipped** (docs/13-roadmap.md's push notification pass, ahead of the rest of Phase 7)
| Route | Method | Notes |
|---|---|---|
| `/push/subscribe` | POST | Body: `{ endpoint, keys: { p256dh, auth } }` (the Web Push API's own `PushSubscriptionJSON` shape). Stored against `ctx.deviceId` from the authenticated session — never a client-claimed device id. Upserts: a device only ever has one live subscription |
| `/push/unsubscribe` | POST | Removes this device's subscription row |

No `/notifications` (preferences) CRUD route yet — `notification_preferences` is read (not written) by `apps/worker`'s dispatch, seeded with defaults on invite redemption, but there's no UI or API to change it post-signup. Changing `conversations_default`/`show_preview` today means editing the row directly; a real settings route is still open, same "straightforward once scheduled" framing as `/privacy` above.

## Authorization

Every service function that touches a `conversation_id`, `group_id`, `device_id`, or another user's resource re-derives authorization from the database, never from the request body or JWT claims beyond `userId`/`sessionId`/`deviceId`:

- *Conversation access*: `EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $callerId)`.
- *Group admin actions*: `EXISTS (... WHERE group_id = $1 AND user_id = $callerId AND role = 'admin')`.
- *Device ownership*: `devices.user_id = $callerId` (an account owner can revoke their own other devices; nobody else can revoke anyone's device except an admin acting through a distinct, logged `admin` capability, never the regular `/devices` route).
- *Media download*: joins `message_attachments → messages → conversation_members` for the caller before issuing a signed URL.

This logic lives in each module's service layer (not duplicated per-Route-Handler) so it's reviewed once — see the module-isolation rule in [01-folder-structure](01-folder-structure.md).

## Rate limiting (by route class)

Backed by Redis token buckets, keyed by `(userId or IP, route class)`:

| Class | Example routes | Limit shape |
|---|---|---|
| Auth-sensitive | `/auth/login`, `/auth/invite/redeem` | Low fixed ceiling + exponential backoff after failures, IP- and account-scoped independently |
| Key claim | `/keys/bundle/*` | Moderate — legitimate session-start traffic, but a one-time-prekey-exhaustion DoS target |
| Discovery | `/users/:username`, `/contacts/discover` | Strict, since these are enumeration targets |
| Messaging | `/conversations/:id/messages`, WS `message.send` | Generous (120/min), but capped to block spam bursts — enforced identically on both paths (the WS handler briefly lacked this despite it being documented here; fixed via a security review pass, not left as a silent gap). `image`/`voice` sends additionally share a second, tighter bucket (20/min, `mediaMessageSend`) layered on top — same "heavy inline content needs its own ceiling" reasoning as Uploads below, for the messages that never touch the upload route at all |
| Calling | WS `call.invite` | Strict (6/min) — ringing someone is disruptive in a way a chat message isn't; well above any legitimate retry cadence but stops an account being used to harass via repeated rings |
| Call signaling | WS `call.answer`/`call.reject`/`call.end`/`call.ice-candidate`, `/calls/turn-credentials` | Generous (120/min for the WS events, 20/min for credential minting) — a single call's ICE gathering alone can emit a couple dozen candidates in the first second |
| Uploads | `/media/upload-url` | Per-file size cap (`MEDIA_MAX_UPLOAD_BYTES`, enforced server-side regardless of what a client declares) + rate limiting (20/min) + a **per-account running-total quota** (`MEDIA_ACCOUNT_QUOTA_BYTES`, default 500 MiB, `QUOTA_EXCEEDED` when exceeded) — shipped alongside the media retention pass (docs/10-privacy-data-retention.md), closing the gap this section used to flag as open: a per-file cap alone says nothing about one account sending enough separate files to fill self-hosted disk. Orphaned (uploaded-but-never-sent) objects are also now reclaimed after 1 hour rather than 24 — see `apps/worker/src/jobs/cleanup.ts`'s `sweepOrphanedMediaObjects` |
| Push subscribe | `/push/subscribe` | Modest (10/min) — a legitimate client subscribes once per device per session at most, this just bounds retry loops |
| Everything else | | A conservative default ceiling so no route is accidentally unlimited |

**Payload size**: `MessageEnvelopeUpload.ciphertext` (the actual message content, including voice messages — see [05-crypto-architecture](05-crypto-architecture.md)) is capped at 4 MiB base64 server-side (`packages/types`), independent of any client-side limit (a modified client could ignore a client-only cap) — comfortably above a 2-minute voice note at any reasonable bitrate, but bounded against being used as an arbitrary-blob storage/DoS vector via the `messages.ciphertext` column.

## Error codes
<a id="error-codes"></a>

`AUTH_INVALID`, `AUTH_EXPIRED`, `INVITE_INVALID_OR_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `DEVICE_REVOKED`, `KEY_CHANGED`, `MESSAGE_FAILED`, `MEDIA_TOO_LARGE`, `QUOTA_EXCEEDED`, `VALIDATION_FAILED`, `CONFLICT`, `INTERNAL` (the only code ever shown for an unexpected server-side failure — see error-handling rule in [08-threat-model](08-threat-model.md)). `QUOTA_EXCEEDED` (413, same status as `MEDIA_TOO_LARGE`) is distinct from it: `MEDIA_TOO_LARGE` is about one file exceeding the per-file cap, `QUOTA_EXCEEDED` is the account's running total of live attachments exceeding its storage quota (see Uploads above).

## Search
<a id="search"></a>
There is no server-side message search endpoint. `apps/web` indexes the client's already-decrypted local message cache (IndexedDB, via a lightweight local full-text index) so search never sends plaintext content to the server — see master-prompt §30 and [09-trust-boundaries](09-trust-boundaries.md).
