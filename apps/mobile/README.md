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
- 1:1 voice calling over `flutter_webrtc`, same WS signaling protocol as the web
  client (interoperates with it unchanged) — native audio routing means the
  browser's speaker-by-default bug doesn't exist here.
- Device management: list linked devices, revoke any of them.
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

## Not built yet

Push notifications (needs the FCM/APNs backend addition above), group voice/video
calling (calling remains 1:1 only, matching the web client), read-receipt "seen by"
UI for groups (per-recipient rows are recorded server-side, just not surfaced in
this client yet).

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
