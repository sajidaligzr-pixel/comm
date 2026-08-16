import { Card } from '@/components/ui/card';
import { ChangePasswordForm } from '@/components/change-password-form';
import { Logo } from '@/components/logo';
import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { getMustChangePassword } from '@/server/modules/auth/service';

// Reachable both as a forced first step (redirected here by (app)/layout.tsx when
// mustChangePassword is set — docs/07-auth-architecture.md) and voluntarily later
// from Settings. Deliberately lives outside the (app) route group so that redirect
// can't loop back onto this page.
export default async function ChangePasswordPage() {
  const ctx = await getAuthContextOrRedirect();
  const forced = await getMustChangePassword(ctx.userId);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center text-foreground">
          <Logo />
        </div>
        <Card>
          <h1 className="text-xl font-semibold text-foreground">
            {forced ? 'Choose a new password' : 'Change your password'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {forced
              ? 'Your account was set up with a temporary password. Choose one only you know before continuing.'
              : 'Your current password stays valid on other signed-in devices until you finish this.'}
          </p>
          <div className="mt-6">
            <ChangePasswordForm forced={forced} />
          </div>
        </Card>
      </div>
    </main>
  );
}
