# Comm — Flutter client

Native Android/iOS client for the **existing** Comm backend (`apps/web`'s API +
WebSocket layer, `apps/worker`'s background jobs). This app does not run its own
server — every route/event it talks to already exists and is documented in
`docs/03-api-design.md` and `docs/04-websocket-realtime.md` at the repo root. It
talks to the real, already-deployed production server (`https://apk4game.com`) by
default — see "Running" below to point it at a local dev server instead.

## Why this exists

The web app (`apps/web`) already covers the full feature set as an installable PWA.
This is a from-scratch native client for the same backend, built because a real
installed app (App Store/Play Store presence, more reliable push, no browser-specific
quirks like the WebRTC audio-routing/CSS issues hit in the PWA) is worth having
alongside it — not a replacement, a second client against the same server.

## Architecture map — where each web-app concept lives here

Every non-trivial piece of client logic in `apps/web` has a direct counterpart here.
Kept side by side deliberately, so a change on one side has an obvious place to land
on the other. (Reflects what's actually in the tree — updated as the app is built,
not written once up front and left stale.)

| Concept | apps/web | apps/mobile |
|---|---|---|
| Crypto primitives (X25519/Ed25519/ChaCha20-Poly1305/HKDF/Argon2id) | `packages/crypto/src/primitives.ts` | `lib/crypto/primitives.dart` |
| X3DH key agreement | `packages/crypto/src/x3dh/x3dh.ts` | `lib/crypto/x3dh/x3dh.dart` |
| Double Ratchet | `packages/crypto/src/ratchet/double-ratchet.ts` | `lib/crypto/ratchet/double_ratchet.dart` |
| 1:1 session API + serialization | `packages/crypto/src/session/*.ts` | `lib/crypto/session/*.dart` |
| Group (Megolm-style) ratchet | `packages/crypto/src/group/*.ts` | `lib/crypto/group/*.dart` |
| Argon2id KEK derivation / local wrap | `packages/crypto/src/storage/*.ts` | `lib/crypto/storage/*.dart` |
| Attachment encryption (AES-256-GCM) | `apps/web/lib/crypto/attachment-crypto.ts` | `lib/crypto/attachment_crypto.dart` |
| Local device identity storage | `apps/web/lib/crypto/identity.ts` | `lib/crypto/local_identity.dart` |
| In-memory KEK holder | `apps/web/lib/crypto/kek-holder.ts` | `lib/crypto/kek_holder.dart` |
| Per-device Double Ratchet sessions | `apps/web/lib/crypto/sessions.ts` | `lib/crypto/sessions.dart` |
| Group session storage | `apps/web/lib/crypto/group-sessions.ts` | `lib/crypto/group_sessions.dart` |
| Group session lifecycle/distribution | `components/group/group-session-provider.tsx` | `lib/features/groups/group_session_controller.dart` |
| Decrypted message local cache | `apps/web/lib/crypto/message-cache.ts` | `lib/crypto/message_cache.dart` |
| Encrypt/decrypt orchestration (1:1) | `apps/web/lib/crypto/conversation-crypto.ts` | `lib/crypto/conversation_crypto.dart` |
| Per-account storage isolation | `apps/web/lib/crypto/active-account.ts` | `lib/storage/active_account.dart` |
| Raw encrypted blob store | `apps/web/lib/crypto/db.ts` (IndexedDB) | `lib/storage/blob_store.dart` (Keychain/Keystore via `flutter_secure_storage`) |
| REST client + CSRF | `apps/web/lib/api-client.ts` | `lib/api/api_client.dart` (`dio` + `cookie_jar`) |
| DTOs / wire types | `packages/types/src/*.ts` (zod) | `lib/api/dtos.dart` (hand-written, mirrors the zod shapes 1:1) |
| WebSocket client | `apps/web/lib/realtime-client.ts` | `lib/realtime/ws_client.dart` |
| Auth flow (login/invite/unlock) | `login-form.tsx` / `unlock-gate.tsx` / `invite-redeem-form.tsx` | `lib/features/auth/*.dart` |
| Router + auth-state redirects | `(app)/layout.tsx`'s server redirect | `lib/app/router.dart` (`go_router`, pure `computeAuthRedirect`, unit tested) |
| Conversation list + thread | `chats-shell.tsx` / `message-thread.tsx` | `lib/features/chats/*.dart` |
| Media upload/download client | `lib/media-client.ts` | `lib/api/media_api.dart` |
| Device management | devices settings page | `lib/features/devices/devices_screen.dart` |
| Call signaling + WebRTC | `components/call/call-provider.tsx` | `lib/features/calls/*.dart` (`flutter_webrtc`) |
| Group CRUD + membership UI | group settings pages | `lib/features/groups/*.dart` |
| Biometric unlock | `lib/crypto/biometric-unlock.ts` (WebAuthn PRF) | `lib/features/auth/biometric_unlock.dart` (`local_auth` + wrapped-KEK — see its docstring for how the mechanism differs from the web's PRF approach) |
| Admin panel (account provisioning/suspension) | `(app)/admin/page.tsx` + `provision-user-form.tsx` | `lib/features/admin/admin_screen.dart` |

**One backend gap, not yet closed:** push notifications on `apps/web` run on Web
Push/VAPID (`apps/worker/src/realtime/push-dispatch.ts`), which only works for
browser subscriptions. A native app needs FCM (Android) / APNs (iOS) device tokens
instead — a real, separate small backend addition (a second dispatch path alongside
the existing VAPID one, not a replacement of it), not built yet.

## What's built and verified

Every item below is wired to the real deployed backend and verified with
`flutter analyze` (clean), the test suite (`flutter test`), and an actual
`flutter build apk --debug` after each milestone — not just "compiles," an
installable binary:

- Account creation via invite link, login (new device + returning device),
  password unlock on a fresh app launch, change-password.
- 1:1 messaging: real X3DH handshake + Double Ratchet, send/receive live over the
  realtime socket, REST history backfill, local encrypted cache (ciphertext is only
  ever decryptable once — the cache is the durable record).
- Group chat: creation, real Megolm-style group ratchet, key distribution over the
  existing 1:1 sessions (with the same concurrency-safety locking the web client
  needed), member add/remove (admin-only for remove), a live retry-once-then-give-up
  path for "haven't received this sender's group session yet."
- File/photo attachments: AES-256-GCM per-file encryption, real object-storage
  upload/download pipeline, decrypt-on-download.
- Voice notes: recorded (AAC-LC, tap-to-start/tap-to-stop, 2-minute cap) and sent
  inline through the same E2E envelope text uses — no object storage, matching
  apps/web's own MediaRecorder-based protocol. Playback via `audioplayers`;
  cross-client format compatibility (this app records AAC, the web client
  records WebM/Opus, and there's no per-message format tag to negotiate it) relies
  on ExoPlayer's content-sniffing rather than a verified guarantee — see
  `_startVoiceRecording`'s docstring in `lib/features/chats/thread_screen.dart`.
- Reply to a specific message: long-press a bubble to stage a reply, preview strip
  above the composer, quoted snippet rendered inside the sent bubble.
- Chat management: delete for everyone (long-press → Delete, sender-only, real-time
  to the other side), disappearing messages (24h/7d/30d, set from the thread's app
  bar, local pruning backed by the worker's authoritative hourly sweep), typing
  indicators (1:1 only, matching web's own scope), archive/unarchive, and a
  WhatsApp-style "Delete chat" (long-press a row in the chat list) that clears this
  device's own local history and hides the conversation until the other side
  messages again — purely local, no server-side "delete a conversation" concept
  exists. Archived chats live on their own page (pushed from an "Archived (N)" row),
  not an inline dropdown.
- 1:1 voice calling over `flutter_webrtc`, same WS signaling protocol as the web
  client (interoperates with it unchanged) — native audio routing means the
  browser's speaker-by-default bug doesn't exist here. Full-screen call UI with
  mute/speaker/end-call, matching WhatsApp's own call-screen layout. A looping
  ringtone plays for an incoming call (`assets/sounds/ringtone.wav`, via
  `audioplayers`), and a short chime plays for a live message arriving in the
  thread that's already open (`assets/sounds/message.wav`) — the one case that
  otherwise stayed silent, since a conversation's own system notification is
  deliberately suppressed while its thread is on screen.
- A "Calls" tab (chats_list_screen.dart's AppBar → Calls) — every 1:1 call, newest
  first, direction/outcome per row (missed calls shown in red, matching WhatsApp),
  tap to call again. Backed by real server-side call history persistence
  (`calls` rows, `GET /api/calls/history`) that didn't exist anywhere in this
  project before this pass — apps/web has no equivalent screen yet, only the API.
- Push notifications via FCM (Android) — real delivery while this app is fully
  closed, not just backgrounded, for both new messages and incoming calls. A call
  push is backed by a durable `GET /api/calls/pending` catch-up (Redis, TTL-matched
  to the 45s ring timeout) since a live `call.ring` WS event has no redelivery of
  its own — tapping the notification opens the app, which then surfaces the real
  in-app ringing screen if the call is still within its window. Deliberately not a
  full-screen, over-the-lock-screen native dialer UI — see "Not built yet" below for
  that scope line. iOS/APNs not wired (no Apple credentials/build in this project
  yet) — Android only for now.
- WS reconnect/resync fixes for three related reported bugs: the chat list, an open
  thread, and delivery/read ticks could all go stale after the app was backgrounded
  (the socket can die silently without ever telling this process — see
  `lib/realtime/ws_client.dart`'s `reconnect` docstring), and read/delivered ticks
  were never re-seeded from a fresh history fetch for messages already cached
  locally. Fixed with a lifecycle-triggered forced reconnect
  (`WidgetsBindingObserver` in app/app.dart), a `'connection.open'` resync hook on
  the chats list and open thread, a `RouteObserver`-based refresh when returning to
  the chat list from a thread, and re-seeding tick state from every REST fetch, not
  only newly-decrypted messages.
- Device management: list linked devices, revoke any of them, plus a one-tap
  "Sign out N other devices" cleanup action — useful because a reinstall (or any
  case where this app's remembered device id gets lost while the old device row
  stays active server-side) registers as a brand-new device rather than reviving
  the old one, the same behavior apps/web's own login flow has.
- Biometric unlock: opt-in (one-time dismissible prompt on first sign-in, or toggle
  any time from the Devices screen), auto-attempted on the unlock screen with the
  password field always available as a fallback, automatically disabled if the
  account password changes elsewhere. See `lib/features/auth/biometric_unlock.dart`'s
  docstring for exactly how this differs from the web client's WebAuthn-PRF-based
  approach (`local_auth` has no equivalent primitive to build the same mechanism on
  mobile) and what that trade-off means.
- Admin panel: create accounts (username/display name only — the invitee sets their
  own password via the invite link), view all accounts, suspend an account. The nav
  entry is gated on a successful `GET /api/admin/users` call (a UI convenience only,
  same non-security-boundary caveat the web client's own `isAdmin()` carries —
  every admin route re-derives the role server-side via `requireAdmin` regardless).

Three real production bugs were found and fixed while verifying this, not just
theorized about: the Android manifest only declared `INTERNET` permission in
debug/profile builds (a release build would've had zero network access),
`image_picker`/`flutter_webrtc` need iOS usage-description keys that weren't present
(missing them crashes the app on first access, not just denies the permission), and
`local_auth` requires the host Activity to extend `FlutterFragmentActivity`, not the
scaffold's default `FlutterActivity` — biometric unlock would have built cleanly and
then crashed at the exact moment a user tapped "Unlock with biometrics."

## Build size & performance

Passed a dedicated optimization pass — asked for directly ("make sure the app is
well optimized... apk need to be small and not laggy... no loose ends"), not left to
whatever the scaffold happened to default to:

- **Dropped four unused dependencies**: `drift` + `sqlite3_flutter_libs` (a
  structured on-device database was the original scaffold's plan, but
  `message_cache.dart` ended up small enough to live on `flutter_secure_storage`
  like everything else — nothing ever imported them; `sqlite3_flutter_libs` alone
  was shipping a full native SQLite binary per ABI for zero use), `freezed_annotation`
  /`json_annotation`/`intl` (models are hand-written, not codegen'd — see
  `api/dtos.dart`'s own docstring). `build_runner`/`freezed`/`json_serializable`
  /`drift_dev` dropped from `dev_dependencies` for the same reason.
- **Release builds now minify + shrink** (`android/app/build.gradle.kts`:
  `isMinifyEnabled`/`isShrinkResources`, off by default in the scaffold). Backed by
  `android/app/proguard-rules.pro` with keep rules for the plugins actually in this
  app that are known to break under R8 — in particular `local_auth`, which has a
  **confirmed, documented crash** (`IllegalAccessError`, flutter/flutter#65381)
  without an explicit keep rule; found and fixed before it ever shipped, not after.
- **Native crypto acceleration was already active** — `cryptography_flutter` wires
  itself in automatically via Flutter's plugin registration (verified in the
  generated registrant), no `enable()` call needed. Every AES-GCM/ChaCha20-Poly1305/
  X25519/Ed25519 operation (the ratchet, X3DH, attachment encryption) already runs
  through the OS-native implementation, not the pure-Dart fallback.
- **Checked, not assumed, for UI-thread jank**: the one genuinely CPU-heavy
  synchronous operation in the app (Argon2id KEK derivation on every login/unlock)
  was benchmarked directly rather than guessed about — ~250ms wall time on this
  machine, with a concurrent timer confirming the isolate keeps servicing other work
  throughout rather than freezing solid. Not worth an `Isolate`/`compute()` offload;
  the existing Argon2id params (`key_derivation.dart`) were already deliberately
  tuned for this. Message lists use `ListView.builder` (lazy, not building
  off-screen rows), the local message cache is capped at 500/conversation, and
  decrypt results are memoized by message id — all pre-existing, checked rather
  than re-done.
- **Result** (this machine, arm64-v8a — the architecture real modern phones use):

  | Build | Size |
  |---|---|
  | Debug (unoptimized, all ABIs, JIT) | 211 MB — not representative, debug builds are never installed by real users |
  | `flutter build apk --release` (no split, all 3 ABIs in one file) | 85 MB |
  | `flutter build apk --release --split-per-abi` (arm64-v8a) | **31 MB** |

  For distribution, `flutter build appbundle --release` (Android App Bundle, the
  Play Store's required upload format) is the actual recommended command — Play
  Store's own Dynamic Delivery does the per-device split automatically, so
  `--split-per-abi` is mainly useful for direct/sideload distribution outside the
  Play Store.

**Honest limit on this pass**: no Android device or emulator is available in this
environment (`flutter devices` only lists macOS desktop/Chrome), so the release
build was verified by `flutter analyze` + `flutter test` (36/36) + the release build
itself succeeding with minification on (which does catch R8 build-time errors, e.g.
a genuinely missing class) — but NOT by installing the minified release build and
clicking through it on a real device, which is the only way to catch a *runtime*
R8 issue like the `local_auth` one above that doesn't fail the build itself. Before
shipping this to real users, do one real install-and-test pass of a release build
specifically exercising: login, unlock, the biometric toggle, sending a message and
a file attachment, and placing a voice call.

## Not built yet

iOS push (Android/FCM only for now — no `GoogleService-Info.plist`/APNs credential
exists, and every build this project has actually shipped has been an Android APK;
see "Push notifications" below for what Android does have), a full-screen,
over-the-lock-screen native calling UI (a real Android `ConnectionService` +
full-screen-intent Activity is a separate, much larger undertaking than a system
notification — see push_notifications.dart's own docstring on the exact scope this
pass settled for instead), group voice/video calling (calling remains 1:1 only,
matching the web client), read-receipt "seen by" UI for groups (per-recipient rows
are recorded server-side, just not surfaced in this client yet), and a call-history
UI on apps/web itself (only apps/mobile has a "Calls" tab so far).

## Running

Standard Flutter — `flutter run` from this directory. Talks to the real deployed
backend by default (see `lib/api/app_config.dart`). To point at a local dev server
instead:

```
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
flutter run --dart-define=API_BASE_URL=http://localhost:3000  # iOS sim / macOS / web
```

## Testing

```
flutter analyze   # static analysis
flutter test      # unit tests — crypto cross-validation, ratchet self-consistency,
                   # router redirect logic
flutter build apk --debug   # verifies the whole thing actually compiles + links,
                             # including native plugins (flutter_webrtc, secure
                             # storage, file/image pickers) — not just Dart-level
```
