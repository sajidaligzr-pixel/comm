import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { InstallPrompt } from '@/components/install-prompt';

export const metadata: Metadata = {
  title: 'Comm',
  description: 'A closed, privacy-first, end-to-end encrypted messaging platform.',
  // iOS Safari ignores app/manifest.ts entirely for "Add to Home Screen" — these
  // meta tags (Next.js's `appleWebApp` emits them under the hood) are the only way
  // it gets a standalone (no browser chrome) window + a proper home-screen icon.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Comm',
  },
  icons: {
    apple: '/icon-192.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Static, matching the light-by-default page background above — was previously
  // OS-preference-driven, which disagreed with the page itself no longer following
  // OS dark mode.
  themeColor: '#fafafa',
};

// Applies the dark class before paint (no FOUC) from a stored preference only — never
// the OS/browser setting. There's no in-app light/dark toggle yet (nothing ever
// writes 'comm-theme'), so following the OS preference meant anyone with system dark
// mode on got a dark app with no way to switch it off. Defaults to light until a real
// toggle exists. Theme choice is not sensitive data, so localStorage is fine here
// (contrast with docs/32-local-data-storage.md's rule against secrets/keys in
// localStorage, which this isn't).
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('comm-theme');
    document.documentElement.classList.toggle('dark', stored === 'dark');
  } catch (_) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // middleware.ts mints this per request and forwards it on the request headers
  // (not just the CSP response header) specifically so this Server Component can
  // read it back and stamp it onto the one inline script this app authors itself —
  // Next's own hydration scripts get the nonce automatically, this one doesn't,
  // since nothing about it is Next-generated. See middleware.ts's docstring.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <InstallPrompt />
      </body>
    </html>
  );
}
