import type { Redis } from 'ioredis'; // see redis-client.ts's comment on named vs default import

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimitRule {
  /** Redis key namespace, e.g. "auth:login:ip" — see docs/03-api-design.md's route-class table. */
  readonly namespace: string;
  readonly windowSeconds: number;
  readonly max: number;
}

/**
 * Fixed-window counter, atomic INCR+PEXPIRE via a Lua script so a burst of concurrent
 * requests can't race between the two commands and leave a counter with no expiry
 * (which would turn a rate limit into a permanent lockout). Redis is the correct home
 * for this — see docs/00-overview.md's "Cache/pubsub/queue backing" row — counters are
 * ephemeral and must be shared across every `apps/web` process (docs/04-websocket-realtime.md).
 */
const INCR_WITH_EXPIRY_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

/**
 * `identity` should already be a value safe to persist as part of a Redis key — for
 * per-account limits that's a user id (not the username, to avoid coupling the limiter
 * key to a value that could theoretically change); for per-IP limits, see
 * docs/10-privacy-data-retention.md — this module itself doesn't decide whether to
 * hash the identity, the caller does, matching the same "hash before persisting"
 * rule applied to `sessions.ip_hash` in docs/02-database-schema.md.
 */
export async function checkRateLimit(
  redis: Redis,
  rule: RateLimitRule,
  identity: string,
): Promise<RateLimitResult> {
  const key = `ratelimit:${rule.namespace}:${identity}`;
  const windowMs = rule.windowSeconds * 1000;
  const [current, ttlMs] = (await redis.eval(
    INCR_WITH_EXPIRY_LUA,
    1,
    key,
    windowMs.toString(),
  )) as [number, number];

  const resetAt = new Date(Date.now() + Math.max(ttlMs, 0));
  return {
    allowed: current <= rule.max,
    remaining: Math.max(rule.max - current, 0),
    resetAt,
  };
}

/**
 * Two independent buckets (e.g. per-account and per-IP) must BOTH allow the request —
 * this is what stops an attacker spraying one password across many accounts from one
 * IP from hiding inside each account's individually-fresh bucket, per
 * docs/07-auth-architecture.md's brute-force protection section. Both checks always
 * run (no short-circuit) so the two counters stay in sync regardless of which one
 * happens to trip first — an attacker probing which limiter is stricter learns nothing
 * from a short-circuited call pattern.
 */
export async function checkCombinedRateLimit(
  redis: Redis,
  checks: Array<{ rule: RateLimitRule; identity: string }>,
): Promise<RateLimitResult> {
  const results = await Promise.all(checks.map((c) => checkRateLimit(redis, c.rule, c.identity)));
  const blocked = results.find((r) => !r.allowed);
  if (blocked) return blocked;
  // All allowed — return the tightest remaining/resetAt so callers surface the
  // soonest-binding limit to the client.
  return results.reduce((tightest, r) => (r.remaining < tightest.remaining ? r : tightest));
}

