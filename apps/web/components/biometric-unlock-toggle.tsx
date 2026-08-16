'use client';

import { useEffect, useState } from 'react';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import {
  isPlatformAuthenticatorAvailable,
  isBiometricUnlockEnabled,
  enableBiometricUnlock,
  disableBiometricUnlock,
} from '@/lib/crypto/biometric-unlock';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { IconFingerprint } from './icons';

/**
 * The enrollment half of biometric unlock — unlock-gate.tsx is the *use* half. Lives
 * on the Devices page specifically because this is a per-device setting: the
 * WebAuthn credential and wrapped KEK this creates only ever exist in this one
 * browser's local storage (see lib/crypto/biometric-unlock.ts), the same "identity
 * lives per-device" model every other piece of local key material in this app
 * already follows — there's no server-side toggle to show here, nothing to sync to
 * the devices list rows for other devices.
 *
 * Renders nothing at all (not a disabled control — an absent one) until the
 * capability check confirms this device can actually do this — a toggle for a
 * feature that would just fail if tapped is worse than no toggle.
 */
export function BiometricUnlockToggle({ userId, username }: { userId: string; username: string }): React.JSX.Element | null {
  const [supported, setSupported] = useState(false);
  const [checked, setChecked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      try {
        const [available, alreadyEnabled] = await Promise.all([isPlatformAuthenticatorAvailable(), isBiometricUnlockEnabled()]);
        setSupported(available);
        setEnabled(alreadyEnabled);
      } catch (err) {
        // Same fail-closed rule as every function in biometric-unlock.ts itself —
        // an unexpected throw here (e.g. IndexedDB acting up) should just leave the
        // card hidden (`supported` stays false), not leave `checked` stuck at false
        // forever with no console signal at all.
        console.error('[biometric-unlock] capability check failed', err);
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  async function handleToggle() {
    setError(undefined);
    setBusy(true);
    try {
      if (enabled) {
        await disableBiometricUnlock();
        setEnabled(false);
        return;
      }
      const kek = getCurrentKek();
      if (!kek) {
        // Can't happen from a normal page load (this page requires an unlocked
        // device to render at all — unlock-gate.tsx), but this component makes no
        // assumption about its caller beyond "a valid userId/username," so it
        // checks rather than assumes.
        setError('Unlock this device with your password first, then try again.');
        return;
      }
      const ok = await enableBiometricUnlock(kek, userId, username);
      if (!ok) {
        setError('This browser or device doesn’t support biometric unlock.');
        return;
      }
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }

  if (!checked || !supported) return null;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <IconFingerprint className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">Biometric unlock</p>
            <p className="text-xs text-muted-foreground">
              Use Face ID, Touch ID, or your screen lock instead of your password to unlock Comm on this device.
              Your account password is never replaced — it&rsquo;s still needed to sign in on a new device or if
              this stops working.
            </p>
          </div>
        </div>
        <Button type="button" variant={enabled ? 'secondary' : 'primary'} onClick={() => void handleToggle()} disabled={busy}>
          {busy ? '…' : enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Card>
  );
}
