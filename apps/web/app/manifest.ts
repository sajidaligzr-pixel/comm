import type { MetadataRoute } from 'next';

/**
 * Next.js's `app/manifest.ts` convention — auto-served at `/manifest.webmanifest`
 * with the `<link rel="manifest">` tag injected automatically, no manual wiring in
 * layout.tsx needed. This plus a registered service worker (public/sw.js,
 * registered in components/install-prompt.tsx) is what makes the browser consider
 * the app installable at all — see docs/13-roadmap.md's Phase 8 for the fuller PWA
 * scope (offline shell, Workbox caching strategy) this intentionally doesn't
 * attempt yet; this covers installability + the home-screen icon/splash only.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Comm',
    short_name: 'Comm',
    description: 'A closed, privacy-first, end-to-end encrypted messaging platform.',
    start_url: '/chats',
    display: 'standalone',
    background_color: '#fafafa',
    theme_color: '#25D366',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
