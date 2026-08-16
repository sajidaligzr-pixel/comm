import { Card } from '@/components/ui/card';
import { LoginForm } from '@/components/login-form';
import { Logo } from '@/components/logo';

export default function LoginPage(): React.JSX.Element {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center text-foreground">
          <Logo />
        </div>
        <Card>
          <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Comm is invite-only. If you don&apos;t have an account, ask an admin to send you an invite link.
          </p>
          <div className="mt-6">
            <LoginForm />
          </div>
        </Card>
      </div>
    </main>
  );
}
