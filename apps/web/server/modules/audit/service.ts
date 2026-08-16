import { prisma } from '@comm/database';
import type { SecurityEvent } from '@comm/types';

/**
 * Self-scoped only — a user reads their own security activity feed (docs/89-security-center
 * in the master prompt). There is no route anywhere that lets one user read another's
 * security events; admin abuse-triage visibility (docs/09-trust-boundaries.md) is a
 * separate, explicitly-admin-gated capability layered on later, not this function.
 */
export async function listOwnSecurityEvents(userId: string, limit = 50): Promise<SecurityEvent[]> {
  const events = await prisma.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });

  return events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    deviceId: e.deviceId,
    createdAt: e.createdAt.toISOString(),
    metadata: (e.metadata as SecurityEvent['metadata']) ?? null,
  }));
}
