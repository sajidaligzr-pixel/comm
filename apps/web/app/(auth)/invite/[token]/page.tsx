import { Card } from '@/components/ui/card';
import { InviteRedeemForm } from '@/components/invite-redeem-form';
import { getInviteInfo } from '@/server/modules/auth/service';
import { AppError } from '@comm/types';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: Awaited<ReturnType<typeof getInviteInfo>> | undefined;
  let error: string | undefined;

  try {
    invite = await getInviteInfo(token);
  } catch (err) {
    error = err instanceof AppError ? err.message : 'Something went wrong. Please try again.';
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {invite ? (
          <>
            <h1 className="text-xl font-semibold text-foreground">Welcome, {invite.displayName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              You&apos;re setting up <span className="font-medium text-foreground">@{invite.username}</span> on
              Comm. Choose a password to finish creating your account.
            </p>
            <div className="mt-6">
              <InviteRedeemForm token={token} username={invite.username} />
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-foreground">Invite link invalid</h1>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </>
        )}
      </Card>
    </main>
  );
}
