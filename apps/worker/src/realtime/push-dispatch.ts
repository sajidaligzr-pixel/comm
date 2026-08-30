/**
 * Push notification dispatch (docs/13-roadmap.md's push notification pass, shipped
 * ahead of the rest of Phase 7; extended for apps/mobile's FCM path) — subscribes to
 * the same `MESSAGE_EVENTS_CHANNEL`/`CALL_EVENTS_CHANNEL` `apps/web`'s WS layer
 * already publishes onto (docs/04-websocket-realtime.md), the same shared-channel
 * pattern `jobs/cleanup.ts` already established for `deleted` events. Deliberately
 * NOT a BullMQ consumer (see index.ts's note on why that infrastructure isn't
 * adopted yet) — Redis pub/sub is already the right shape for "react to an event,"
 * no queue/retry semantics needed for a best-effort push.
 *
 * This is the one place `push_subscriptions.subscription_ciphertext` is ever
 * decrypted (docs/02-database-schema.md) — kept out of apps/web's hot request path
 * entirely, so a slow/failing push provider can never add latency to sending a
 * message or ringing a call.
 *
 * Two independent providers, chosen per-subscription by its stored `provider`
 * column (never inferred from the decrypted shape — see push/service.ts's
 * `savePushSubscription`): `web_push` (existing browser clients, VAPID) and `fcm`
 * (apps/mobile — Firebase Cloud Messaging, the one delivery layer that can wake a
 * fully-closed Android app; see .env.example's `FCM_SERVICE_ACCOUNT_JSON`). Either
 * can be unconfigured independently — a deployment with only VAPID keys set still
 * pushes to browsers, one with only the FCM credential still pushes to phones.
 */
import http2 from 'node:http2';
import webpush from 'web-push';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { prisma, PushProvider } from '@comm/database';
import { createRedisSubscriber, decryptAtRest } from '@comm/security';
import {
  MESSAGE_EVENTS_CHANNEL,
  CALL_EVENTS_CHANNEL,
  type MessageEvent,
  type CallEvent,
  type PushSubscriptionRequest,
  type FcmPushSubscriptionRequest,
} from '@comm/types';

type AnyStoredSubscription = PushSubscriptionRequest | FcmPushSubscriptionRequest;

function pushEncKey(): string {
  const key = process.env.PUSH_SUBSCRIPTION_ENC_KEY;
  if (!key) throw new Error('PUSH_SUBSCRIPTION_ENC_KEY is not set. See .env.example.');
  return key;
}

function decodeSubscription(ciphertext: Buffer): AnyStoredSubscription {
  const plaintext = decryptAtRest(pushEncKey(), ciphertext);
  return JSON.parse(plaintext.toString('utf8')) as AnyStoredSubscription;
}

/** Mirrors the sidebar/reply preview labels components/chat/conversation-list.tsx
 * and message-thread.tsx already use for these two content types — same metadata
 * (`contentTypeHint` is sender-asserted routing info, never parsed from plaintext,
 * docs/03-api-design.md), same wording, just in a push notification instead of a UI
 * string. */
function bodyFor(contentTypeHint: string, senderName: string): string {
  if (contentTypeHint === 'voice') return `${senderName} sent a voice message`;
  if (contentTypeHint === 'image') return `${senderName} sent a photo`;
  return `New message from ${senderName}`;
}

async function sendWebPush(subscription: PushSubscriptionRequest, payload: unknown): Promise<void> {
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

/**
 * Data-only by default, deliberately — an FCM message that includes a top-level
 * `notification` is auto-displayed by the OS while this app is backgrounded and
 * never reaches Dart at all, which is exactly wrong for the call case (needs code
 * to run, not just a tray icon). Calls (and Android messages) keep exactly that
 * shape: `firebaseMessagingBackgroundHandler`/the foreground listener
 * (push_notifications.dart) turn the data into an actual system notification via
 * flutter_local_notifications, matching how it already looks whether it came live
 * over WS or cold via push.
 *
 * `alert` is the one deliberate exception — passed only for a `message` push
 * (`handleNewMessage` below), and only affects the `apns` block (Android's own
 * `android.priority` config, and the FCM tokens it targets, are untouched by it
 * either way). Found live: "notification not instant, and mostly doesn't come at
 * all once the app is closed" — reported on iOS specifically, never Android, and
 * for good reason. A pure `content-available` push like the one this function
 * used to always send for messages too is exactly what Apple calls a *silent*
 * push: delivery is explicitly best-effort, throttled by the app's background
 * budget, and outright suspended once the user has force-quit the app — none of
 * which ever applied to Android's own FCM data-message delivery, which is why "it
 * works fine on Android" was true the whole time. A real `alert` (+ `sound`) is a
 * VISIBLE push instead: Apple's own notification center displays it directly,
 * promptly, and regardless of the app's own process/background-budget state —
 * the same guarantee Android's data-only path already had by a different route.
 * `data` (this device's own conversationId/messageId for the delivered-ack) still
 * rides alongside it unchanged; push_notifications.dart's own `_showFromData`
 * skips re-rendering its OWN local notification on top of this native one for
 * exactly this case (see that file's own docstring) rather than double-banner-ing.
 */
async function sendFcm(token: string, data: Record<string, string>, alert?: { title: string; body: string }): Promise<void> {
  await getMessaging().send({
    token,
    data,
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          contentAvailable: true,
          ...(alert ? { alert: { title: alert.title, body: alert.body }, sound: 'default' } : {}),
        },
      },
    },
  });
}

