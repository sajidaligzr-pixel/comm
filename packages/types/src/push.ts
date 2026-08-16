import { z } from 'zod';

/**
 * The Web Push API's own `PushSubscriptionJSON` shape (docs/13-roadmap.md's push
 * notification pass) — validated here rather than trusted as `unknown` from the
 * client, same as every other inbound body in this app.
 */
export const PushSubscriptionRequest = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;
