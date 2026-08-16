import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { CreateDirectConversationRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createOrGetDirectConversation } from '@/server/modules/conversations/service';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    // Reuses the username-lookup rate-limit class — creating a direct conversation
    // is itself a way to probe "does this username exist" (docs/03-api-design.md's
    // Discovery route class), so it gets the same strict treatment.
    await enforceRateLimit(RATE_LIMIT_RULES.usernameLookup, ctx.userId);
    const body = await parseBody(req, CreateDirectConversationRequest);
    const conversation = await createOrGetDirectConversation(ctx.userId, body.withUsername.toLowerCase());
    return jsonOk(conversation);
  });
}
