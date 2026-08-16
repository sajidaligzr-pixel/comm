# 11 — Deployment Architecture (No Docker)

## Constraint

Confirmed explicitly: no containers, anywhere. Everything runs as plain Node.js processes. This document designs around that rather than treating it as a gap to fill in later.

## Local development

Default: **managed free-tier cloud services** for stateful dependencies, so a new machine needs nothing installed beyond Node.js/npm — Postgres via a free-tier managed instance (e.g. Neon), Redis via a free-tier managed instance (e.g. Upstash), connection strings in `.env`.

**What this machine actually runs (the documented offline alternative, since Postgres/Redis were already installed via Homebrew here)**: natively installed Postgres 14 and Redis, both bound to `localhost` only. A dedicated least-privilege role/database was created rather than reusing the machine's other project databases — `comm_app` / `comm_dev` — matching the "separate application/database users, least privilege" rule from [08-threat-model](08-threat-model.md) even in local dev, so dev habits match production ones. Either path, the app processes themselves are always just:

```
npm install
npm run dev   # turborepo runs apps/web and apps/worker concurrently
```

No `docker compose up` step exists in this project.

## Production topology

```
Internet
   │
   ▼
DNS → (optional) Cloudflare in front, proxy mode — CDN + WAF + DDoS
   absorption at the network edge. This is a proxy in front of a plain
   origin server, not a container/runtime choice, so it doesn't
   conflict with "no Docker."
   │
   ▼
Caddy (or Nginx) on the app VM
   - TLS termination (Caddy: automatic Let's Encrypt certs, simplest
     no-Docker option; Nginx + certbot as the documented alternative)
   - HTTP/2, WebSocket upgrade proxying (wss:// → apps/web's ws server)
   - Security headers applied here (see below) as a second layer even
     though apps/web also sets them, so misconfiguration in one layer
     doesn't remove them entirely
   │
   ├──► apps/web  (Next.js custom server — `tsx server.ts` — serves UI +
   │               API Route Handlers + the WebSocket realtime channel
   │               from one process, managed by PM2/systemd, port 3000.
   │               `npm run build` still runs `next build` to produce the
   │               real optimized Next.js production bundle that
   │               server.ts loads at startup; server.ts itself runs via
   │               tsx — a transpile-only runner — rather than a
   │               separately `tsc`-compiled dist/server.js, because
   │               Next's own subpath packages (next/server,
   │               next/headers, next/navigation) are designed to be
   │               resolved by Next's own bundler and aren't reliably
   │               resolvable by a plain standalone `tsc` compile
   │               outside it. This doesn't weaken type safety: `npm run
   │               typecheck` (tsc, Next-compatible module resolution)
   │               remains the real type-checking gate in CI
   │               (docs/11-deployment-architecture.md's CI/CD section);
   │               tsx only turns already-checked TS into runnable JS.)
   └──► apps/worker (periodic cleanup job — expired invites/sessions,
                   disappearing-message expiry — plus an event-driven
                   push-notification dispatcher (docs/13-roadmap.md's
                   push notification pass) subscribed to the same Redis
                   MESSAGE_EVENTS_CHANNEL apps/web publishes onto —
                   managed by PM2/systemd, no exposed port. Still not a
                   BullMQ consumer: cleanup is timer-driven and push
                   dispatch is pub/sub-driven, neither needs a real job
                   queue's retry/backoff semantics; BullMQ is adopted
                   starting Phase 4 when media processing actually
                   produces jobs that do (docs/13-roadmap.md). `npm
                   start` runs via `tsx
                   src/index.ts`, the same reasoning as apps/web above —
                   `packages/database`/`packages/security`/`packages/types`
                   all point their own `package.json` `main` at raw `.ts`
                   source for Turbopack to consume directly, which a
                   separately `tsc`-compiled `dist/index.js` run under
                   plain `node` cannot resolve (Node's ESM loader, unlike
                   a bundler, requires real extensions on every relative
                   import in that whole dependency graph). `npm run build`
                   still exists and still typechecks + emits `.d.ts`, it's
                   just not what `start` runs.)

Separate, dedicated host/VM (needs a public IP + a wide UDP port range,
which doesn't coexist cleanly with the reverse-proxied app VM's ports):
   coturn (self-hosted TURN/STUN) — deploying the coturn instance
   itself is still a real, undone ops step (this is infrastructure,
   not application code); what IS shipped is the app-side half:
   `POST /api/calls/turn-credentials` (apps/web) mints the
   short-lived `use-auth-secret` HMAC credential the moment
   `TURN_SHARED_SECRET`/`TURN_URLS` (.env.example) are set, so
   turning on TURN in production is "deploy coturn with this shared
   secret, set the two env vars" — no app code changes needed. Until
   then the route returns an empty ICE server list, which is enough
   for calls between peers on the same network (docs/13-roadmap.md's
   Phase 6 slice) but not real-world NAT traversal.
   - systemd unit, `turnserver` binary from the OS package or built
     from source, not a container
   - `use-auth-secret` shared secret held only in the API server's
     environment + coturn's config, never shipped to any client
   - credential rotation: the shared secret itself is rotated on a
     schedule (e.g. quarterly) via a documented runbook script in
     infrastructure/scripts/, distinct from the per-call short-lived
     credentials it derives (see 08-threat-model.md#call-security)

Managed, not self-run:
   - PostgreSQL (managed provider — RDS/Neon/等, whichever the
     operator picks; requirement is: private networking, encrypted
     connections, encrypted backups, not publicly reachable)
   - Redis (managed provider — ElastiCache/Upstash/etc.; same
     requirements, plus AUTH/ACLs enabled, never exposed publicly)
   - Object storage (S3-compatible managed bucket; private, no public
     listing, signed URLs only) — the app-side integration is shipped
     (`packages/storage`, docs/13-roadmap.md's file-attachment pass):
     `@aws-sdk/client-s3` + presigned POST (upload, with a
     `content-length-range` condition enforcing the size cap
     server-side) / presigned GET (download). Turning it on in
     production is "provision a bucket, set
     `OBJECT_STORAGE_ENDPOINT`/`OBJECT_STORAGE_BUCKET`/`OBJECT_STORAGE_ACCESS_KEY_ID`/`OBJECT_STORAGE_SECRET_ACCESS_KEY`"
     — no app code changes needed, same "configured -> real,
     unconfigured -> dev-safe default" pattern as coturn/TURN above.
     Until those are set, `packages/storage` falls back to a
     zero-setup **local-filesystem adapter** (files under the repo's
     gitignored `.data/media-objects/`, "signed URLs" implemented as
     short-lived HMAC tokens reusing the exact mechanism
     `/api/calls/turn-credentials` already uses) — this is the one
     genuine deviation from "managed, not self-run" in this list, and
     it's deliberately dev-only, never selected when the app is
     actually configured for production.
```

