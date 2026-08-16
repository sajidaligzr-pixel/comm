/**
 * Push notification dispatch (docs/13-roadmap.md's push notification pass, shipped
 * ahead of the rest of Phase 7) — subscribes to the same `MESSAGE_EVENTS_CHANNEL`
 * `apps/web`'s WS layer already publishes onto (docs/04-websocket-realtime.md), the
 * same shared-channel pattern `jobs/cleanup.ts` already established for `deleted`
 * events. Deliberately NOT a BullMQ consumer (see index.ts's note on why that
 * infrastructure isn't adopted yet) — Redis pub/sub is already the right shape for
 * "react to an event," no queue/retry semantics needed for a best-effort push.
 *
 * This is the one place `push_subscriptions.subscription_ciphertext` is ever
 * decrypted (docs/02-database-schema.md) — kept out of apps/web's hot request path
 * entirely, so a slow/failing push provider can never add latency to sending a
 * message.
 */
import webpush from 'web-push';
import { prisma } from '@comm/database';
import { createRedisSubscriber, decryptAtRest } from '@comm/security';
import { MESSAGE_EVENTS_CHANNEL, type MessageEvent, type PushSubscriptionRequest } from '@comm/types';

function pushEncKey(): string {
  const key = process.env.PUSH_SUBSCRIPTION_ENC_KEY;
  if (!key) throw new Error('PUSH_SUBSCRIPTION_ENC_KEY is not set. See .env.example.');
  return key;
}

function decodeSubscription(ciphertext: Buffer): PushSubscriptionRequest {
  const plaintext = decryptAtRest(pushEncKey(), ciphertext);
  return JSON.parse(plaintext.toString('utf8')) as PushSubscriptionRequest;
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

async function handleNewMessage(event: Extract<MessageEvent, { type: 'new' }>): Promise<void> {
  const subRow = await prisma.pushSubscription.findUnique({ where: { deviceId: event.targetDeviceId } });
  if (!subRow) return; // most devices won't have push enabled at all — normal, not an error

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

  const subscription = decodeSubscription(subRow.subscriptionCiphertext);
  const payload = JSON.stringify({
    title: 'Comm',
    body: bodyFor(event.message.contentTypeHint, sender?.displayName ?? 'someone'),
    conversationId: event.message.conversationId,
  });

  try {
    await webpush.sendNotification(subscription, payload);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      // Subscription expired/was revoked on the browser's end — clean it up rather
      // than retrying a dead endpoint on every future message.
      await prisma.pushSubscription.deleteMany({ where: { deviceId: event.targetDeviceId } });
    } else {
      console.error('[worker] push dispatch failed', err);
    }
  }
}

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

export function startPushDispatcher(): void {
  if (!configureVapid()) {
    console.log('[worker] VAPID keys not configured — push notification dispatch disabled (see .env.example)');
    return;
  }

  const subscriber = createRedisSubscriber();
  subscriber.subscribe(MESSAGE_EVENTS_CHANNEL).catch((err) => {
    console.error('[worker] failed to subscribe for push dispatch', err);
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== MESSAGE_EVENTS_CHANNEL) return;
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
  });

  console.log('[worker] push dispatcher subscribed to message events');
}