/** `statusCode`/`code` shapes differ between web-push (HTTP-status-like) and
 * firebase-admin (its own string error codes) — both funnel through here so both
 * dispatch functions below share one "this subscription is dead, stop trying it"
 * cleanup instead of duplicating the try/catch twice. */
async function isGoneError(err: unknown): Promise<boolean> {
  const statusCode = (err as { statusCode?: number }).statusCode;
  if (statusCode === 404 || statusCode === 410) return true;
  const code = (err as { code?: string }).code;
  return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token';
}

async function dispatchTo(
  deviceId: string,
  payload: { messagePayload?: unknown; fcmData?: Record<string, string>; iosAlert?: { title: string; body: string } },
): Promise<void> {
  const subRow = await prisma.pushSubscription.findUnique({ where: { deviceId } });
  if (!subRow) return; // most devices won't have push enabled at all — normal, not an error

  const subscription = decodeSubscription(subRow.subscriptionCiphertext);
  try {
    if (subRow.provider === PushProvider.fcm) {
      if (!fcmConfigured || !payload.fcmData) return;
      await sendFcm((subscription as FcmPushSubscriptionRequest).token, payload.fcmData, payload.iosAlert);
      // Success-path visibility for calls specifically (rare/high-stakes events,
      // unlike the per-message push below) — until now this whole function was
      // silent on success, so a report of "the phone never rang" had nothing
      // server-side to confirm or rule out FCM actually accepted the send.
      if (payload.fcmData.type === 'call' || payload.fcmData.type === 'call-end') {
        console.log(`[worker] ${payload.fcmData.type} FCM push accepted for device ${deviceId}`);
      }
    } else {
      if (!vapidConfigured || !payload.messagePayload) return;
      await sendWebPush(subscription as PushSubscriptionRequest, payload.messagePayload);
    }
  } catch (err) {
    if (await isGoneError(err)) {
      // Subscription expired/was revoked/uninstalled on the client's end — clean it
      // up rather than retrying a dead target on every future event.
      await prisma.pushSubscription.deleteMany({ where: { deviceId } });
    } else {
      console.error('[worker] push dispatch failed', err);
    }
  }
}

async function handleNewMessage(event: Extract<MessageEvent, { type: 'new' }>): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: event.targetDeviceId }, select: { userId: true } });
  if (!device) return; // device was revoked/deleted between the message being sent and this running

  const prefs = await prisma.notificationPreference.findUnique({ where: { userId: device.userId } });
  // 'none' is the only value that suppresses a direct-conversation notification —
  // 'mentions_only' has no meaning for a 1:1 conversation yet (no @mentions exist
  // until Phase 5's groups), so it's treated the same as 'all' here rather than
  // silently dropping every direct message for someone who chose it expecting only
  // group-chat muting.
  if (prefs?.conversationsDefault === 'none') return;

  const sender = await prisma.user.findUnique({
    where: { id: event.message.senderUserId },
    select: { displayName: true },
  });
  const senderName = sender?.displayName ?? 'someone';
  const body = bodyFor(event.message.contentTypeHint, senderName);

  await dispatchTo(event.targetDeviceId, {
    messagePayload: { title: 'Comm', body, conversationId: event.message.conversationId },
    // `messageId` lets the receiving client fire a delivered-ack the instant the push
    // itself arrives (apps/mobile's push_notifications.dart `_ackDelivered`) rather
    // than waiting for a screen with a live WS listener to eventually open — closes
    // the gap where a message delivered only via push (app closed/backgrounded) left
    // the sender's tick stuck on "sent" until the recipient happened to open the app.
    // No web_push equivalent needed: `messagePayload` already goes through
    // chats-shell.tsx's live 'new' handler, which acks delivery itself once decrypted.
    fcmData: { type: 'message', conversationId: event.message.conversationId, messageId: event.message.id, title: 'Comm', body },
    // See sendFcm's own docstring — the one push type that gets a real native
    // alert instead of staying silent-only, specifically to fix iOS's
    // notification-reliability gap.
    iosAlert: { title: 'Comm', body },
  });
}

