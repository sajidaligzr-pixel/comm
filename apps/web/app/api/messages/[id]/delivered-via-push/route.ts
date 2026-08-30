import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { RedeemPushDeliveryTokenRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { redeemPushDeliveryToken, acknowledgeDelivered, getMessageSenderDeviceId } from '@/server/modules/messages/service';
import { publishDelivered } from '@/server/realtime/bus';

/**
 * See `MessagePushDeliveryToken`'s own schema doc comment
 * (packages/database/prisma/schema.prisma) for the full why this route exists at
 * all: apps/mobile's iOS Notification Service Extension — a separate, sandboxed
 * process Apple wakes briefly for every `mutable-content: 1` push, even while the
 * main app is fully force-quit — has no access to the main app's session cookie,
 * so it can't use the normal `/delivered` route (requireAuth/requireCsrf) the way
 * every other client does. Deliberately no `requireAuth`/`requireCsrf` here at
 * all: `token` (apps/worker's `createPushDeliveryToken`, embedded in the push
 * payload) is the sole authorization, mirroring how an invite-redemption link's
 * token is the whole of ITS authorization too.
 *
 * Silently no-ops (still 200s) on a missing/malformed body or an invalid/expired/
 * already-redeemed token — this route has no UI to show an error on either side,
 * and the extension's own `serviceExtensionTimeWillExpire` fallback already
 * treats "the ack didn't happen in time" as fine, not fatal (this feature's
 * entire fallback, absent the extension entirely, is "delivered updates once the
 * app is actually opened" — see thread_screen.dart's `_ingestIncoming`).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.pushDeliveredViaPush, req);
    const { id: messageId } = await params;
    const body = await parseBody(req, RedeemPushDeliveryTokenRequest);

    const deviceId = await redeemPushDeliveryToken(messageId, body.token);
    if (deviceId) {
      await acknowledgeDelivered(deviceId, messageId);
      const senderDeviceId = await getMessageSenderDeviceId(messageId);
      if (senderDeviceId) {
        await publishDelivered(senderDeviceId, messageId, new Date().toISOString());
      }
    }

    return jsonOk({ ok: true });
  });
}
