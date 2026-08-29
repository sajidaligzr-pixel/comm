# 02 — Database Schema (PostgreSQL)

Normalized schema. **No table stores plaintext message content, plaintext media, or private key material.** Columns holding ciphertext are named `*_ciphertext` or `*_envelope` to make that boundary visually obvious in every query. This is the logical design; the Prisma schema (`packages/database/prisma/schema.prisma`) is generated from this, one phase's tables at a time — Phase 2 shipped identity/accounts/devices/keys/sessions/security/privacy, Phase 3 added conversations/messages/message_recipients/message_reactions (direct conversations only), and `message_attachments` shipped ahead of schedule alongside the rest of Phase 4's file-attachment pass (docs/13-roadmap.md) — trimmed from this doc's original sketch, see that table's own note below. Tables below not yet in the Prisma schema (`groups`, `calls`, `push_tokens`, etc.) remain forward design for their respective phases, called out inline.

Conventions: primary keys are UUIDv7 (time-orderable, non-guessable-enough combined with app-layer authz — not used as a secrecy boundary by itself). All tables have `created_at timestamptz not null default now()`; mutable tables also have `updated_at` maintained by trigger. Foreign keys default to `ON DELETE CASCADE` for ownership-composition relationships (e.g. a device's keys) and `ON DELETE RESTRICT`/soft-delete where historical integrity matters (e.g. messages referencing a departed user) — called out per table.

## Identity & accounts

### `users`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| username | citext unique not null | `@handle`, immutable-ish (rename = new row in `username_history`, future) |
| display_name | text not null | |
| about | text null | |
| avatar_object_key | text null | points into object storage, not a public URL |
| password_hash | text not null | Argon2id, see [07-auth-architecture](07-auth-architecture.md) |
| must_change_password | boolean not null default false | set whenever the current password was set by something other than the user's own deliberate choice — the bootstrap-admin script, or a future admin-initiated reset. Never set by normal invite redemption, since the invitee already chose their own password there. Enforced server-side on every request, not just a post-login client redirect — see [07-auth-architecture](07-auth-architecture.md) |
| status | enum(`pending_invite`,`active`,`suspended`,`deleted`) not null default `pending_invite` | pending until invite redeemed |
| created_by_admin_id | uuid fk → admins.id | who provisioned this account |
| created_at, updated_at | timestamptz | |

Index: unique on `lower(username)`. No `phone_number` column in v1 (see [07](07-auth-architecture.md) — closed registration removes the need); a nullable `phone_number_encrypted` column is reserved for a future phase, not populated now.

### `admins`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk → users.id unique | an admin is also a regular user account for messaging purposes |
| role | enum(`superadmin`,`support`) not null | `support` can triage reports, not provision/suspend accounts |
| created_at | timestamptz | |

### `invites`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk → users.id | the pending account this invite activates |
| token_hash | text unique not null | SHA-256 of the random invite token; raw token never stored (same principle as password hashing — a DB read shouldn't hand out live credentials) |
| issued_by_admin_id | uuid fk → admins.id | |
| expires_at | timestamptz not null | short-lived, e.g. 72h default |
| redeemed_at | timestamptz null | null = still pending |
| created_at | timestamptz | |

Index: `token_hash`, `(user_id) where redeemed_at is null` partial unique — one live invite per pending user.

## Devices & keys

### `devices`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk → users.id | |
| name | text not null | user-assigned label, e.g. "MacBook", "Pixel 8" |
| device_type | enum(`web`,`android`,`desktop`) not null | |
| status | enum(`active`,`revoked`) not null default `active` | |
| linked_at | timestamptz not null | |
| last_active_at | timestamptz not null | updated on session activity, coarse (not per-request) |
| revoked_at | timestamptz null | |
| revoked_reason | enum(`user`,`admin`,`security_event`) null | |

### `identity_keys`
| column | type | notes |
|---|---|---|
| device_id | uuid pk, fk → devices.id | one identity key pair per device |
| signing_public_key | bytea not null | Ed25519 public key — signs the signed pre-key |
| agreement_public_key | bytea not null | X25519 public key — used in X3DH's DH computations |
| created_at | timestamptz | |

Two separate keys, not one converted key, per [05-crypto-architecture](05-crypto-architecture.md#library-decision) — Ed25519 (signing) and X25519 (DH agreement) stay in their native curves rather than relying on an XEdDSA-style conversion. Both private halves never leave the device.

### `signed_pre_keys`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| device_id | uuid fk → devices.id | |
| key_id | integer not null | monotonic per device |
| public_key | bytea not null | |
| signature | bytea not null | signed by the device's identity key |
| created_at | timestamptz | |
| rotated_at | timestamptz null | superseded, kept briefly for in-flight sessions then GC'd |

Unique: `(device_id, key_id)`.

### `one_time_pre_keys`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| device_id | uuid fk → devices.id | |
| key_id | integer not null | |
| public_key | bytea not null | |
| claimed_at | timestamptz null | set (and the row excluded from future bundle issuance) the instant it's handed out — one-time pre-keys must never be reused |
| created_at | timestamptz | |

Index: `(device_id) where claimed_at is null` — this is the "how many unclaimed prekeys does this device have left" query the client polls to know when to top up.

## Sessions (auth, not crypto-ratchet sessions)

### `sessions`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk → users.id | |
| device_id | uuid fk → devices.id | one auth session belongs to exactly one device |
| refresh_token_hash | text unique not null | hashed, see [07](07-auth-architecture.md) |
| access_token_family | uuid not null | rotation family id, lets us detect refresh-token reuse (theft signal) |
| created_at | timestamptz | |
| last_used_at | timestamptz | |
| expires_at | timestamptz not null | |
| revoked_at | timestamptz null | |
| ip_hash | text null | salted hash, not raw IP — see [10-privacy-data-retention](10-privacy-data-retention.md) |
| user_agent | text null | |

## Conversations & messages

**Phase 3 status: `direct` conversations are shipped.** `type = group` / `group_id` below is the forward design for Phase 5 and is **not yet in the Prisma schema** — the `ConversationType` enum currently only has the `direct` variant, added when the `groups` table lands, per [13-roadmap](13-roadmap.md)'s incremental-phases rule. `disappearing_timer` values are `off`/`h24`/`d7`/`d30` in the actual schema (Prisma enum members can't start with a digit).

### `conversations`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| type | enum(`direct`,`group`) not null | only `direct` exists today; `group` added in Phase 5 |
| group_id | uuid fk → groups.id null | Phase 5, not yet a column |
| disappearing_timer | enum(`off`,`h24`,`d7`,`d30`) not null default `off` | set via `PATCH /api/conversations/:id`; enforced by `apps/worker`'s hourly sweep (jobs/cleanup.ts) — see [13-roadmap](13-roadmap.md) |
| created_at | timestamptz | |

### `conversation_members`
| column | type | notes |
|---|---|---|
| conversation_id | uuid fk → conversations.id | |
| user_id | uuid fk → users.id | |
| joined_at | timestamptz | |
| muted_until | timestamptz null | |
| archived | boolean not null default false | **Shipped** (docs/13-roadmap.md) — per-member, not shared: WhatsApp-style "Archive chat" hides a conversation from just the archiver's own list (`PATCH /api/conversations/:id`, [03-api-design](03-api-design.md)), never the other participant's |
| last_read_message_id | uuid fk → messages.id null | drives unread counts |

Primary key: `(conversation_id, user_id)`.

### `messages`
| column | type | notes |
|---|---|---|
| id | uuid pk | client-generated UUIDv7, see [message ID design](#message-ids) |
| conversation_id | uuid fk → conversations.id | |
| sender_user_id | uuid fk → users.id restrict | keep for authorization/history even if sender later leaves |
| sender_device_id | uuid fk → devices.id restrict | which device actually encrypted this |
| envelope_type | enum(`x3dh_ratchet_1to1`) not null | which crypto path decrypts this — named for the protocol (X3DH + Double Ratchet), not a library, per [05-crypto-architecture](05-crypto-architecture.md#library-decision); a `megolm_group`-equivalent variant is added in Phase 5 |
| envelope_header | bytea null | the Double Ratchet header (sender ratchet pubkey + PN + N, 40 raw bytes) — kept in its own column, separate from `ciphertext`, because it's ratchet routing metadata the recipient's client needs to even attempt decryption, distinct from the AEAD ciphertext itself; both nulled on tombstone |
| ciphertext | bytea null | opaque to the server; nullable so a tombstoned row can null it out |
| x3dh_init | jsonb null | present only on the first message of a brand-new session — the initiator's ephemeral key + which signed/one-time pre-key ids were used, so the recipient can derive the matching session (`packages/crypto`'s `OutboundSessionResult.x3dhInit`); opaque to the server beyond routing it along |
| content_type_hint | enum(`text`,`image`,`media`,`voice`,`location`,`contact`,`reaction`,`system`) not null | needed for client rendering priority/sync, **not** parsed from plaintext — set by sender alongside ciphertext. `image` and `voice` are both shipped via the same inline-ciphertext trick, not the `message_attachments`/object-storage path below. `media` is **also now shipped** (docs/13-roadmap.md's file-attachment pass): the ciphertext column holds a small JSON *descriptor* (object key + AES key/nonce + filename/mime/size, all E2E) rather than the file itself, which lives in object storage under that object key |
| reply_to_message_id | uuid fk → messages.id null | |
| sent_at | timestamptz not null | client-asserted, server also stores `server_received_at` for ordering trust |
| server_received_at | timestamptz not null default now() | |
| edited_at | timestamptz null | |
| deleted_at | timestamptz null | tombstone — see note below |
| deletion_reason | enum(`manual`,`disappearing_timer`,`media_retention`,`viewed`,`account_deleted`) null | shipped alongside media retention (docs/10-privacy-data-retention.md), then extended twice more (the view-once pass; admin account deletion, docs/13-roadmap.md) — set the moment `deleted_at` is, purely so the client can show "deleted" vs. "disappeared" vs. "expired" vs. "opened" vs. "from a deleted account" instead of one generic tombstone message for all of them |

Index: `(conversation_id, server_received_at)` for pagination/sync; `(sender_user_id)` for abuse investigation scoped by report.

**On "deletion":** `deleted_at` marks a tombstone; the row's `envelope_header`/`ciphertext`/`x3dh_init` are nulled out at that point (actual erasure, not just a flag) so a later DB compromise can't retroactively decrypt "deleted" content once keys are eventually rotated. Five independent paths produce this same tombstone shape (all folded into one shared `tombstoneMessages` helper, `server/modules/messages/service.ts`), distinguished only by `deletion_reason`: a manual `DELETE /api/messages/:id`; a recipient opening a `view_once` message (`viewed`); disappearing-message expiry (`apps/worker`'s hourly sweep, triggered by `sent_at` age against the conversation's `disappearing_timer`); media retention (`apps/worker`'s separate `sweepExpiredMedia` — docs/10-privacy-data-retention.md's media retention section — a 24h-always default for `image`/`voice`/`media` content specifically, independent of the conversation's disappearing-timer setting); and an admin deleting the sender's account (`account_deleted`, docs/13-roadmap.md). All five additionally publish a live `deleted` realtime event (carrying `reason`) so participants' locally-decrypted caches — which the tombstone alone can't reach — are scrubbed too, see [04-websocket-realtime](04-websocket-realtime.md). `tombstoneMessages` also deletes every `message_history_entries` row for that message (a real gap fixed alongside introducing this shared helper: nulling `messages`/`message_recipients` alone left a "deleted" message's content still fully recoverable via any participant's History Key on a newly-added device).

**Multi-device sync (shipped, docs/13-roadmap.md):** a `direct` message now reaches every active device of every conversation member — the other participant's, and the sender's own. This turned out NOT to be purely additive to `message_recipients` as originally expected here: a pairwise Double Ratchet session's ciphertext is only valid for the one device it was encrypted for, so `envelope_header`/`ciphertext`/`x3dh_init` had to be added to `message_recipients` itself (nullable — populated per target device for `direct` sends going forward; `group` rows and any `direct` message sent before this shipped keep reading the columns on `messages` above, no backfill needed). `group` conversations still resolve one device per *other* member, not every device — a smaller, separate, still-open gap.

<a id="message-ids"></a>**Message IDs**: UUIDv7 (time-ordered, generated client-side at compose time) doubles as the idempotency key — the ingest endpoint is `INSERT ... ON CONFLICT (id) DO NOTHING`, so retried sends from flaky connections never duplicate (see [04-websocket-realtime](04-websocket-realtime.md)).

### `message_recipients`
Per-recipient-device delivery/read state — necessary because in a multi-device, group world "delivered" isn't a single boolean.

| column | type | notes |
|---|---|---|
| message_id | uuid fk → messages.id | |
| recipient_device_id | uuid fk → devices.id | |
| delivered_at | timestamptz null | |
| read_at | timestamptz null | only recorded if the recipient's privacy setting allows read receipts, see [10](10-privacy-data-retention.md) |
| envelope_header | bytea null | multi-device sync (above) — this device's own pairwise-session envelope for a `direct` message, when fanned out to more than one device. Null for `group` rows and pre-multi-device `direct` rows, which fall back to `messages.envelope_header` |
| ciphertext | bytea null | same fallback rule as `envelope_header` |
| x3dh_init | jsonb null | same fallback rule as `envelope_header` |

Primary key: `(message_id, recipient_device_id)`.

### `message_reactions`
| column | type | notes |
|---|---|---|
| message_id | uuid fk → messages.id | |
| user_id | uuid fk → users.id | |
| emoji | text not null | small allow-listed set validated client- and server-side |
| created_at | timestamptz | |

Primary key: `(message_id, user_id, emoji)`.

Table exists in the Phase 3 schema; no reaction API/UI ships yet (tracked as a Phase 3 follow-up, not a blocker for 1:1 messaging).

### `message_attachments` — **shipped** (docs/13-roadmap.md's file-attachment pass, ahead of the rest of Phase 4)
Trimmed from this table's original sketch: `mime_type_ciphertext` and `blurhash_ciphertext` were dropped because the server never needs them at all — the whole mime-type/filename/size descriptor already travels fully end-to-end inside the parent message's ciphertext (`content_type_hint = 'media'`, see above), and no thumbnailing/blurhash generation exists in this pass. `expires_at` was also dropped: disappearing-message expiry already tombstones the *parent message* (nulling its ciphertext, which is what actually makes the descriptor — and therefore the file's key — unrecoverable); a separate TTL on this row would be redundant, and the orphaned-object sweep below is a different, size/abandonment-driven cleanup, not a message-lifecycle one.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| message_id | uuid fk → messages.id, unique | one attachment per message in this pass (a message is either a file or something else, never multiple files) |
| object_key | text unique not null | random opaque storage path (`crypto.randomUUID()`), see [05](05-crypto-architecture.md) |
| encrypted_size_bytes | bigint not null | server-derived at upload-url mint time, not the client-declared value on the later send request — see [03-api-design](03-api-design.md#media) |
| created_at | timestamptz | |

This table's only real job is authorizing downloads (`GET /media/:objectKey/download-url` joins through it to `messages.conversation_id` for the membership check) and letting `apps/worker`'s hourly sweep (`jobs/cleanup.ts`) tell a linked object from an orphaned one — an object with no matching row here, older than 24h, was uploaded but never successfully attached to a sent message (a dropped connection, a closed tab mid-send) and is deleted.

## Groups — **shipped** (docs/13-roadmap.md's group chat pass, ahead of the original Phase 5 slot)

Trimmed from this section's original sketch: no `avatar_object_key` (group avatars aren't built this pass) and no `group_invite_links` table at all (join-by-link is out of scope this pass — members are added directly by an existing member, admin-only for removal) — both dropped for the same "add a table when the code that uses it lands" rule this file's own header comment already states.

### `groups`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text not null | |
| description | text null | |
| only_admins_can_message | boolean not null default false | Enforced in `sendMessage` (server/modules/messages/service.ts); no settings UI toggles it yet |
| created_at | timestamptz | |

### `group_members`
| column | type | notes |
|---|---|---|
| group_id | uuid fk → groups.id | |
| user_id | uuid fk → users.id | |
| role | enum(`member`,`admin`) not null default `member` | Enforced (`only_admins_can_message`, remove-member); no promote/demote route yet |
| joined_at | timestamptz | |
| removed_at | timestamptz null | Kept (not hard-deleted) — needed to know which Megolm epoch they're excluded from going forward, see [05](05-crypto-architecture.md#group-encryption). The message-visibility gate is a *separate* `conversation_members` row, hard-deleted on removal — that's what actually revokes access immediately via the existing `requireConversationMembership` check |

Primary key: `(group_id, user_id)`.

### `group_sessions`
Bookkeeping for Megolm group-ratchet epochs (not the key material itself — see [05](05-crypto-architecture.md#group-encryption) for why the session *state* lives client-side per member, while this table tracks *which epoch is current* so new/removed members are routed correctly). The server never sees a group's actual chain key — this table only ever records *that* a rotation happened and when.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| group_id | uuid fk → groups.id | |
| epoch | integer not null | increments on every membership removal |
| created_at | timestamptz | |
| superseded_at | timestamptz null | |

Unique: `(group_id, epoch)`.

### `group_key_shares`
The durable device-to-device outbox for group session key material (docs/13-roadmap.md's design note — docs/05 specifies key distribution rides each member's existing 1:1 Double Ratchet session but doesn't specify a transport; this table is that transport). Same envelope shape as `messages.envelope_header`/`ciphertext` — the server relays this exactly as blindly as a 1:1 message, authorized purely by re-deriving group membership for both sender and recipient.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| group_id | uuid fk → groups.id | |
| epoch | integer not null | |
| from_device_id | uuid fk → devices.id | |
| to_device_id | uuid fk → devices.id | |
| envelope_header | bytea not null | |
| ciphertext | bytea not null | |
| x3dh_init | jsonb null | present only if this is the first message of a new pairwise session between these two devices |
| created_at | timestamptz | |
| consumed_at | timestamptz null | set the moment `GET /groups/:id/key-shares` delivers it — a REST response is either fully delivered or the request failed outright, so "fetched" and "consumed" are the same moment here |

Index: `(to_device_id, consumed_at)` — the "what's still pending for my device" query.

## Calls

**Shipped** (apps/mobile's push notification pass — the persistence layer live signaling shipped well ahead of, per this section's original note below). One row per call, written and updated by `server/realtime/message-handlers.ts`'s `call.*` cases as the call resolves — see the `Call` Prisma model's own docstring (schema.prisma) for the exact state machine, and `server/modules/calls/history.ts` for how `GET /api/calls/history` (apps/mobile's "Calls" tab) derives direction and the other party from it.

Trimmed from this doc's original forward sketch below (kept for context, not current): no `type` column (only `voice` exists — add it if/when video calling does), no `end_reason` (the three `CallStatus` values already say everything a call-log UI needs), and no separate `call_participants` table — 1:1-only calling means "the other participant" is always just the conversation's other member; a real, generalizable need only once group calls exist.

### `calls`
| column | type | notes |
|---|---|---|
| id | uuid pk | Client-generated `callId`, same "doubles as the idempotency key" convention `messages.id` uses |
| conversation_id | uuid fk → conversations.id | |
| initiator_user_id | uuid fk → users.id | The caller — `direction` (incoming/outgoing) in the API response is just a comparison against the viewing user |
| status | enum(`answered`,`missed`,`declined`) not null default `missed` | Written at `call.invite`, before either side has acted — the correct default: nothing later resolving it means the caller gave up |
| started_at | timestamptz null | Set at `call.answer` |
| ended_at | timestamptz null | Set at `call.reject`/`call.end` |
| created_at | timestamptz | |

## Notifications, privacy, safety

### `push_subscriptions` — **shipped** (docs/13-roadmap.md's push notification pass, ahead of the rest of Phase 7)
Renamed from this doc's original forward-design `push_tokens` name to match the actual Web Push vocabulary once built (a "subscription," not a "token"); shape also generalized slightly from the original single `endpoint_ciphertext` column.
| column | type | notes |
|---|---|---|
| device_id | uuid pk fk → devices.id | Primary key, not a separate `id` — a device has at most one live subscription; re-subscribing upserts over the old row |
| provider | enum(`web_push`,`fcm`) not null default `web_push` | `fcm` — **shipped** (apps/mobile's push notification pass): apps/worker's push-dispatch.ts sends through Firebase Cloud Messaging for these instead of Web Push |
| subscription_ciphertext | bytea not null | Covers the whole `{endpoint, keys}` object, not just the endpoint — both are required together to actually send a push, so encrypting only one would be a half-measure. Encrypted with a server-held key (`PUSH_SUBSCRIPTION_ENC_KEY`, `packages/security`'s `encryptAtRest`/`decryptAtRest`) — **not** the user's KEK, which `apps/worker` (the only place this is ever decrypted) has no way to obtain |
| created_at | timestamptz | |

### `notification_preferences`
| column | type | notes |
|---|---|---|
| user_id | uuid pk fk → users.id | |
| conversations_default | enum(`all`,`mentions_only`,`none`) not null default `all` | **Enforced** by `apps/worker`'s push dispatch: `none` skips sending. `mentions_only` is currently treated the same as `all` for direct conversations — @mentions don't exist until Phase 5's groups, so there's nothing for that value to mean yet here; group-aware handling is a Phase 5 follow-up, not a bug |
| show_preview | boolean not null default false | **Not yet wired to anything** — the shipped push payload never includes message content regardless of this flag (the server has no plaintext to preview in the first place, docs/09-trust-boundaries.md), so there's currently no behavior for this column to gate. Left in place for when/if a client-side "decrypt then build a richer local notification" path is built (docs/13-roadmap.md's open question on this) |

### `user_privacy_settings`
| column | type | notes |
|---|---|---|
| user_id | uuid pk fk → users.id | |
| last_seen | enum(`everyone`,`contacts`,`nobody`) not null default `contacts` | |
| online_status | enum(`everyone`,`same_as_last_seen`) not null default `same_as_last_seen` | |
| profile_photo | enum(`everyone`,`contacts`,`nobody`) not null default `contacts` | |
| about | enum(`everyone`,`contacts`,`nobody`) not null default `contacts` | |
| read_receipts | boolean not null default true | |
| typing_indicators | boolean not null default true | |
| calls | enum(`everyone`,`contacts`,`nobody`) not null default `contacts` | |
| groups_add_me | enum(`everyone`,`contacts`) not null default `contacts` | |

### `blocked_users`
| column | type | notes |
|---|---|---|
| blocker_user_id | uuid fk → users.id | |
| blocked_user_id | uuid fk → users.id | |
| created_at | timestamptz | |

Primary key: `(blocker_user_id, blocked_user_id)`. Enforced server-side on every message/call/presence path, not just hidden client-side — see [08-threat-model](08-threat-model.md).

### `reports`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| reporter_user_id | uuid fk → users.id | |
| reported_user_id | uuid fk → users.id | |
| conversation_id | uuid fk → conversations.id null | |
| reason | enum(`spam`,`harassment`,`illegal_content`,`other`) not null | |
| user_submitted_evidence | jsonb null | the *reporter's own decrypted copy*, explicitly attached by them — the server never decrypts anything to produce this, see §61 note in [08-threat-model](08-threat-model.md) |
| status | enum(`open`,`reviewing`,`resolved`,`dismissed`) not null default `open` | |
| created_at | timestamptz | |

## Security & audit

### `security_events`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk → users.id | |
| event_type | enum(`login_success`,`login_failed`,`new_device_linked`,`device_revoked`,`password_changed`,`identity_key_changed`,`session_revoked`,`suspicious_login`) not null | |
| device_id | uuid fk → devices.id null | |
| ip_hash | text null | |
| metadata | jsonb null | structured, never free-text containing message content |
| created_at | timestamptz | |

Index: `(user_id, created_at desc)` — this backs the user-facing "Security" activity feed as well as admin abuse triage. See logging rules in [10-privacy-data-retention](10-privacy-data-retention.md) — this table is the *only* place login/device activity is recorded, precisely so it's easy to audit what's retained.

## Deliberately absent

- No `messages_plaintext` anything, no `message_search_index` of decrypted text (search is local-only, see [03-api-design](03-api-design.md#search)).
- No `contacts_uploaded_address_book` table — contact discovery does not ingest a raw address book (see [08-threat-model](08-threat-model.md)).
- No standing `webauthn_credentials` table in v1 — reserved for Phase 9 when optional passkey step-up ships; adding it later is additive, not a migration hazard.