/**
 * Apple PushKit VoIP push (docs/13-roadmap.md's iOS closed-app-ringing pass,
 * docs/07-auth-architecture.md's calling section) — the ONLY delivery path that
 * reliably wakes a fully-closed iOS app to ring an incoming call the way Android's
 * FCM data push already does; a regular remote-notification can't. Firebase/FCM has
 * no `apns-push-type: voip` option, so this bypasses it entirely and talks straight
 * to Apple's APNs HTTP/2 API, authenticated via the VoIP Services Certificate
 * (docs on obtaining one: apps/mobile's ios/Runner/AppDelegate.swift docstring) —
 * certificate-based mTLS, not the JWT/token auth the regular APNs Auth Key uses,
 * matching flutter_callkit_incoming's own documented setup for this plugin.
 */
let apnsVoipCert: string | null = null;

/** `APNS_VOIP_PEM` is the full contents of the `.pem` produced by
 * `openssl pkcs12 -in VoIP_Services_Certificate.p12 -out VOIP.pem -nodes -clcerts`
 * (certificate + private key concatenated in one file, no passphrase after
 * `-nodes`) as one env var — same "everything through env vars, nothing read from a
 * mounted file" convention `FCM_SERVICE_ACCOUNT_JSON`/VAPID keys above already use.
 * Node's TLS layer reads whichever PEM block type it needs out of a combined
 * string, so the same value works for both the `cert` and `key` connect options
 * below. */
function configureApnsVoip(): boolean {
  const pem = process.env.APNS_VOIP_PEM;
  if (!pem) return false;
  apnsVoipCert = pem;
  return true;
}

/** Distinguishes "this token is dead, stop trying it" from every other failure —
 * same job `isGoneError` does for FCM/web-push, just against APNs' own status
 * codes/reasons (410 Unregistered is the expected "uninstalled/token rotated"
 * case; 400 BadDeviceToken covers a malformed/stale one slipping through). */
function isApnsGoneStatus(status: number | undefined, reason: string): boolean {
  return status === 410 || (status === 400 && reason === 'BadDeviceToken');
}

async function sendApnsVoip(token: string, payload: Record<string, unknown>): Promise<void> {
  if (!apnsVoipCert) throw new Error('APNs VoIP is not configured');
  // Bundle ID matches apps/mobile/ios/Runner.xcodeproj's PRODUCT_BUNDLE_IDENTIFIER —
  // the VoIP topic is always that bundle ID with a literal `.voip` suffix, Apple's
  // own fixed convention, not a separately-configurable value.
  const topic = 'com.comm.commMobile.voip';

  await new Promise<void>((resolve, reject) => {
    // Always the production APNs host: apps/mobile's entitlements comment notes
    // Xcode swaps aps-environment to "production" automatically for an
    // Archive/TestFlight/App-Store build (which is the only kind this app ships),
    // and the sandbox host only accepts tokens from a development-signed build.
    const client = http2.connect('https://api.push.apple.com', { cert: apnsVoipCert!, key: apnsVoipCert! });
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'apns-topic': topic,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status: number | undefined;
    let body = '';
    req.on('response', (headers) => {
      status = headers[':status'] as number | undefined;
    });
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      client.close();
      if (status === 200) {
        resolve();
        return;
      }
      let reason = '';
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason ?? '';
      } catch {
        // Non-JSON/empty body — reason stays '', isApnsGoneStatus still works off status alone.
      }
      if (isApnsGoneStatus(status, reason)) {
        reject(Object.assign(new Error(`APNs VoIP push rejected: ${status} ${reason}`), { apnsGone: true }));
        return;
      }
      reject(new Error(`APNs VoIP push failed: ${status} ${reason || body}`));
    });
    req.on('error', (err) => {
      client.close();
      reject(err);
    });
    req.end(JSON.stringify(payload));
  });
}

/** Same "this app's own encryption key, not the raw token" convention as
 * `decodeSubscription` above — the VoIP token is stored as plain UTF-8 bytes, not
 * JSON (see `saveVoipPushToken`, apps/web/server/modules/push/service.ts), since
 * there's only ever the one shape to store, unlike FCM/web_push's union. */
