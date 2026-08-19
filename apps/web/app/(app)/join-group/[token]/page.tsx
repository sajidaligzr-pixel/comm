import { AppError } from '@comm/types';
import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { peekGroupInvite } from '@/server/modules/groups/service';
import { JoinGroupCard } from '@/components/group/join-group-card';

/** WhatsApp-style "join via link" landing page (docs/13-roadmap.md's Groups
 * "Remaining" note). Lives under `(app)`, not `(auth)`, unlike `/invite/:token` —
 * account-invite redemption IS how you get an account in the first place, but
 * joining a group needs one to already exist and be signed in; `(app)/layout.tsx`'s
 * existing `getAuthContextOrRedirect()` already bounces a signed-out visitor to
 * /login for every route in this group, so that's handled for free here too. */
export default async function JoinGroupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await getAuthContextOrRedirect();

  try {
    const info = await peekGroupInvite(token, ctx.userId);
    return (
      <div className="flex h-full items-center justify-center p-4">
        <JoinGroupCard token={token} info={info} />
      </div>
    );
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Something went wrong. Please try again.';
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Invite link invalid</h1>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
    );
  }
}
