import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { login } from '../../modules/auth/service';
import { respondToPendingDeviceLogin, completePendingDeviceLogin } from '../../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * New-device login approval (docs/07-auth-architecture.md's device-approval
 * section) — "send a notification to the other device to approve it first, only
 * then the new device can log in." Covers the three real properties this feature
 * has to hold: a second device never completes on its own, only the ACCOUNT's own
 * existing device can approve/deny it, and the winning poll's compare-and-swap
 * can't be tricked into materializing the device twice.
 */
describe('new-device login approval', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function setup() {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    // The account's first device — takes the "nothing to approve against yet"
    // fallback in login()'s own docstring, so this completes immediately.
    const first = await login({ username, password, newDevice: fakeDeviceRegistration('First device') }, null, 'vitest');
    if (first.status !== 'ok') throw new Error('expected first device to log in immediately');
    return { userId, username, password, firstDeviceId: first.result.deviceId };
  }

  it('a second device does NOT complete immediately — it returns pending_approval', async () => {
    const { username, password } = await setup();

    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration('Second device') }, null, 'vitest');
    expect(outcome.status).toBe('pending_approval');
    if (outcome.status !== 'pending_approval') return;
    expect(outcome.pendingLoginId).toBeTruthy();

    // And the waiting device's own poll reports it's still pending — no session
    // exists for it yet.
    const poll = await completePendingDeviceLogin(outcome.pendingLoginId);
    expect(poll.status).toBe('pending');
  });

  it('only the ACCOUNT\'s own device can approve — a different account gets NOT_FOUND', async () => {
    const { username, password } = await setup();
    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration('Second device') }, null, 'vitest');
    if (outcome.status !== 'pending_approval') throw new Error('expected pending_approval');

    const outsider = await createActiveUser();
    createdUserIds.push(outsider.userId);

    await expect(respondToPendingDeviceLogin(outsider.userId, outcome.pendingLoginId, true)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('approving lets the waiting device\'s poll complete and register a real, working device', async () => {
    const { userId, username, password } = await setup();
    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration('Second device') }, null, 'vitest');
    if (outcome.status !== 'pending_approval') throw new Error('expected pending_approval');

    await respondToPendingDeviceLogin(userId, outcome.pendingLoginId, true);

    const completed = await completePendingDeviceLogin(outcome.pendingLoginId);
    expect(completed.status).toBe('ok');
    if (completed.status !== 'ok') return;
    expect(completed.result.userId).toBe(userId);
    expect(completed.result.session.accessToken).toBeTruthy();

    const devices = await prisma.device.findMany({ where: { userId, status: 'active' } });
    expect(devices).toHaveLength(2); // first device + the newly-approved second one
  });

  it('denying keeps the waiting device permanently locked out — it never completes', async () => {
    const { userId, username, password } = await setup();
    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration('Second device') }, null, 'vitest');
    if (outcome.status !== 'pending_approval') throw new Error('expected pending_approval');

    await respondToPendingDeviceLogin(userId, outcome.pendingLoginId, false);

    const completed = await completePendingDeviceLogin(outcome.pendingLoginId);
    expect(completed.status).toBe('denied');

    const devices = await prisma.device.findMany({ where: { userId, status: 'active' } });
    expect(devices).toHaveLength(1); // only the first device — denial never registers one
  });

  it('a concurrent double-poll after approval only ever materializes ONE device (the compare-and-swap)', async () => {
    const { userId, username, password } = await setup();
    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration('Second device') }, null, 'vitest');
    if (outcome.status !== 'pending_approval') throw new Error('expected pending_approval');

    await respondToPendingDeviceLogin(userId, outcome.pendingLoginId, true);

    const [first, second] = await Promise.all([
      completePendingDeviceLogin(outcome.pendingLoginId),
      completePendingDeviceLogin(outcome.pendingLoginId),
    ]);
    const outcomes = [first, second];
    const winners = outcomes.filter((o) => o.status === 'ok');
    expect(winners).toHaveLength(1); // exactly one poll won the race

    const devices = await prisma.device.findMany({ where: { userId, status: 'active' } });
    expect(devices).toHaveLength(2); // never three — the loser materialized nothing
  });
});
