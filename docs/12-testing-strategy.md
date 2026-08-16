# 12 — Testing Strategy

Every security-sensitive feature is test-first: the test for a permission boundary or crypto property is written before the feature is considered complete, per master-prompt §103 — not bolted on afterward.

## Layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | Pure functions across `packages/*` and `apps/*/src` — crypto wrappers, Zod schemas, Argon2id wrapper, rate-limit bucket logic |
| Integration | Vitest + a real (test) Postgres/Redis instance | Nest module + repository + DB round-trips; e.g. "revoking a device actually excludes it from key-bundle issuance" |
| End-to-end | Playwright | Full flows through the real `apps/web` UI against a running `apps/api`: invite redemption → login → send/receive a message → verify it decrypts on the second (simulated) device |
| Security | Custom scripted suite, see below | Auth bypass, IDOR, injection, rate-limit bypass, WS authorization |
| Crypto | Vitest, isolated in `packages/crypto` | Test vectors, tamper detection, forward secrecy, multi-device fan-out |
| Load | k6 or Artillery | WebSocket connection scaling, message throughput, REST endpoint latency under load |
| Race-condition | Targeted integration tests | Concurrent invite redemption, concurrent one-time-prekey claims, concurrent refresh-token use |

## Security test cases (master-prompt §63, mapped to where they're exercised)

| Case | Where tested |
|---|---|
| SQL injection | Integration tests asserting Prisma's parameterization holds for every user-controlled filter/sort field; no raw string-concatenated SQL exists to test around in the first place, enforced by lint rule forbidding `$queryRawUnsafe` outside a reviewed allowlist |
| XSS | Playwright tests injecting `<script>`/event-handler payloads into every user-controlled rendered field (display name, about, group name/description, message content rendering) and asserting no execution; CSP header presence asserted in an integration test too |
| CSRF | Integration test: a state-changing request without the CSRF header, using a valid cookie, must be rejected |
| SSRF | Any server-initiated outbound fetch (none expected in the current design beyond push dispatch to known provider endpoints and object-storage signed-URL generation) is tested against attempts to redirect it at an internal address |
| IDOR | Security suite: authenticated user A attempts every `:id`-parameterized route with B's resource IDs, must get `FORBIDDEN`/`NOT_FOUND`, never B's data |
| Broken access control / privilege escalation | Group role tests: a `member` attempting an admin-only route (remove member, edit group, promote); a non-admin attempting `/admin/*` |
| Session fixation / theft | Integration test: refresh-token reuse after rotation revokes the family (see [07-auth-architecture](07-auth-architecture.md)); session cookie attributes asserted (`HttpOnly`, `Secure`, `SameSite`) |
| Token replay | Crypto suite: a captured message ciphertext replayed must either no-op (duplicate ID) or fail Double Ratchet decryption (stale key) |
| Brute-force / rate-limit bypass | Security suite: scripted rapid-fire login attempts assert lockout/backoff triggers; attempts to bypass via header spoofing (`X-Forwarded-For` manipulation) assert the rate limiter isn't fooled |
| WebSocket authorization bypass | Security suite: connect without a valid token (must be rejected at upgrade), connect then attempt to send events for a conversation the socket's user isn't a member of |
| Malicious file uploads | Security suite: oversized files, mismatched declared vs. actual content, path-traversal filenames, executable content masquerading as media — all rejected before a signed URL / storage write occurs |
| Path traversal | Object key generation is tested to reject/ignore any client-supplied path component entirely (server generates the key, full stop) |
| Prototype pollution | Zod parsing + a lint rule against unguarded `Object.assign`/spread from request bodies into shared objects |
| Command injection | N/A by design — no code path shells out with user-controlled input; a test/lint rule flags any future `child_process` usage for manual review |
| Insecure deserialization | JSON only, via Zod-validated schemas — no arbitrary object deserialization from untrusted input |
| Dependency vulnerabilities | `npm audit`/Dependabot in CI, see [11-deployment-architecture](11-deployment-architecture.md) |
| CORS misconfiguration | Integration test asserting the API only accepts the known web origin(s), not `*` |
| CSP bypass | Manual + automated header assertion; no `unsafe-inline`/`unsafe-eval` as a standing check |
| Open redirects | Any redirect-issuing route (invite links, OAuth-style flows if ever added) tested against attacker-supplied destination parameters |

## Cryptographic testing (master-prompt §64)

- **Test vectors**: run vodozemac's published test vectors (or, on the fallback path, the Signal spec's X3DH/Double Ratchet vectors) inside `packages/crypto/src/testvectors/` in CI — a green suite here is a precondition for any release, not optional.
- **Encrypt/decrypt correctness**: round-trip property tests across message sizes, including empty and max-size payloads.
- **Tamper detection**: flipping any bit of ciphertext or its auth tag must cause decryption to fail loudly, never return corrupted plaintext silently.
- **Nonce uniqueness**: property-based test asserting the media-encryption nonce generator never repeats across a large sample (statistical check, since a CSPRNG can't be proven never to collide, only shown to behave as expected).
- **Session establishment**: simulated multi-device fan-out — sender establishes independent sessions with each of a recipient's N devices, each decrypts correctly and independently.
- **Key rotation**: signed pre-key rotation mid-session doesn't break in-flight sessions; one-time pre-key exhaustion is handled (falls back to signed-pre-key-only handshake per the underlying protocol's own spec, not a custom fallback we invent).
- **Identity key changes**: a session continuing after a simulated identity key change must trigger the "security code changed" state, not silently proceed.
- **Revoked devices**: a revoked device's public keys, once revoked, are never returned by a key-bundle fetch — integration test against the `/keys/bundle` route.
- **Forward secrecy regression**: explicit test proving a chain key from message N cannot decrypt message N+1 after a ratchet step, even when handed to the test directly (guards against a future refactor accidentally weakening this property).

## What "done" requires

A feature touching auth, authorization, device linking, message crypto, group membership, or media access is not considered complete until its corresponding tests above exist and pass — mirrors the master prompt's final acceptance criteria (§104), checked per-feature at each roadmap phase rather than only at the very end.
