import { z } from 'zod';
import { DeviceKeyBundle } from './crypto-keys';

export const DeviceType = z.enum(['web', 'android', 'desktop']);
export type DeviceType = z.infer<typeof DeviceType>;

export const DeviceStatus = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const DeviceName = z.string().trim().min(1).max(64);

export const DeviceSummary = z.object({
  id: z.string().uuid(),
  name: DeviceName,
  deviceType: DeviceType,
  status: DeviceStatus,
  linkedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  isCurrentDevice: z.boolean(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

/** Submitted alongside login/invite-redeem when the request originates from a device
 * the account hasn't seen before — see docs/07-auth-architecture.md. */
export const NewDeviceRegistration = z.object({
  name: DeviceName,
  deviceType: DeviceType,
  keyBundle: DeviceKeyBundle,
});
export type NewDeviceRegistration = z.infer<typeof NewDeviceRegistration>;

export const LinkDeviceStartResponse = z.object({
  linkingToken: z.string(),
  expiresAt: z.string().datetime(),
  primaryDeviceIdentityPublicKey: z.string(),
});
export type LinkDeviceStartResponse = z.infer<typeof LinkDeviceStartResponse>;

export const LinkDeviceCompleteRequest = z.object({
  linkingToken: z.string().min(16).max(256),
  device: NewDeviceRegistration,
});
export type LinkDeviceCompleteRequest = z.infer<typeof LinkDeviceCompleteRequest>;