Process management: **PM2** is the default recommendation (simple `ecosystem.config.js`, built-in restart-on-crash, log rotation, `pm2 startup` for boot persistence) with **systemd unit files** as the documented alternative/what `infrastructure/systemd/` ships for operators who prefer not to add PM2 as a dependency. Either way: each app process runs under a **least-privilege OS user** (not root), restarts automatically on crash, and its stdout/stderr is captured to the rotated operational logs referenced in [10-privacy-data-retention](10-privacy-data-retention.md) — never to a file readable by other services.

**Memory ceiling as a safety net, on top of — not instead of — actually auditing for leaks.** Both long-running processes (`apps/web`, `apps/worker`) should be started with a hard memory limit that triggers a clean, automatic restart if it's ever exceeded: PM2's `--max-memory-restart` flag (e.g. `500M`), or systemd's `MemoryMax=`/`MemoryHigh=` directive on the unit file. This is standard hygiene for any long-lived Node service, not a sign of an unresolved problem — a live-code audit (this project's own client-side lock/memoization maps were checked specifically for this: unbounded `Map`/`Set` caches are the concrete, common way a long-running process or long-lived browser tab slowly leaks) catches what's identifiable by reading the code; a memory ceiling catches whatever isn't, from a dependency's own bug to a pattern nobody's hit yet, before it becomes an OOM kill of the whole VM instead of one clean, logged process restart.

## TLS / transport security

HTTPS and WSS only, everywhere, in production — no HTTP login, no plaintext WebSocket, ever (master-prompt §69). HSTS enabled with a long max-age once TLS is confirmed stable. Local dev may run plain HTTP on `localhost` only (never on a network-reachable interface).

## Security headers