function decryptVoipToken(ciphertext: Buffer): string {
  return decryptAtRest(pushEncKey(), ciphertext).toString('utf8');
}

/** No web_push equivalent — browsers ringing from a fully-closed tab was never in
 * scope (docs/13-roadmap.md), only apps/mobile asked for this. An iOS device with a
 * registered VoIP token (see VoipPushToken's own schema doc comment) gets ONLY the
 * VoIP push below, never also the FCM one — a regular remote-notification alongside
 * it would be redundant at best (this app has no video calling) and unreliable at
 * worst (Apple throttles/delays plain background pushes in a way that defeats the
 * whole point of ringing promptly). Android (no VoipPushToken row ever exists for
 * it) and an iOS device that hasn't registered one yet both fall through to the
 * existing FCM path unchanged. */
async function handleCallRing(event: Extract<CallEvent, { type: 'call.ring' }>): Promise<void> {
  console.log(`[worker] call.ring received for device ${event.targetDeviceId}, call ${event.callId}`);
  if (apnsVoipConfigured) {
    const voipRow = await prisma.voipPushToken.findUnique({ where: { deviceId: event.targetDeviceId } });
    if (voipRow) {
      const token = decryptVoipToken(voipRow.tokenCiphertext);
      try {
        await sendApnsVoip(token, {
          id: event.callId,
          nameCaller: event.fromDisplayName,
          handle: '',
          isVideo: false,
          extra: { conversationId: event.conversationId },
        });
      } catch (err) {
        if ((err as { apnsGone?: boolean }).apnsGone) {
          await prisma.voipPushToken.deleteMany({ where: { deviceId: event.targetDeviceId } });
        } else {
          console.error('[worker] APNs VoIP push failed', err);
        }
      }
      return;
    }
  }

  await dispatchTo(event.targetDeviceId, {
    fcmData: {
      type: 'call',
      conversationId: event.conversationId,
      callId: event.callId,
      fromDisplayName: event.fromDisplayName,
    },
  });
}

/** Tells a device that may be showing CallKit's incoming-call UI (because a
 * `call.ring` push woke it from a fully-closed state — see `handleCallRing`
 * above) to dismiss it: the caller cancelled/hung up before this device
 * answered, or the call was answered/declined on another of this user's
 * devices. Without this, a device that was woken purely by a push (no live
 * WS — call_controller.dart's `CallController` never runs at all until the
 * app is genuinely reachable) keeps ringing until its own local ~45s
 * no-answer timeout even though the call is already over.
 *
 * iOS gets its own APNs VoIP push here (mirrors `handleCallRing` above),
 * checked first exactly like that function — NOT left to fall through to the
 * WS-reconnect assumption this used to rely on there ("the VoIP push spins up
 * the full Flutter engine, which reaches CallController's live WS far more
 * reliably than Android's background isolate does"). That assumption doesn't
 * hold up in practice: reported live as the exact same "cancel a call, it
 * keeps ringing" bug this dispatch already fixed for Android, just for a
 * different reason (a genuine push-delivery gap — establishing the WS
 * connection and resyncing state still takes real wall-clock time a
 * freshly-woken cold launch doesn't reliably have, not a wake-lock left
 * held). AppDelegate.swift's own `didReceiveIncomingPushWith` distinguishes
 * this from a real incoming call via the `type: 'end'` field below, calling
 * the plugin's `endCall` rather than `showCallkitIncoming` — Apple still
 * requires every VoIP push report SOMETHING to CallKit, and reporting the
 * already-shown call ended satisfies that exactly as well as ringing a new
 * one would.
 *
 * Android (no VoipPushToken row ever exists for it) and an iOS device that
 * hasn't registered a VoIP token yet both fall through to the existing FCM
 * path unchanged.
 */
async function handleCallStopRinging(
  event: Extract<CallEvent, { type: 'call.ended' | 'call.rejected' }>,
): Promise<void> {
  if (apnsVoipConfigured) {
    const voipRow = await prisma.voipPushToken.findUnique({ where: { deviceId: event.targetDeviceId } });
    if (voipRow) {
      const token = decryptVoipToken(voipRow.tokenCiphertext);
      try {
        await sendApnsVoip(token, { id: event.callId, type: 'end' });
      } catch (err) {
        if ((err as { apnsGone?: boolean }).apnsGone) {
          await prisma.voipPushToken.deleteMany({ where: { deviceId: event.targetDeviceId } });
        } else {
          console.error('[worker] APNs VoIP end-call push failed', err);
        }
      }
      return;
    }
  }

  await dispatchTo(event.targetDeviceId, {
    fcmData: { type: 'call-end', callId: event.callId },
  });
}

