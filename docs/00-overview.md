# 00 — Architecture Overview & Technology Decisions

## What this system is

A closed, invite-only messaging platform: real-time 1:1 and group text/voice/video, end-to-end encrypted private conversations, media/voice messages, multi-device support, and an installable PWA — designed so a future native Android client can speak the same API/WebSocket/crypto protocol without backend changes (see [95 in the master prompt] / [13-roadmap](13-roadmap.md)).

## Guiding priorities, in order

Security → Privacy → Reliability → Simplicity → Performance → Usability. When two goals conflict, the earlier one wins, and the tradeoff is written down rather than silently resolved (see each doc's "tradeoffs" notes).

## High-level component diagram

```
┌─────────────┐        HTTPS/WSS         ┌──────────────────────┐
│  Next.js PWA │◄────────────────────────►│  Nginx/Caddy (TLS,   │
│  (browser)   │                          │  reverse proxy, WAF  │
└─────┬────────┘                          │  optionally behind   │
      │ WebRTC media (P2P or via TURN)    │  Cloudflare)         │
      │                                   └──────────┬───────────┘
      │                                              │
      │                              ┌───────────────┼───────────────┐
      │                              ▼                                ▼
      │                     ┌─────────────────┐            ┌──────────────────┐
      │                     │ apps/web         │            │  apps/worker      │
      │                     │ Next.js custom   │◄──BullMQ──►│  (media, push,    │
      │                     │ server: App      │   /Redis   │  cleanup jobs)    │
      │                     │ Router (UI + API │            └────────┬─────────┘
      │                     │ Route Handlers)  │                     │
      │                     │ + `ws` upgrade   │                     │
      │                     │ handler (realtime)│                    │
      │                     └───┬─────────┬────┘                     │
      │                         │         │                          │
      │                         ▼         ▼                          ▼
      │                 ┌────────────┐ ┌─────────┐          ┌────────────────┐
      │                 │ PostgreSQL │ │  Redis  │          │ Object storage  │
      │                 │ (ciphertext│ │ (pubsub,│          │ (encrypted      │
      │                 │ + metadata)│ │ queues, │          │ media blobs)    │
      │                 └────────────┘ │ presence)│         └────────────────┘
      │                                └─────────┘
      └──────────────────────► coturn (self-hosted TURN/STUN, own systemd unit)
```

Everything above the "encrypted" line in PostgreSQL and object storage is ciphertext the server cannot decrypt. See [09-trust-boundaries](09-trust-boundaries.md) for the precise claim.

**Revision note**: the original draft of this document specified a separate NestJS-on-Fastify `apps/api` service alongside `apps/web`. That was changed to a single Next.js app per an explicit follow-up instruction — see the updated "Backend framework" row below. `apps/worker` is unaffected (a queue consumer has no reason to be a web framework).

## Technology decisions

| Layer | Choice | Why |
|---|---|---|
| Frontend framework | Next.js 14+ (App Router), TypeScript, React | SSR for fast first paint of the shell, file-based routing, first-class PWA/service-worker tooling, matches spec |
| Styling/UI | Tailwind CSS + shadcn/ui + Framer Motion | Fast to build a polished, consistent, accessible UI; shadcn components are copied into the repo (no opaque runtime dependency) so they're easy to security-review |
| Client state | Zustand (UI/local state) + TanStack Query (server cache) | Small, unopinionated, no heavy boilerplate; TanStack Query gives cache invalidation/retry for REST calls without hand-rolled logic |
| Local storage | IndexedDB (via a thin wrapper, e.g. `idb`) | Only browser storage suitable for structured, larger-than-localStorage, non-string data; keys stored as non-extractable `CryptoKey`s where possible (see [05-crypto-architecture](05-crypto-architecture.md)) |
| Backend framework | **Next.js**, same app as the frontend — App Router **Route Handlers** (`app/api/**/route.ts`) for REST, plus a **custom Next.js server** (`server.ts`, a plain Node `http.Server` wrapping Next's request handler) that also owns the WebSocket upgrade path | One framework, one deployable process for `apps/web`, no second service to build/deploy/keep in sync — chosen over NestJS/Fastify by explicit instruction. The module boundary (`auth, users, devices, ...`) is kept as a **service-layer convention** (`apps/web/server/modules/*`, plain TypeScript, no DI framework) called from thin Route Handlers, so the authorization-centralization property NestJS guards would have given us is preserved by discipline instead of framework enforcement — see [Module boundary without Nest](#module-boundary-without-nest) below |
| Validation | Zod, via a shared `packages/types` schema set and a small shared `parseBody()`/`parseQuery()` helper used at the top of every Route Handler | Explicitly requested; schemas double as the shared client/server contract (see [03-api-design](03-api-design.md)) — same role a Nest pipe would have played, just invoked explicitly instead of via decorator |
| Database | PostgreSQL | Requested; strong relational integrity for membership/authorization checks that must never be wrong |
| ORM | Prisma | Generates types shared with `packages/types`, has first-class migration tooling (`prisma migrate`), parameterizes all queries by construction (mitigates SQLi by default). Drizzle was considered (thinner, closer to SQL) — Prisma wins here for migration ergonomics in a solo/small-team, no-Docker workflow; revisit if raw query control becomes a bottleneck |
| Cache/pubsub/queue backing | Redis (ioredis client) | WebSocket fan-out across processes, presence/typing ephemeral state, BullMQ queue backend, rate-limit counters |
| Background jobs | BullMQ | Media transcoding/thumbnailing triggers (operating on *ciphertext* blobs only — see [05](05-crypto-architecture.md)), push dispatch, disappearing-message sweep, expired-invite cleanup |
| Realtime transport | WebSocket (`ws` package), attached to the same custom Next.js server's `http.Server` via its `upgrade` event; Redis adapter for multi-instance fan-out | Needed for messages, typing, presence, read receipts, call signaling in one authenticated channel (see [04-websocket-realtime](04-websocket-realtime.md)) |
| Calls | WebRTC + self-hosted coturn | Confirmed decision; see [11-deployment-architecture](11-deployment-architecture.md) and call security notes in [08-threat-model](08-threat-model.md) |
| E2E crypto | vodozemac (Olm + Megolm), WASM | See [05-crypto-architecture](05-crypto-architecture.md) for the full rationale and the documented alternative |
| Object storage | S3-compatible managed bucket (e.g. AWS S3 or Cloudflare R2) | Private bucket, signed URLs only, no self-run storage service (fits "no Docker") |
| Monorepo tooling | npm workspaces + Turborepo | No Docker required; Turborepo caches builds/tests across `apps/*` and `packages/*` |
| Process management (prod) | PM2 or systemd (documented in [11](11-deployment-architecture.md)) | Explicit "no Docker" constraint |

## Why not Docker (constraint, not a default)

The master prompt's own template assumes Docker Compose for local Postgres/Redis and containerized deployment. That's overridden here by explicit instruction: everything runs as plain Node.js processes, with Postgres/Redis provided as managed cloud services (or natively installed) rather than containers. The tradeoff — losing environment parity/isolation and one-command `docker compose up` reproducibility — is accepted; it's mitigated by pinning exact Node/Postgres/Redis versions in `docs/11-deployment-architecture.md` and `.tool-versions`/`engines` fields once code exists.

## What "modular backend" means here
<a id="module-boundary-without-nest"></a>

Without Nest's DI/module system, the same boundary is kept **by directory convention and a lint rule, not by a framework**: each module (`auth, users, devices, sessions, conversations, messages, groups, media, contacts, notifications, calls, keys, privacy, admin, audit`) lives at `apps/web/server/modules/<name>/` as `service.ts` (business logic + authorization checks) + `schemas.ts` (Zod request/response shapes, re-exported from `packages/types`). Route Handlers under `apps/web/app/api/<name>/**/route.ts` are kept intentionally thin — parse input with the module's schema, call the module's service function, map the result/error to an HTTP response — never containing authorization logic themselves. A module's service is the *only* thing allowed to import `packages/database`'s Prisma client for that module's tables; another module reaches it only through an exported function, mirroring the "no reaching into another module's database access directly" rule from the original design. This is enforced by code review discipline plus an ESLint `no-restricted-imports` rule per module directory, since there's no compiler-enforced module system doing it automatically the way Nest's would have.

## Cross-references

- Crypto choice and rationale: [05-crypto-architecture](05-crypto-architecture.md)
- Why registration is closed and how invites work: [07-auth-architecture](07-auth-architecture.md)
- Full schema: [02-database-schema](02-database-schema.md)
- What's deferred vs. built now: [13-roadmap](13-roadmap.md)
