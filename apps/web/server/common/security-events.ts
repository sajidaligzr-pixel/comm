import { prisma } from '@comm/database';
import type { SecurityEventType } from '@comm/types';

/**
 * The single write path for `security_events` — see docs/42-security-event-system in
 * the master prompt and docs/02-database-schema.md. `metadata` must stay structured
 * and free of message content by construction (the type signature only accepts
 * primitive values, not arbitrary objects/strings pulled from user-authored text).
 */
export async function recordSecurityEvent(input: {
  userId: string;
  eventType: SecurityEventType;
  deviceId?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, string | number | boolean> | null;
}): Promise<void> {
  await prisma.securityEvent.create({
    data: {
      userId: input.userId,
      eventType: input.eventType,
      deviceId: input.deviceId ?? null,
      ipHash: input.ipHash ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}
