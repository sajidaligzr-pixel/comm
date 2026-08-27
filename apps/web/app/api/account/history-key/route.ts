import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { CreateUserHistoryKeyRequest, AppError, type UserHistoryKeyResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { getUserHistoryKey, createUserHistoryKeyIfAbsent } from '@/server/modules/history/service';

// Multi-device message history sync (docs/07-auth-architecture.md) — self only,
// no :userId in the path (mirrors /api/users/me, not /api/keys/bundle/:userId/...):
// there is no legitimate reason any account would ever fetch another account's
// wrapped History Key.
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.historyKeyFetch, ctx.userId);
    const key = await getUserHistoryKey(ctx.userId);
    if (!key) throw new AppError('NOT_FOUND', 'No history key exists for this account yet.');
    return jsonOk(key);
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.historyKeyCreate, ctx.userId);
    const body = await parseBody(req, CreateUserHistoryKeyRequest);
    const result: UserHistoryKeyResponse = await createUserHistoryKeyIfAbsent(
      ctx.userId,
      Buffer.from(body.wrappedKey, 'base64'),
      Buffer.from(body.salt, 'base64'),
    );
    return jsonOk(result);
  });
}
