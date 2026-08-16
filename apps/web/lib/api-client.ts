'use client';

/**
 * Thin fetch wrapper for client components. Reads the CSRF cookie (not HttpOnly, by
 * design — see server/common/cookies.ts) and echoes it as the required header on
 * every mutating request; the auth/refresh cookies themselves are HttpOnly and ride
 * along automatically via `credentials: 'include'`, never touched by this code.
 */
const CSRF_COOKIE = 'comm_csrf';
const CSRF_HEADER = 'x-csrf-token';

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const json = (await res.json()) as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
  if (!json.ok) {
    throw new ApiError(json.error.code, json.error.message);
  }
  return json.data;
}
