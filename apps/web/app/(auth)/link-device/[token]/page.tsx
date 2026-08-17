import { Card } from '@/components/ui/card';
import { LinkDeviceCompleteForm } from '@/components/link-device-complete-form';
import { getDeviceLinkInfo } from '@/server/modules/devices/service';
import { AppError } from '@comm/types';

export default async function LinkDevicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let info: Awaited<ReturnType<typeof getDeviceLinkInfo>> | undefined;
  let error: string | undefined;

  try {
    info = await getDeviceLinkInfo(token);
  } catch (err) {
    error = err instanceof AppError ? err.message : 'Something went wrong. Please try again.';
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {info ? (
          <>
            <h1 className="text-xl font-semibold text-foreground">Link this device</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This link was generated on <span className="font-medium text-foreground">@{info.username}</span>
              &rsquo;s other, already-signed-in device. Completing this adds the current device to that account.
            </p>
            <div className="mt-6">
              <LinkDeviceCompleteForm token={token} username={info.username} />
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-foreground">Linking code invalid</h1>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </>
        )}
      </Card>
    </main>
  );
}