let vapidConfigured = false;
let fcmConfigured = false;
let apnsVoipConfigured = false;

function configureVapid(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  // The mailto: contact is required by the Web Push protocol (part of the VAPID JWT
  // claim so a push service can reach the sender about abuse) — not a real inbox
  // this app monitors, just the standard placeholder pattern until one is chosen.
  webpush.setVapidDetails('mailto:admin@comm.invalid', publicKey, privateKey);
  return true;
}

/** `FCM_SERVICE_ACCOUNT_JSON` is the *entire* service-account credential file's
 * contents as one env var (Firebase console → Project settings → Service accounts
 * → Generate new private key), not a file path — same "everything through env vars,
 * nothing read from a mounted file" convention `PUSH_SUBSCRIPTION_ENC_KEY`/VAPID
 * keys above already use, and it means this deploys the same way on any host
 * without also having to manage a secret file's filesystem permissions. */
function configureFcm(): boolean {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return false;
  try {
    const serviceAccount = JSON.parse(raw) as Record<string, unknown>;
    if (getApps().length === 0) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    return true;
  } catch (err) {
    console.error('[worker] FCM_SERVICE_ACCOUNT_JSON is set but not valid JSON — FCM push disabled', err);
    return false;
  }
}

export function startPushDispatcher(): void {
  vapidConfigured = configureVapid();
  fcmConfigured = configureFcm();
  apnsVoipConfigured = configureApnsVoip();
  if (!vapidConfigured) {
    console.log('[worker] VAPID keys not configured — web push dispatch disabled (see .env.example)');
  }
  if (!fcmConfigured) {
    console.log('[worker] FCM_SERVICE_ACCOUNT_JSON not configured — FCM push dispatch disabled (see .env.example)');
  }
  if (!apnsVoipConfigured) {
    console.log('[worker] APNS_VOIP_PEM not configured — iOS closed-app call ringing disabled (see .env.example)');
  }
  if (!vapidConfigured && !fcmConfigured && !apnsVoipConfigured) return; // nothing to subscribe for

  // One connection, all channels — ioredis multiplexes fine over a single
  // subscriber, and the `channel` check in the shared 'message' handler below
  // already routes each event to the right side, so there's no need for more than
  // one. Calls push via FCM or APNs VoIP (see handleCallRing's docstring), so the
  // call channel is only subscribed when at least one of those is actually
  // configured — subscribing to it with only VAPID set would just mean every event
  // routes to a no-op. No DEVICE_EVENTS_CHANNEL subscription — its only event
  // ('revoked') has no push of its own, the socket close itself is instant.
  const subscriber = createRedisSubscriber();
  const channels = fcmConfigured || apnsVoipConfigured ? [MESSAGE_EVENTS_CHANNEL, CALL_EVENTS_CHANNEL] : [MESSAGE_EVENTS_CHANNEL];
  subscriber.subscribe(...channels).catch((err) => {
    console.error('[worker] failed to subscribe for push dispatch', err);
  });
  subscriber.on('message', (channel, raw) => {
    if (channel === MESSAGE_EVENTS_CHANNEL) {
      void (async () => {
        let event: MessageEvent;
        try {
          event = JSON.parse(raw) as MessageEvent;
        } catch {
          return;
        }
        if (event.type !== 'new') return; // only new-message arrival triggers a push, not delivered/read/typing/deleted
        try {
          await handleNewMessage(event);
        } catch (err) {
          console.error('[worker] push dispatch error', err);
        }
      })();
    } else if (channel === CALL_EVENTS_CHANNEL) {
      void (async () => {
        let event: CallEvent;
        try {
          event = JSON.parse(raw) as CallEvent;
        } catch {
          return;
        }
        try {
          if (event.type === 'call.ring') {
            await handleCallRing(event);
          } else if (event.type === 'call.ended' || event.type === 'call.rejected') {
            // Dismisses CallKit's incoming-call UI on a device that a `call.ring`
            // push may have just woken from fully-closed — see
            // handleCallStopRinging's own docstring for why this needs its own
            // push rather than relying on the live WS event alone.
            await handleCallStopRinging(event);
          }
        } catch (err) {
          console.error('[worker] call push dispatch error', err);
        }
      })();
    }
  });

  console.log('[worker] push dispatcher subscribed to message/call events');
}
