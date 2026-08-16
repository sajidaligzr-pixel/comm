import { z } from 'zod';

/**
 * Safe, predictable error codes — see docs/03-api-design.md#error-codes and
 * docs/08-threat-model.md's error-handling rule. `INTERNAL` is the only code ever
 * surfaced for an unexpected failure; the real cause goes to server-side logs only
 * (see docs/10-privacy-data-retention.md for what those logs may and may not contain).
 */
export const AppErrorCode = z.enum([
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'INVITE_INVALID_OR_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'DEVICE_REVOKED',
  'KEY_CHANGED',
  'MESSAGE_FAILED',
  'MEDIA_TOO_LARGE',
  'QUOTA_EXCEEDED',
  'VALIDATION_FAILED',
  'CONFLICT',
  'INTERNAL',
]);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/**
 * HTTP status each code maps to. Kept centrally so a Route Handler and a test both
 * reference the same table instead of re-deciding status codes ad hoc per route.
 */
export const APP_ERROR_STATUS: Record<AppErrorCode, number> = {
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  INVITE_INVALID_OR_EXPIRED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  DEVICE_REVOKED: 401,
  KEY_CHANGED: 409,
  MESSAGE_FAILED: 422,
  MEDIA_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 413,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  INTERNAL: 500,
};

/**
 * Thrown by server module code; caught once at the Route Handler boundary and mapped
 * to the standard envelope. `message` must always be safe to show a user — never
 * interpolate a raw DB/driver error message into it (that goes to server logs via
 * `cause` instead, which is never serialized into the HTTP response).
 */
export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = 'AppError';
  }
}

export const ErrorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({
    code: AppErrorCode,
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export function successEnvelope<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function errorEnvelope(err: AppError): ErrorEnvelope {
  return { ok: false, error: { code: err.code, message: err.message } };
}
