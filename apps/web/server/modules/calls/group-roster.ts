import { getRedisClient } from '@comm/security';
import type { GroupCallParticipant } from '@comm/types';

/**
 * The LIVE roster of a group call in progress (docs/13-roadmap.md) — who's
 * currently connected, not call history (that's still the `Call` Postgres row,
 * reused as-is — see calls.ts's own module docstring). Redis, not Postgres: this
 * is ephemeral by nature (a snapshot of "right now," meaningless once the call
 * ends), same reasoning `pending.ts`'s ring-catch-up state already uses.
 *
 * A Redis HASH per call (`group-call-roster:<callId>`), one field per participant
 * device (`<userId>:<deviceId>`) — a hash rather than a Set of JSON strings so a
 * participant's own entry can be looked up/removed by key directly, not by
 * scanning and string-matching every member. `EXPIRE` refreshed on every write as
 * a safety net against an orphaned roster from a client that crashed without
 * leaving cleanly — generous (6h, far past any realistic call length) since the
 * normal cleanup path is always an explicit leave/end, not this TTL.
 */
const ROSTER_TTL_SECONDS = 6 * 60 * 60;

function key(callId: string): string {
  return `group-call-roster:${callId}`;
}

function field(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export async function addParticipant(callId: string, participant: GroupCallParticipant): Promise<void> {
  const redis = getRedisClient();
  const k = key(callId);
  await redis.hset(k, field(participant.userId, participant.deviceId), JSON.stringify(participant));
  await redis.expire(k, ROSTER_TTL_SECONDS);
}

export async function removeParticipant(callId: string, userId: string, deviceId: string): Promise<void> {
  await getRedisClient().hdel(key(callId), field(userId, deviceId));
}

export async function listParticipants(callId: string): Promise<GroupCallParticipant[]> {
  const raw = await getRedisClient().hvals(key(callId));
  const participants: GroupCallParticipant[] = [];
  for (const entry of raw) {
    try {
      participants.push(JSON.parse(entry) as GroupCallParticipant);
    } catch {
      // A corrupted single entry is skipped, not fatal to the whole roster fetch.
    }
  }
  return participants;
}

export async function rosterSize(callId: string): Promise<number> {
  return getRedisClient().hlen(key(callId));
}

export async function clearRoster(callId: string): Promise<void> {
  await getRedisClient().del(key(callId));
}