/** Route-class rules referenced by docs/03-api-design.md's rate-limiting table. Phase 2 subset. */
export const RATE_LIMIT_RULES = {
  loginByAccount: { namespace: 'auth:login:account', windowSeconds: 15 * 60, max: 8 } satisfies RateLimitRule,
  loginByIp: { namespace: 'auth:login:ip', windowSeconds: 15 * 60, max: 20 } satisfies RateLimitRule,
  inviteLookup: { namespace: 'auth:invite:lookup', windowSeconds: 60, max: 10 } satisfies RateLimitRule,
  inviteRedeem: { namespace: 'auth:invite:redeem', windowSeconds: 60 * 60, max: 5 } satisfies RateLimitRule,
  deviceLinkComplete: { namespace: 'devices:link:complete', windowSeconds: 60 * 60, max: 10 } satisfies RateLimitRule,
  deviceLinkLookup: { namespace: 'devices:link:lookup', windowSeconds: 60, max: 10 } satisfies RateLimitRule,
  refresh: { namespace: 'auth:refresh', windowSeconds: 60, max: 30 } satisfies RateLimitRule,
  usernameLookup: { namespace: 'users:lookup', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  deviceRevoke: { namespace: 'devices:revoke', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  adminProvision: { namespace: 'admin:provision', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  // Generous relative to login/discovery — legitimate session-start traffic, but
  // still a one-time-prekey-exhaustion DoS target (docs/03-api-design.md's Key
  // claim route class), so not left unlimited.
  keyBundleClaim: { namespace: 'keys:bundle:claim', windowSeconds: 60, max: 60 } satisfies RateLimitRule,
  keyUpload: { namespace: 'keys:upload', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  // Generous — normal chat activity, capped to block spam bursts
  // (docs/03-api-design.md's Messaging route class). WS `message.send` and this
  // REST fallback share the same bucket.
  messageSend: { namespace: 'messages:send', windowSeconds: 60, max: 120 } satisfies RateLimitRule,
  // A separate, tighter bucket layered ON TOP of messageSend above — specifically
  // for `image`/`voice` messages, whose plaintext (inline ciphertext, no object
  // storage) can be up to a few MB each, unlike a text message. messageSend's 120/min
  // bounds message COUNT; this bounds how much of that traffic can be heavy inline
  // media, so a burst of maximum-size photos can't use the same headroom a burst of
  // one-line texts gets (docs/10-privacy-data-retention.md's media retention pass —
  // this is the storage-flood angle, same reasoning as `mediaUploadUrl` below but for
  // the inline-ciphertext path, which never touches that route at all).
  mediaMessageSend: { namespace: 'messages:send:media', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  // Ringing someone is disruptive in a way a chat message isn't — 6/min is well above
  // any legitimate retry cadence (one attempt, maybe an immediate redial) but stops
  // an account being used to harass another with repeated rings.
  callInvite: { namespace: 'calls:invite', windowSeconds: 60, max: 6 } satisfies RateLimitRule,
  // Covers answer/reject/end/ice-candidate together — ICE gathering alone can emit a
  // couple dozen candidates in the first second of a single call, so this needs to be
  // generous relative to callInvite, not a stricter copy of it.
  callSignal: { namespace: 'calls:signal', windowSeconds: 60, max: 120 } satisfies RateLimitRule,
  callTurnCredentials: { namespace: 'calls:turn-credentials', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  pushSubscribe: { namespace: 'push:subscribe', windowSeconds: 60, max: 10 } satisfies RateLimitRule,
  // Sized-tier per docs/03-api-design.md's Uploads route class — a legitimate client
  // sends a handful of files a minute at most; this bounds storage-churn/abuse, not
  // normal use.
  mediaUploadUrl: { namespace: 'media:upload-url', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  mediaDownloadUrl: { namespace: 'media:download-url', windowSeconds: 60, max: 60 } satisfies RateLimitRule,
  groupCreate: { namespace: 'groups:create', windowSeconds: 60 * 60, max: 10 } satisfies RateLimitRule,
  groupMemberChange: { namespace: 'groups:member-change', windowSeconds: 60, max: 30 } satisfies RateLimitRule,
  // WS group.key-share relay — as generous as callSignal, since a member-removal
  // rotation fans out one key-share per remaining member in a burst.
  groupKeyShare: { namespace: 'groups:key-share', windowSeconds: 60, max: 120 } satisfies RateLimitRule,
  // Checked once on every WS reconnect/app-resume (apps/mobile's push notification
  // pass — see server/modules/calls/pending.ts), not per-keystroke traffic like most
  // of the rest of this table, but a flaky connection can still reconnect several
  // times a minute, so this stays generous rather than tight.
  callPendingCheck: { namespace: 'calls:pending-check', windowSeconds: 60, max: 60 } satisfies RateLimitRule,
  callHistory: { namespace: 'calls:history', windowSeconds: 60, max: 30 } satisfies RateLimitRule,
  // Ringing a whole group at once is more disruptive than a 1:1 ring (every
  // member's every device), not less — kept exactly as tight as callInvite
  // rather than given extra headroom for the larger fan-out.
  groupCallStart: { namespace: 'group-calls:start', windowSeconds: 60, max: 6 } satisfies RateLimitRule,
  // Covers join/leave/offer/answer/ice-candidate together — deliberately more
  // generous than 1:1's callSignal (120/min): a mesh call is pairwise, so one
  // join near a full room opens up to GROUP_CALL_MAX_PARTICIPANTS-1 simultaneous
  // offer/answer/ICE exchanges instead of 1:1's single pair, multiplying normal
  // signaling volume by roughly that same factor.
  groupCallSignal: { namespace: 'group-calls:signal', windowSeconds: 60, max: 400 } satisfies RateLimitRule,
  // A device pings roughly every 30s foregrounded / every 2-5min backgrounded
  // (docs/09-trust-boundaries.md's live-location plan) — 20/min comfortably covers
  // that cadence while still bounding a misbehaving/compromised client from
  // hammering this write.
  locationPing: { namespace: 'locations:ping', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  locationViewerGrant: { namespace: 'locations:viewer-grant', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  // New-device login approval (docs/07-auth-architecture.md) — the waiting new
  // device polls every couple of seconds until resolved; 60/min comfortably covers
  // that cadence for the several minutes a request stays pending, same "generous
  // poll allowance" reasoning as callPendingCheck above. Public/unauthenticated
  // (this device isn't signed in yet), so this is the only real abuse guard on it.
  pendingLoginPoll: { namespace: 'auth:pending-login:poll', windowSeconds: 60, max: 60 } satisfies RateLimitRule,
  pendingLoginRespond: { namespace: 'auth:pending-login:respond', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  // Multi-device message history sync (docs/07-auth-architecture.md) — fetched
  // once per login/bootstrap, so this stays modest like keyUpload.
  historyKeyFetch: { namespace: 'history:key:fetch', windowSeconds: 60, max: 20 } satisfies RateLimitRule,
  historyKeyCreate: { namespace: 'history:key:create', windowSeconds: 60, max: 10 } satisfies RateLimitRule,
  // One call per message this device newly decrypts/sends — as generous as
  // messageSend, since a burst of catch-up (opening a long-unread conversation)
  // can write one of these per message in the page.
  historyEntryWrite: { namespace: 'history:entry-write', windowSeconds: 60, max: 120 } satisfies RateLimitRule,
} as const;
