import { Card } from '@/components/ui/card';
import { LinkDeviceCompleteForm } from '@/components/link-device-complete-form';

export default async function LinkDevicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-foreground">Link this device</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This link was generated on your other, already-signed-in device. Completing this adds the current
          device to your account.
        </p>
        <div className="mt-6">
          <LinkDeviceCompleteForm token={token} />
        </div>
      </Card>
    </main>
  );
}
