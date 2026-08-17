# Comm — Flutter client

Native Android/iOS client for the **existing** Comm backend (`apps/web`'s API +
WebSocket layer, `apps/worker`'s background jobs). This app does not run its own
server — every route/event it talks to already exists and is documented in
`docs/03-api-design.md` and `docs/04-websocket-realtime.md` at the repo root.

## Why this exists

The web app (`apps/web`) already covers the full feature set as an installable PWA.
This is a from-scratch native client for the same backend, built because a real
installed app (App Store/Play Store presence, more reliable push, no browser-specific
quirks like the WebRTC audio-routing/CSS issues hit in the PWA) is worth having
alongside it — not a replacement, a second client against the same server.

## Architecture map — where each web-app concept lives here

Every non-trivial piece of client logic in `apps/web` has a direct counterpart here.
Kept side by side deliberately, so a change on one side has an obvious place to land
on the other:

| Concept | apps/web | apps/mobile |
|---|---|---|
| Crypto primitives (X25519/Ed25519/ChaCha20-Poly1305/HKDF) | `packages/crypto/src/primitives.ts` | `lib/crypto/primitives.dart` |
| X3DH key agreement | `packages/crypto/src/x3dh/x3dh.ts` | `lib/crypto/x3dh/x3dh.dart` |
| Double Ratchet | `packages/crypto/src/ratchet/double-ratchet.ts` | `lib/crypto/ratchet/double_ratchet.dart` |
| Group (Megolm-style) ratchet | `packages/crypto/src/group/ratchet.ts` | `lib/crypto/group/ratchet.dart` |
| Argon2id KEK derivation | `packages/crypto/src/storage/key-derivation.ts` | `lib/crypto/storage/key_derivation.dart` |
| Wrap/unwrap local key material | `packages/crypto/src/storage/wrap.ts` | `lib/crypto/storage/wrap.dart` |
| Local device identity storage | `apps/web/lib/crypto/identity.ts` | `lib/crypto/identity/local_identity.dart` |
| Per-device Double Ratchet sessions | `apps/web/lib/crypto/sessions.ts` | `lib/crypto/session/session_store.dart` |
| Raw encrypted local blob store | `apps/web/lib/crypto/db.ts` (IndexedDB) | `lib/data/local/secure_blob_store.dart` (Keychain/Keystore via `flutter_secure_storage`) |
| Local message cache | `apps/web/lib/crypto/message-cache.ts` (IndexedDB) | `lib/data/local/message_cache.dart` (`drift`/SQLite, ciphertext-at-rest) |
| REST client | `apps/web/lib/api-client.ts` | `lib/data/api/api_client.dart` (`dio`) |
| WebSocket client | `apps/web/lib/realtime-client.ts` | `lib/data/realtime/realtime_client.dart` |
| DTOs / wire types | `packages/types/src/*.ts` (zod) | `lib/data/models/*.dart` (`freezed`) |
| Call signaling + WebRTC | `components/call/call-provider.tsx` | `lib/features/calls/` (`flutter_webrtc`) |
| Biometric unlock | `lib/crypto/biometric-unlock.ts` (WebAuthn PRF) | `lib/features/auth/biometric_unlock.dart` (`local_auth`, platform Keystore-backed — see its own doc comment for why this is actually a STRONGER guarantee natively than the WebAuthn-PRF path, not a weaker port) |
| Per-account storage isolation | `apps/web/lib/crypto/active-account.ts` | Same requirement, native equivalent — see `lib/data/local/secure_blob_store.dart` |

**One backend gap, not yet closed as of this file's creation:** push notifications on
`apps/web` run on Web Push/VAPID (`apps/worker/src/realtime/push-dispatch.ts`), which
only works for browser subscriptions. A native app needs FCM (Android) / APNs (iOS)
device tokens instead — a real, separate small backend addition (a second dispatch
path alongside the existing VAPID one, not a replacement of it), tracked as its own
milestone below rather than silently skipped or silently built without flagging it.

## Build sequencing (large project — tracked as milestones, not one shot)

1. **Scaffold** (this commit) — project setup, dependencies, folder structure.
2. **Crypto core** — Dart port of `packages/crypto`, cross-validated against the
   TypeScript implementation's own test vectors so both sides are provably byte-for-
   byte compatible, not just "looks right."
3. **Auth + local identity** — login, invite redemption, device registration,
   Argon2id-derived local KEK, encrypted local identity storage.
4. **Realtime + core messaging** — WebSocket client, conversation list, 1:1 thread
   send/receive/decrypt, delivered/read receipts, typing indicators.
5. **Media + groups** — voice notes, images, file attachments, group chats.
6. **Calling** — `flutter_webrtc`, reusing the existing signaling protocol as-is.
7. **Push (needs the backend addition above) + biometric unlock + admin + polish.**

## Running

Standard Flutter — `flutter run` from this directory. `lib/core/config/` reads the API
base URL from `--dart-define=API_BASE_URL=...` (defaults to `http://10.0.2.2:3000` for
the Android emulator talking to a local `apps/web` dev server; see that file's comment
for the iOS simulator / physical device equivalents).
