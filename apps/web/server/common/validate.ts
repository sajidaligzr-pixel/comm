import type { NextRequest } from 'next/server';
import type { z } from 'zod';
import { AppError } from '@comm/types';

/**
 * The one place request bodies are parsed against a Zod schema — every Route Handler
 * uses this instead of `await req.json()` directly, so "validate before touching the
 * body" isn't something each handler has to remember to do (docs/34-api-security.md's
 * schema-validation rule). Throws VALIDATION_FAILED with the first Zod issue's message
 * — safe to show a user (it's a shape complaint about their own input, never internal
 * detail) and specific enough to be useful.
 */
export async function parseBody<T extends z.ZodTypeAny>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Request body must be valid JSON.');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') || 'body';
    throw new AppError('VALIDATION_FAILED', `Invalid ${path}: ${first?.message ?? 'validation failed'}.`);
  }
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(req: NextRequest, schema: T): z.infer<T> {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') || 'query';
    throw new AppError('VALIDATION_FAILED', `Invalid ${path}: ${first?.message ?? 'validation failed'}.`);
  }
  return result.data;
}
