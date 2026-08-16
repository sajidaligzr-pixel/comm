# Comm — a privacy-first messaging platform

Comm is a closed, invite-only, end-to-end encrypted messaging platform in the spirit of Signal/WhatsApp: real-time 1:1 and group messaging, voice/video calls, media sharing, multi-device support, and a PWA client — built so that the operator (including admins) cannot read users' messages.

**Status: Phase 1 — architecture and design only. No application code exists yet.** This repository currently contains design documentation that must be reviewed and approved before implementation (Phase 2) begins, per the project's incremental-development rule (see [13-roadmap](docs/13-roadmap.md)).

## Why "closed" / invite-only

Unlike WhatsApp, this platform has **no public sign-up**. An administrator provisions every account via a single-use invite; the invitee sets their own password and generates their own device keys client-side, so the admin never learns a user's credentials or private keys. See [07-auth-architecture](docs/07-auth-architecture.md).

## Document index

Read in this order for a first pass; each is self-contained for later reference.

1. [00-overview.md](docs/00-overview.md) — architecture overview & technology decisions
2. [01-folder-structure.md](docs/01-folder-structure.md) — monorepo layout
3. [02-database-schema.md](docs/02-database-schema.md) — PostgreSQL schema
4. [03-api-design.md](docs/03-api-design.md) — API modules, contracts, error codes
5. [04-websocket-realtime.md](docs/04-websocket-realtime.md) — realtime protocol
6. [05-crypto-architecture.md](docs/05-crypto-architecture.md) — end-to-end encryption design
7. [06-device-architecture.md](docs/06-device-architecture.md) — device identity, linking, revocation
8. [07-auth-architecture.md](docs/07-auth-architecture.md) — invite provisioning, login, sessions
9. [08-threat-model.md](docs/08-threat-model.md) — adversaries and mitigations
10. [09-trust-boundaries.md](docs/09-trust-boundaries.md) — what each component can see
11. [10-privacy-data-retention.md](docs/10-privacy-data-retention.md) — metadata & retention policy
12. [11-deployment-architecture.md](docs/11-deployment-architecture.md) — no-Docker production topology
13. [12-testing-strategy.md](docs/12-testing-strategy.md) — test plan across all layers
14. [13-roadmap.md](docs/13-roadmap.md) — phased delivery plan
15. [14-risk-register.md](docs/14-risk-register.md) — top risks and mitigations

## Non-negotiable principles

These hold across every document above and every future implementation phase:

- **The server never possesses plaintext message content, plaintext media, or private keys.** It stores and routes ciphertext.
- **No cryptography is invented.** Primitives and protocols come from established, reviewed sources (see [05-crypto-architecture](docs/05-crypto-architecture.md)).
- **Authorization is enforced server-side, always** — never inferred from client-supplied roles or IDs.
- **Security takes priority over convenience.** Any feature that trades away security is called out explicitly, not silently shipped.
- **We do not claim "unhackable" or "zero metadata."** [09-trust-boundaries](docs/09-trust-boundaries.md) states plainly what the server can and cannot see.

## Getting started

There is no code yet. Once Phase 1 docs are approved, Phase 2 will scaffold the monorepo (`apps/web`, `apps/api`, `apps/worker`, `packages/*`) per [01-folder-structure](docs/01-folder-structure.md).
# comm
