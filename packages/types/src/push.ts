import { z } from 'zod';

/**
 * The Web Push API's own `PushSubscriptionJSON` shape (docs/13-roadmap.md's push
 * notification pass) — validated here rather than trusted as `unknown` from the
 * client, same as every other inbound body in this app. `provider` is optional and
 * defaults to `'web_push'` when absent so the existing web client (notification-
 * prompt.tsx), which has never sent this field, keeps working unchanged.
 */
export const WebPushSubscriptionRequest = z.object({
  provider: z.literal('web_push').optional(),
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});
export type WebPushSubscriptionRequest = z.infer<typeof WebPushSubscriptionRequest>;

// Backward-compat name — this is what every existing call site (web client,
// apps/web's own route/service) already imports; kept as an alias rather than
// renamed everywhere just to introduce a second provider.
export const PushSubscriptionRequest = WebPushSubscriptionRequest;
export type PushSubscriptionRequest = WebPushSubscriptionRequest;

/**
 * FCM's registration token (apps/mobile's push path — the schema's `PushProvider`
 * enum already had an `fcm` value reserved for this, unused until now). `provider`
 * is required and literal here, unlike the web_push branch above, since there's no
 * legacy client sending an FCM token without it to stay compatible with.
 */
export const FcmPushSubscriptionRequest = z.object({
  provider: z.literal('fcm'),
  token: z.string().min(1).max(4096),
});
export type FcmPushSubscriptionRequest = z.infer<typeof FcmPushSubscriptionRequest>;

/** What `POST /api/push/subscribe` actually accepts — either shape, distinguished
 * by trying each (a plain union, not a discriminated one, specifically so the
 * `provider`-less legacy web_push body above still parses). */
export const AnyPushSubscriptionRequest = z.union([FcmPushSubscriptionRequest, WebPushSubscriptionRequest]);
export type AnyPushSubscriptionRequest = z.infer<typeof AnyPushSubscriptionRequest>;
