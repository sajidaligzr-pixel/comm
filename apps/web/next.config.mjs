const isDev = process.env.NODE_ENV !== 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // server.ts runs Next in custom-server mode; this app is never statically exported.
  // Keeps Prisma's native-binary-loading code out of the server bundle/trace (it does
  // its own dynamic fs access to find the query engine binary, which the bundler
  // otherwise flags/over-traces) — the standard Prisma+Next.js pairing.
  serverExternalPackages: ['@prisma/client', '@comm/database'],
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
  async headers() {
    return [
      {
        // Baseline security headers (docs/11-deployment-architecture.md). These are
        // mirrored — not replaced — by the reverse proxy in production; see that doc
        // for why both layers set them. Content-Security-Policy is deliberately NOT
        // set here — it has to be per-request (a nonce for Next's own hydration
        // scripts), which a static headers() config can't produce; see middleware.ts.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // microphone=(self) — not (*) — allows getUserMedia only for this
          // same-origin app itself (components/chat/message-thread.tsx's voice
          // message recorder), never a third-party iframe embedding this page.
          // camera stays fully denied: no feature here uses it. geolocation=(self) —
          // not (*) — is the live-location-sharing feature's browser-Geolocation-API
          // permission (docs/09-trust-boundaries.md's live-location exception),
          // scoped the same way microphone is: this same-origin app only, never a
          // third-party iframe embedding this page.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(self)' },
          // Only meaningful — and only sent — in production: the dev server is plain
          // http://localhost, and HSTS on an insecure origin is a browser no-op at
          // best and a footgun at worst (it would apply to the real domain the
          // moment that origin is ever served over http:// even once during setup).
          // preload is deliberately left off: it requires submission to browsers'
          // hardcoded preload list, a one-way decision this project shouldn't make
          // on an operator's behalf from inside application code.
          ...(isDev
            ? []
            : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
      {
        // Found live: the release APK was served with Next's own default
        // long-ish max-age for public/ static files, which meant Cloudflare's
        // edge could keep serving an OLD binary under the same URL for hours
        // after a new one was uploaded to origin — a user who updated right
        // after a fresh release still got a stale build reinstalled, and the
        // in-app updater (rightly) kept nagging since it was still the old
        // buildNumber. no-store means no intermediate cache (Cloudflare
        // included, on its default behavior of respecting origin
        // Cache-Control) keeps a copy at all. Paired with switching the APK's
        // own filename to be release-specific (docs/13-roadmap.md's release
        // process) rather than a fixed, always-overwritten name — belt and
        // suspenders, since a fixed name is still one Cloudflare could choose
        // to cache by path alone regardless of query string.
        source: '/downloads/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
