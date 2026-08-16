import { Card } from '@/components/ui/card';

export default function AboutEncryptionPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <h1 className="text-xl font-semibold text-foreground">How your messages are protected</h1>

        <Card className="space-y-3 p-4 text-sm text-foreground">
          <p>Your message is encrypted on your device, before it ever leaves it.</p>
          <p>Only the person you&apos;re messaging — specifically, the device they&apos;re using — can decrypt it.</p>
          <p>Our servers store and deliver the encrypted data. We cannot read the contents of your private messages.</p>
          <p>
            Each message uses its own one-time key, derived through an established handshake
            (X3DH) and an evolving ratchet (the Double Ratchet algorithm) — the same design Signal
            popularized. Keys advance with every message, so even if one were somehow exposed, it
            would not expose your past or future messages.
          </p>
        </Card>

        <Card className="space-y-3 p-4 text-sm">
          <h2 className="font-medium text-foreground">What this doesn&apos;t protect against</h2>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Someone taking a screenshot or photo of a message on your or the recipient&apos;s screen.</li>
            <li>A device that is already unlocked and in someone else&apos;s hands.</li>
            <li>Malware or a compromised browser extension running on your device while you&apos;re signed in.</li>
            <li>The recipient choosing to share what you sent them, in or out of the app.</li>
          </ul>
          <p className="text-muted-foreground">
            We do not claim this system is unhackable — no software honestly can. What we commit to is
            building it on established, reviewed cryptographic methods, and being direct about the limits.
          </p>
        </Card>

        <Card className="space-y-2 p-4 text-sm">
          <h2 className="font-medium text-foreground">What we can still see</h2>
          <p className="text-muted-foreground">
            To deliver messages at all, our servers see who is messaging whom and roughly when — not
            what was said. Your device list and account details are visible to you and, for account
            administration only, to your admin. See Settings for the full privacy controls.
          </p>
        </Card>
      </div>
    </div>
  );
}
