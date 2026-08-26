import { z } from 'zod';

/**
 * Live location sharing (docs/09-trust-boundaries.md's "Live location sharing"
 * exception) — a deliberate, narrow break from this app's otherwise-total E2E model.
 * Unlike every other DTO in this package, these carry genuine plaintext: the server
 * stores and can read the coordinates, by explicit product decision. Kept in their own
 * file/module rather than folded into `messages.ts` so that exception stays visually
 * and structurally separate from the real E2E content types.
 */

/** A single fix reported by the sharing user's own device — any signed-in device may
 * submit its own ping (`POST /api/locations`); no special privilege is needed to
 * *share*, only to *view* (see `LiveLocation`/`requireLocationAccess`). */
export const LocationPing = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().nullable(),
  headingDeg: z.number().min(0).max(360).nullable(),
  speedMps: z.number().nonnegative().nullable(),
  recordedAt: z.string().datetime(),
});
export type LocationPing = z.infer<typeof LocationPing>;

/** What a viewer (an `Admin`, or a user with a `LocationViewer` grant) sees for one
 * tracked user — `listLiveLocations`'s shape and the payload every `location.updated`
 * realtime event carries. */
export const LiveLocation = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  accuracyM: z.number().nullable(),
  headingDeg: z.number().nullable(),
  speedMps: z.number().nullable(),
  recordedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LiveLocation = z.infer<typeof LiveLocation>;

/** A viewer grant row — `grantedBy`/`grantedAt` are shown in the admin-facing
 * "Location access" list so it's clear who granted whom, mirroring how `DeviceSummary`
 * surfaces its own audit-relevant fields. */
export const LocationViewerDto = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  grantedAt: z.string().datetime(),
});
export type LocationViewerDto = z.infer<typeof LocationViewerDto>;

export const GrantLocationViewerRequest = z.object({
  username: z.string(),
});
export type GrantLocationViewerRequest = z.infer<typeof GrantLocationViewerRequest>;
