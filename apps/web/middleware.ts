import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Mints a fresh per-request Content-Security-Policy — not a static one from
 * next.config.mjs's `headers()`, which is where every *other* security header in
 * this app still lives (see that file). CSP specifically has to be built here,
 * per-request, because of how the App Router hydrates a page: Next injects a series
 * of inline `<script>` tags per response (streamed RSC payload chunks —
 * `self.__next_f.push(...)`), and their *content* is the actual page data, different
 * on every single request. There is no fixed hash that could ever allow them, so a
 * static hash-based CSP (the first version of this pass) looked correct against the
 * one script this app's own code renders, but broke the app outright the instant it
 * was loaded in a real browser — Next's own hydration scripts got blocked too,
 * throwing "Expected a request ID to be defined... self.__next_r" and leaving the
 * page fully unhydrated. Caught only by live-testing in a browser; typecheck/lint/
 * build are blind to this whole class of bug.
 *
 * The fix is Next's own documented pattern: mint a random nonce per request, put it
 * in the CSP response header, and Next automatically stamps that same nonce onto
 * every script tag *it* generates once it sees it there — no per-component wiring
 * needed for those. `'strict-dynamic'` extends that trust to scripts a nonced script
 * loads in turn (exactly the streamed-chunk scripts above), which is what actually
 * makes this work; `'self'` stays listed alongside purely for browsers old enough not
 * to understand strict-dynamic, which then ignore it entirely per spec (not a weaker
 * fallback on any evergreen browser). See
 * https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy.
 *
 * The one inline script this app authors itself — app/layout.tsx's dark-mode-
 * before-paint snippet — isn't Next-generated, so it isn't covered by the
 * auto-stamping above; it still needs the nonce passed to it explicitly. That's why
 * this also forwards the nonce on the *request* headers (`x-nonce`, read via
 * `next/headers`'s `headers()`), not just the response — see that file.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildContentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function buildContentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const connectSrc = ["'self'", ...turnConnectSources()];
  const objectStorageOrigin = objectStorageConnectSource();
  if (objectStorageOrigin) connectSrc.push(objectStorageOrigin);

  const directives = [
    "default-src 'self'",
    // 'unsafe-eval' only in dev: Next's dev-mode HMR/Fast Refresh client needs it;
    // the production build does not, and does not get it. 'wasm-unsafe-eval' is a
    // separate, narrower CSP Level 3 keyword — it permits WebAssembly.compile()/
    // instantiate() specifically, without permitting JS eval() the way 'unsafe-eval'
    // does — and it's needed unconditionally, not just in dev: packages/crypto's
    // primary implementation (vodozemac) compiles a WASM module, and without this the
    // browser throws "violates ... because 'unsafe-eval' is not an allowed source"
    // the moment any crypto operation runs, in production specifically, since dev's
    // blanket 'unsafe-eval' was masking the gap. Caught live-testing an actual
    // deploy, not by typecheck/lint/build — same class of gap the file's own
    // docstring already flags for CSP in general.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    // The one documented, narrow exception in this whole policy: React's
    // `style={{...}}` prop (a handful of per-render values — avatar.tsx's per-user
    // color, bubbles.tsx's voice-note progress bar, group-message-thread.tsx's
    // sender-color label) renders a real inline `style="..."` HTML attribute, which
    // CSP's style-src governs and which — unlike inline <script>, covered by the
    // nonce above — has no practical per-value hash/nonce path. Inline CSS injection
    // is a materially weaker primitive than inline script execution (no code
    // execution), so this is the correct place to draw the line, not a shortcut —
    // script-src is where a strict policy actually matters, and it stays strict.
    "style-src 'self' 'unsafe-inline'",
    // Decrypted images/voice notes render as inline data: URLs
    // (components/chat/bubbles.tsx), never fetched — there's no other image/media
    // source anywhere in this app except the one added below.
    // tile.openstreetmap.org: the live-location map's raster tile source
    // (components/location/live-map-view.tsx) — the one genuinely external image
    // origin in this app, open-source/no-API-key by design (docs/09-trust-
    // boundaries.md's live-location exception).
    "img-src 'self' data: https://tile.openstreetmap.org",
    "media-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // This app is never meant to be iframed by anything, own origin included.
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * The object-storage origin a browser fetches attachment ciphertext from directly
 * (lib/media-client.ts's downloadAttachmentCiphertext) is same-origin under the
 * local-fs dev/default adapter (already covered by 'self') but a genuinely different
 * origin once OBJECT_STORAGE_ENDPOINT points at a real S3-compatible bucket
 * (packages/storage/src/s3-storage.ts) — connect-src has to name that origin
 * explicitly in that case, or every file download would start failing the moment S3
 * is configured. Derived from the same env var the storage adapter itself reads, so
 * there's exactly one place this ever needs to be set.
 */
function objectStorageConnectSource(): string | null {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * TURN/STUN connections a live call's RTCPeerConnection makes are subject to
 * connect-src in spec-compliant browsers (Firefox has enforced this for years;
 * Chrome checks the ICE server URL too) — without this, calls would silently stop
 * ICE-gathering through a real coturn instance the moment TURN_URLS is configured,
 * exactly the "works in dev, breaks the day it's actually turned on in production"
 * gap this pass exists to close. `turn:`/`turns:` URIs use RFC 7065's single-colon
 * form (`turn:host:port`), not `scheme://host` — CSP's host-source grammar doesn't
 * parse that, so this allows the bare scheme rather than fighting non-standard URI
 * parsing; TURN_URLS is an operator-set env var, never user input.
 */
function turnConnectSources(): string[] {
  const urls = process.env.TURN_URLS;
  if (!urls) return [];
  const schemes = new Set<string>();
  for (const raw of urls.split(',').map((u) => u.trim()).filter(Boolean)) {
    const scheme = raw.split(':')[0];
    if (scheme === 'turn' || scheme === 'turns') schemes.add(`${scheme}:`);
  }
  return [...schemes];
}

export const config = {
  matcher: [
    // Every request except already-fingerprinted static assets (safe to cache
    // without a per-request nonce) — mirrors Next's own documented matcher for this
    // exact pattern. The /realtime WebSocket upgrade never reaches this at all —
    // server.ts routes it directly off the raw http.Server's 'upgrade' event,
    // bypassing Next's request handler (and therefore middleware) entirely.
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-192.png|icon-512.png|icon-maskable-512.png|manifest.webmanifest|sw.js).*)',
  ],
};
