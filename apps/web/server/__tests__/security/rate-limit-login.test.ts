import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as loginRoute } from '../../../app/api/auth/login/route';
import { createActiveUser, deleteTestUser } from '../helpers';

/**
 * Integration test through the REAL Route Handler (not just the underlying rate
 * limiter primitive, which packages/security already covers in isolation) — proves
 * docs/03-api-design.md's login rate-limit class is actually wired up, per
 * docs/12-testing-strategy.md's "rate-limit bypass" case.
 */
function loginRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('login rate limiting (integration)', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('locks out further attempts against one account after repeated failures', async () => {
    const { userId, username } = await createActiveUser();
    createdUserIds.push(userId);

    // docs/03-api-design.md's loginByAccount rule allows 8 attempts per 15-minute
    // window; drive it past that with wrong passwords from this "account" identity.
    let lastStatus = 0;
    let sawRateLimited = false;
    for (let i = 0; i < 12; i++) {
      // Must clear the 12-character minimum (packages/types' Password schema) so the
      // request actually reaches the rate limiter instead of failing validation first.
      const res = await loginRoute(loginRequest({ username, password: `wrong-password-attempt-${i}` }));
      lastStatus = res.status;
      const json = (await res.json()) as { ok: boolean; error?: { code: string } };
      if (!json.ok && json.error?.code === 'RATE_LIMITED') {
        sawRateLimited = true;
        break;
      }
    }

    expect(sawRateLimited).toBe(true);
    expect(lastStatus).toBe(429);
  });

  it('rejects a malformed body with VALIDATION_FAILED, not a 500', async () => {
    const res = await loginRoute(loginRequest({ username: '', password: '' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('VALIDATION_FAILED');
  });
});
