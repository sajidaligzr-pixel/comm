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
import webpush from 'web-push';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { prisma, PushProvider } from '@comm/database';
import { createRedisSubscriber, decryptAtRest } from '@comm/security';
import {
  MESSAGE_EVENTS_CHANNEL,
  CALL_EVENTS_CHANNEL,
  DEVICE_EVENTS_CHANNEL,
  type MessageEvent,
  type CallEvent,
  type DeviceEvent,
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
 * Data-only (no top-level `notification` key), deliberately — an FCM message that
 * includes one is auto-displayed by the OS while this app is backgrounded and never
 * reaches Dart at all, which is exactly wrong for the call case (needs code to run,
 * not just a tray icon) and only accidentally right for messages. Sending both
 * message and call pushes as data-only keeps one code path
 * (firebaseMessagingBackgroundHandler / the foreground listener,
 * push_notifications.dart) responsible for turning either into an actual system
 * notification via flutter_local_notifications, matching how the message
 * notification already looks whether it came live over WS or cold via push.
 */
async function sendFcm(token: string, data: Record<string, string>): Promise<void> {
  await getMessaging().send({
    token,
    data,
    android: { priority: 'high' },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { contentAvailable: true } } },
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

async function dispatchTo(deviceId: string, payload: { messagePayload?: unknown; fcmData?: Record<string, string> }): Promise<void> {
  const subRow = await prisma.pushSubscription.findUnique({ where: { deviceId } });
  if (!subRow) return; // most devices won't have push enabled at all — normal, not an error

  const subscription = decodeSubscription(subRow.subscriptionCiphertext);
  try {
    if (subRow.provider === PushProvider.fcm) {
      if (!fcmConfigured || !payload.fcmData) return;
      await sendFcm((subscription as FcmPushSubscriptionRequest).token, payload.fcmData);
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
  });
}

/** No web_push equivalent — browsers ringing from a fully-closed tab was never in
 * scope (docs/13-roadmap.md), only apps/mobile asked for this. `messagePayload` is
 * left unset in the `dispatchTo` call below on purpose: a `web_push`-provider
 * subscription simply gets nothing for a call event, same as it always has. */
async function handleCallRing(event: Extract<CallEvent, { type: 'call.ring' }>): Promise<void> {
  await dispatchTo(event.targetDeviceId, {
    fcmData: {
      type: 'call',
      conversationId: event.conversationId,
      callId: event.callId,
      fromDisplayName: event.fromDisplayName,
    },
  });
}

/** New-device login approval (docs/07-auth-architecture.md's device-approval
 * section) — the one push that has to reach an EXISTING device even if it's fully
 * backgrounded/closed, since that's the only way most people will ever notice a
 * sign-in attempt they didn't just make. Both providers get a real, visible
 * notification (unlike `handleCallRing`, this isn't something a foreground UI
 * would already be showing live) — tapping it deep-links to the Devices screen in
 * both clients, same as `notificationclick` in apps/web/public/sw.js. */
async function handleLoginPending(event: Extract<DeviceEvent, { type: 'login_pending' }>): Promise<void> {
  const body = `${event.name} wants to sign in — approve it in Devices if this was you.`;
  await dispatchTo(event.targetDeviceId, {
    messagePayload: { title: 'New sign-in request', body, type: 'login_pending' },
    fcmData: { type: 'login_pending', pendingLoginId: event.pendingLoginId, title: 'New sign-in request', body },
  });
}

let vapidConfigured = false;
let fcmConfigured = false;

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
  if (!vapidConfigured) {
    console.log('[worker] VAPID keys not configured — web push dispatch disabled (see .env.example)');
  }
  if (!fcmConfigured) {
    console.log('[worker] FCM_SERVICE_ACCOUNT_JSON not configured — FCM push dispatch disabled (see .env.example)');
  }
  if (!vapidConfigured && !fcmConfigured) return; // nothing to subscribe for

  // One connection, all channels — ioredis multiplexes fine over a single
  // subscriber, and the `channel` check in the shared 'message' handler below
  // already routes each event to the right side, so there's no need for more than
  // one. Calls only ever push via FCM (see handleCallRing's docstring), so the call
  // channel is only subscribed when FCM is actually configured — subscribing to it
  // with only VAPID set would just mean every event routes to a no-op.
  // DEVICE_EVENTS_CHANNEL (new-device login approval) is subscribed regardless —
  // handleLoginPending sends both a web_push and an FCM payload, unlike calls.
  const subscriber = createRedisSubscriber();
  const channels = fcmConfigured
    ? [MESSAGE_EVENTS_CHANNEL, CALL_EVENTS_CHANNEL, DEVICE_EVENTS_CHANNEL]
    : [MESSAGE_EVENTS_CHANNEL, DEVICE_EVENTS_CHANNEL];
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
        if (event.type !== 'call.ring') return; // only the initial invite needs to wake a closed app
        try {
          await handleCallRing(event);
        } catch (err) {
          console.error('[worker] call push dispatch error', err);
        }
      })();
    } else if (channel === DEVICE_EVENTS_CHANNEL) {
      void (async () => {
        let event: DeviceEvent;
        try {
          event = JSON.parse(raw) as DeviceEvent;
        } catch {
          return;
        }
        if (event.type !== 'login_pending') return; // 'revoked' has no push — the socket close itself is instant
        try {
          await handleLoginPending(event);
        } catch (err) {
          console.error('[worker] login-pending push dispatch error', err);
        }
      })();
    }
  });

  console.log('[worker] push dispatcher subscribed to message/call/device events');
}
