import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { peekGroupInvite } from '@/server/modules/groups/service';

/** What this invite-link token resolves to, before committing to actually join —
 * see peekGroupInvite's own docstring. Requires auth (an existing account) but not
 * group membership. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { token } = await params;
    const info = await peekGroupInvite(token, ctx.userId);
    return jsonOk(info);
  });
}