Set at the Caddy/Nginx layer and mirrored in `apps/web` responses (via Next.js's `headers()` config plus explicit headers on Route Handler responses) as defense in depth, not redundancy for its own sake:

- `Content-Security-Policy` — **shipped** (`apps/web/middleware.ts`, not `next.config.mjs`'s static `headers()` — a real, live-testing-driven correction: a first attempt built it as a static config with a `sha256-` hash allowing the one inline script this app's own code renders, which looked right against that one script but broke the app outright the moment it was actually loaded — the App Router hydrates every page by injecting several inline `<script>` tags of its own, streamed RSC payload chunks whose content differs on every request, which no fixed hash can ever cover). The real, shipped version follows Next's own documented pattern: `middleware.ts` mints a random nonce per request, Next automatically stamps it onto every script tag *it* generates once the nonce is in the CSP response header, and `'strict-dynamic'` extends that trust to whatever those nonced scripts load in turn — `script-src` ends up `'self' 'nonce-<random>' 'strict-dynamic'`, no `'unsafe-eval'` outside dev (Next's HMR client needs it there only). The one inline script this app authors itself (`app/layout.tsx`'s dark-mode-before-paint snippet) isn't Next-generated, so it isn't covered by the auto-stamping — it reads the same nonce back via `next/headers`'s `headers()` (forwarded on the request headers by the middleware, not just the response) and applies it explicitly. `connect-src` is `'self'` plus the object-storage origin (only when `OBJECT_STORAGE_ENDPOINT` points off-origin at a real S3-compatible bucket — same-origin under the local-fs adapter) and the `turn:`/`turns:` schemes (only once `TURN_URLS` is actually configured) so a live coturn deployment and/or S3 switch-over doesn't silently break the moment either is turned on. `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`. The one remaining documented, narrow exception: `style-src` allows `'unsafe-inline'` because React's `style={{...}}` prop (a few per-user color/progress-bar values computed at render time) renders a real inline `style="..."` attribute with no practical hash/nonce path — `script-src` stays fully strict, which is where that line actually matters.
- `Strict-Transport-Security` — **shipped**, production only (`max-age=63072000; includeSubDomains`, no `preload` — submitting to browsers' hardcoded preload list is a one-way operator decision this project doesn't make on their behalf from inside application code); a no-op on the plain-HTTP local dev server by design.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin` (or stricter)
- `Permissions-Policy` — locked down to only the APIs actually used (camera/microphone for calls, on the call screen route only where feasible)
- `frame-ancestors 'none'` (clickjacking protection) — this app is never meant to be iframed
- Cookies: `Secure; HttpOnly; SameSite=Strict` for auth cookies, per [07-auth-architecture](07-auth-architecture.md)

## Secrets management

`.env.example` documents every required variable with placeholder/no real values, committed. Real secrets: environment variables injected by the process manager from a secrets store appropriate to the hosting provider (e.g. a VM-level secrets file readable only by the app's OS user, or the provider's secrets manager if one exists) — never committed, never logged. Rotated on suspected exposure; JWT signing secret, coturn shared secret, DB/Redis credentials, object storage keys, VAPID keys, and `PUSH_SUBSCRIPTION_ENC_KEY` (the server-held key `push_subscriptions.subscription_ciphertext` is encrypted with, docs/02-database-schema.md) are all treated as security-sensitive and listed explicitly in `.env.example` with a one-line note on rotation impact for each. Rotating `PUSH_SUBSCRIPTION_ENC_KEY` specifically invalidates every stored subscription at once (they become undecryptable) — acceptable, since the worst case is just "everyone silently stops getting push notifications until they next open the app and get a fresh `beforeinstallprompt`-style opportunity to re-subscribe," not data loss.

**Push notifications need no separate infrastructure deployment**, unlike coturn — `apps/worker` just needs outbound HTTPS reachability to each browser vendor's push service (Google's FCM for Chrome, Mozilla's autopush for Firefox, etc.), which a normal outbound-allowed VM already has. Turning it on in production is exactly "set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`NEXT_PUBLIC_VAPID_PUBLIC_KEY`/`PUSH_SUBSCRIPTION_ENC_KEY`" — no port to open, no DNS record, no systemd unit.

## CI/CD (no Docker in the pipeline either)

Every PR: TypeScript check, lint, unit tests, integration tests (against ephemeral or managed test DB/Redis instances, not a Docker service container), build, `npm audit`/dependency scan, secret scan. Production deploy requires all of the above green, plus the security test suite ([12-testing-strategy](12-testing-strategy.md)) passing. Deploy mechanism (Phase 12): a script in `infrastructure/scripts/deploy.sh` that pulls, installs, builds, runs migrations, and restarts the PM2/systemd services — no image build/push step, consistent with the no-Docker constraint.

## Backups & disaster recovery

- **Postgres**: automated encrypted backups via the managed provider, tested restores on a schedule (a backup that's never been restored isn't a verified backup), versioned/retained per [10-privacy-data-retention](10-privacy-data-retention.md)'s spirit (not indefinite).
- **Redis**: treated as ephemeral/rebuildable state (sessions, presence, queues) — not backed up as a source of truth; a Redis loss degrades to "everyone reconnects and resyncs from Postgres," not data loss.
- **Object storage**: provider-level redundancy/versioning enabled; encrypted at rest by the provider in addition to being application-level ciphertext already.
- **coturn**: stateless relay — no data to back up, just config to keep in version control (`infrastructure/coturn/`).
- **Recovery principle** (master-prompt §71): no recovery runbook anywhere grants an operator access to a user's private keys — recovering the *service* (restoring Postgres/Redis/object storage from backup) never implies recovering the ability to *decrypt* anything, since that ability never existed server-side to begin with.
