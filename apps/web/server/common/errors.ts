import { NextResponse } from 'next/server';
import { AppError, APP_ERROR_STATUS, errorEnvelope, successEnvelope } from '@comm/types';

export { AppError };

/**
 * Every Route Handler funnels its result through this — a thrown AppError becomes a
 * safe, typed JSON error; anything else (a genuinely unexpected exception — a bug, a
 * DB driver error, ...) is logged server-side with full detail and mapped to a single
 * generic INTERNAL response. The client never sees the real cause of an unexpected
 * failure — see docs/08-threat-model.md's error-handling rule and docs/81 error codes.
 */
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(errorEnvelope(err), { status: APP_ERROR_STATUS[err.code] });
    }
    // Deliberately does not include `err` details in the response. `cause`/stack goes
    // to server logs only (docs/10-privacy-data-retention.md's operational-log
    // retention applies here) — never to the client, and never to a log line that
    // could contain request body content for a message-bearing route (none of this
    // module's routes carry message plaintext, but the rule is applied uniformly).
    console.error('[unhandled route error]', err);
    return NextResponse.json(
      errorEnvelope(new AppError('INTERNAL', 'Something went wrong. Please try again.')),
      { status: 500 },
    );
  }
}

export function jsonOk<T>(data: T, init?: { status?: number }): NextResponse {
  return NextResponse.json(successEnvelope(data), { status: init?.status ?? 200 });
}
