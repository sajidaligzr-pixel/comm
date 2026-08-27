# 06 — Device Architecture

## Principle

Encryption targets **devices**, not accounts. Every device a user authenticates from generates and holds its own identity key pair locally at setup time — the private half is never exported, backed up in plaintext, copied to another device, or transmitted anywhere, including to the server. This is what makes multi-device support compatible with end-to-end encryption instead of undermining it: there is no "master key" a compromised server could hand out to impersonate a user's device.

## Device record lifecycle

1. **Creation** happens at either invite redemption (`/auth/invite/redeem`, first device on the account) or device linking (below). At creation, the device generates its identity key pair, a signed pre-key, and a batch of one-time pre-keys locally, then uploads only the **public** halves plus the pre-key signature.
2. The server records a `devices` row (name, type, status) and the associated public key rows ([02-database-schema](02-database-schema.md)) — it never sees a private key at any point in this flow.
3. **Active use**: the device periodically rotates its signed pre-key and tops up one-time pre-keys ([05-crypto-architecture](05-crypto-architecture.md)) — routine maintenance, not a security event.
4. **Revocation** (user- or admin-initiated, or automatic on a `suspicious_login` security event) immediately: marks the device `revoked` in Postgres, force-closes its WebSocket connection ([04-websocket-realtime](04-websocket-realtime.md)), invalidates its sessions/refresh tokens, and — critically — **stops issuing it in future key bundles**, so no new sender will start a session with a revoked device. Existing peers are *not* automatically told to re-key (that would require the server to know who's talking to whom beyond routing metadata, which we minimize) but will naturally stop reaching that device once its owner's client removes it from their own device list, and any attempt by the revoked device to reconnect fails at the WS auth boundary.

## Linking a new device

Modeled on the "scan a QR code with your phone" pattern, but implemented without any private key ever crossing the wire:

1. On an **already-authenticated** device (call it the primary), the user opens Settings → Linked Devices → Link New Device. That device requests a linking challenge: `POST /devices/link/start` returns a short-lived (5-minute), single-use linking token plus the primary device's public identity key, rendered as a QR code / shareable link.
2. The **new** device (e.g. a fresh browser session) scans/opens the token and generates its own identity key pair and pre-keys **locally, on itself** — it does not receive or derive its keys from the primary device.
3. The new device calls `POST /devices/link/complete` with the token and its own public key bundle. The token is deleted atomically on first use (a Redis `DEL` whose return value gates success), so a concurrent second redemption attempt of the same token always loses the race.
4. The device is activated **immediately** on successful redemption — see the implementation note below on why this doesn't need a separate primary-device approval round-trip.
5. Once active, the new device is just another device from every other participant's perspective: senders will start independent Olm sessions with it the next time they message this user, exactly as in [05-crypto-architecture](05-crypto-architecture.md#session-establishment-1-1).

There is no "copy my private key to the new device" step anywhere in this flow, by design — see master-prompt §8.

**Implementation note (Phase 2):** the original draft of this section described a further explicit confirmation step — the primary device receiving the new device's public key over the WebSocket channel and requiring a human "confirm?" tap before the server activates it. What's actually implemented treats **possession of the linking token itself** as the confirmation: the token is only ever displayed on an already-authenticated, already-unlocked primary device, short-lived, and single-use — an attacker needs to have had eyes-on access to that unlocked, logged-in device's screen within a 5-minute window to use it at all, which is a materially different (and already high) bar than "guess a stolen token remotely." This matches how comparable "scan this QR/open this link on your other device" linking flows behave in practice (the scan itself is the approval, not a separate second tap) and keeps the flow to one round trip instead of two. A stricter opt-in "also require an explicit tap on the primary device" mode is a reasonable Phase 9 hardening addition, not required for the core guarantee (no private key ever leaves the device it was generated on) to hold.

## Visibility & revocation UI

`GET /devices` returns the caller's own devices with `name`, `device_type`, `linked_at`, `last_active_at`, `status`, and which one is "this device" — rendered as the master prompt's example:

```
Linked Devices
  MacBook            Last active: 2 minutes ago
  Chrome on Windows   Last active: yesterday
  Android             Current device
```

Revoking is a single action (`DELETE /devices/:id`), takes effect immediately server-side (not "on next sync"), and generates a `security_events` row (`device_revoked`) visible in the account's Security activity log — so a user who didn't initiate a revocation (or, conversely, who spots a device they don't recognize) has both the visibility and the one-click response the master prompt requires.

## Multi-device message fan-out ✅

Shipped, for `direct` conversations (docs/13-roadmap.md): a sender addresses a message to *every active device* of every conversation recipient, AND the sender's own other active devices (device-level fan-out happens client-side at encrypt time — one ciphertext per target device, since each has an independent Olm session; see [05](05-crypto-architecture.md)). `message_recipients` tracks delivery/read state per `(message_id, recipient_device_id)`, not per user, and — since this shipped — also carries each `direct` recipient's own `envelope_header`/`ciphertext`/`x3dh_init` (a pairwise session's ciphertext can't be shared across devices the way `group` messages' one Megolm-style session can; `Message`'s own envelope columns stay the source of truth for `group` rows, and for any `direct` message sent before this existed). A message is "delivered" to a user once any of their active devices has it, and the UI's ✓✓ read state is "any of the recipient's devices marked it read," synchronized back to the sender via the same WS fan-out.

`group` conversations now fan out the same way ✅ — `sendMessage`'s group branch resolves every OTHER member's every active device via the same `getAllOtherMembersActiveDeviceIds` helper `direct` already used, plus the sender's own other active devices (previously neither: only one primary device per other member, and never the sender's own other devices). No client-side crypto change was needed for this — every member already shares one Megolm-style group envelope at the `Message` level, so widening the fan-out is purely a server-side "address more devices," not a new ciphertext per device the way `direct`'s fix needed.

## Relationship to authentication sessions

A `devices` row is the cryptographic identity; a `sessions` row ([02-database-schema](02-database-schema.md)) is the login/auth state tied to that device and is what actually expires/rotates/gets revoked on logout. Revoking a *device* always revokes its *session(s)* too (one implies the other), but logging out of a session alone does not delete the device's key material — the device remains "linked" until explicitly revoked, matching normal user expectation ("I signed out but I'm still shown as a linked device until I remove it").
