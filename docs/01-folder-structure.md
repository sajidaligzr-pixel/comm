# 01 — Folder Structure

Npm workspaces + Turborepo monorepo. No Docker files.

**Revision note**: originally `apps/web` (Next.js) and `apps/api` (NestJS/Fastify) were separate services. Per an explicit follow-up instruction, the backend was consolidated into Next.js — there is no `apps/api` anymore. `apps/web` now serves the UI *and* the API (Route Handlers) *and* the WebSocket realtime channel (via a custom server). `apps/worker` is unchanged — a queue consumer gains nothing from being a web framework, so it stays a plain Node/TS process.

```
comm/
├── apps/
│   ├── web/                     # Next.js app: UI + API + WebSocket realtime, one process
│   │   ├── server.ts             # Custom server entrypoint: wraps Next's request handler in a
│   │   │                         # plain http.Server, attaches the `ws` upgrade handler for
│   │   │                         # /realtime. Both `next dev` and `next start` are replaced by
│   │   │                         # running this file — see 11-deployment-architecture.md
│   │   ├── app/                  # App Router
│   │   │   ├── (auth)/            # /invite/[token], /login — public routes
│   │   │   ├── (app)/             # /chats, /calls, /settings/* — authenticated UI
│   │   │   └── api/               # Route Handlers = the REST API, see 03-api-design.md
│   │   │       ├── auth/          # invite/[token], invite/redeem, login, refresh, logout
│   │   │       ├── users/         # me, [username]
│   │   │       ├── devices/       # index, link/start, link/complete, [id]
│   │   │       ├── admin/         # users (provision), users/[id]/suspend
│   │   │       └── audit/         # security-events
│   │   ├── server/                # Server-only code, never bundled to the client
│   │   │   ├── modules/           # Business-logic services, one dir per domain module —
│   │   │   │   ├── auth/          # see "module boundary" note in 00-overview.md
│   │   │   │   ├── users/
│   │   │   │   ├── devices/
│   │   │   │   ├── admin/
│   │   │   │   ├── audit/
│   │   │   │   └── (conversations/messages/groups/media/contacts/notifications/
│   │   │   │       calls/keys/privacy — added in their respective phases, see 13-roadmap.md)
│   │   │   ├── realtime/          # ws server wiring: connection auth, event router, Redis
│   │   │   │                      # pub/sub adapter for cross-process fan-out
│   │   │   └── common/            # requireAuth()/requireAdmin() guards, parseBody() Zod
│   │   │                          # helper, AppError + response mapping, rate-limit helper
│   │   ├── components/            # Composer, MessageBubble, ChatListItem, CallScreen, etc.
│   │   ├── lib/                   # Client-side glue to packages/crypto, packages/realtime-client
│   │   ├── public/                # manifest.json, icons, offline shell
│   │   ├── service-worker/        # Workbox-based SW: caching, push handling
│   │   └── package.json
│   │
│   └── worker/                   # BullMQ consumers: media post-processing, push dispatch,
│       ├── src/jobs/              # disappearing-message sweep, invite/session cleanup
│       └── package.json
│
├── packages/
│   ├── crypto/                   # ALL cryptographic code lives here — see 05-crypto-architecture.md
│   │   ├── src/
│   │   │   ├── identity/         # key generation, serialization
│   │   │   ├── session/          # Olm session establishment/ratchet wrapper
│   │   │   ├── group/            # Megolm group session wrapper
│   │   │   ├── media/            # attachment AES-256-GCM encrypt/decrypt
│   │   │   ├── storage/          # IndexedDB key wrapping (Argon2id-derived KEK)
│   │   │   └── testvectors/      # spec-derived test vectors, run in CI
│   │   └── package.json
│   │
│   ├── types/                    # Zod schemas + inferred TS types shared by web/worker
│   ├── ui/                       # shadcn-derived component primitives, design tokens
│   ├── realtime-client/          # typed WebSocket client (reconnect/backoff/idempotency)
│   ├── database/                 # Prisma schema + generated client + migration helpers,
│   │                              # used by apps/web/server and apps/worker only
│   ├── config/                   # shared eslint/tsconfig/prettier base configs
│   └── security/                 # rate-limit primitives, Argon2id wrapper, header/CSP
│                                  # builder — shared, reviewed in isolation
│
├── infrastructure/
│   ├── nginx/ (or caddy/)        # reverse proxy config templates
│   ├── coturn/                   # coturn config template + credential-rotation script
│   ├── systemd/                  # unit files for apps/web (server.ts), apps/worker, coturn
│   └── scripts/                  # deploy, migrate, backup scripts (no Docker)
│
├── docs/                         # this documentation set
├── tests/
│   ├── e2e/                      # Playwright: full user flows through the real app
│   ├── security/                 # scripted abuse/auth-bypass/IDOR/rate-limit tests
│   └── load/                     # k6/Artillery scripts for WS + API load
│
├── .env.example                  # documented, no real secrets
├── turbo.json
├── package.json                  # workspaces root
└── tsconfig.base.json
```

## Rules this structure enforces

- **`packages/crypto` is the only place cryptographic primitives are called.** No React component or server route calls `crypto.subtle` or a ratchet function directly — they go through this package's typed API. Satisfies the master prompt's "don't scatter cryptographic logic" requirement and gives one place a security review can focus on.
- **`apps/web/server/**` never imports `packages/crypto`'s session/group modules.** The server has no business establishing or advancing a ratchet session; it only stores/routes opaque envelopes. (It may use `packages/security`'s Argon2id/random-token helpers for its own auth concerns, which is unrelated to message E2E encryption.)
- **`packages/database` is the only thing that touches Prisma/SQL**, and only `apps/web/server/modules/*` and `apps/worker` depend on it — nothing under `apps/web/app/` (Route Handlers) or `apps/web/components/` reaches the database directly. This keeps authorization checks centralized in the module service layer instead of scattered across route files, mirroring what NestJS's DI boundary would have given us structurally — see [00-overview](00-overview.md#module-boundary-without-nest).
- **Client vs. server code is separated by directory, not just by convention Next.js already half-enforces.** `apps/web/server/` never imports anything from `apps/web/components/` or ships to the browser; this is additionally checked by keeping all secrets/DB clients out of any file reachable from a `"use client"` component.
- **`apps/web` has no server-trust logic in its UI layer.** Every permission decision a component makes (e.g. hiding an admin button) is a convenience only; the same check is re-enforced in `apps/web/server/modules/*`.
