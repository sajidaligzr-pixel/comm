import { z } from 'zod';

export const SecurityEventType = z.enum([
  'login_success',
  'login_failed',
  'new_device_linked',
  'device_revoked',
  'password_changed',
  'identity_key_changed',
  'session_revoked',
  'suspicious_login',
  'account_provisioned',
  'account_suspended',
  'account_deleted',
  'new_device_login_requested',
  'new_device_login_approved',
  'new_device_login_denied',
]);
export type SecurityEventType = z.infer<typeof SecurityEventType>;

export const SecurityEvent = z.object({
  id: z.string().uuid(),
  eventType: SecurityEventType,
  deviceId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  // Structured only — never free text that could contain message content. See
  // docs/10-privacy-data-retention.md and docs/38 logging rule in the master prompt.
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
});
export type SecurityEvent = z.infer<typeof SecurityEvent>;
