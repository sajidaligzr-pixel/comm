import type { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

/**
 * Auth state lives in HttpOnly cookies, never localStorage — see
 * docs/07-auth-architecture.md and docs/14-session-security in the master prompt. A
 * successful XSS therefore can't read the access/refresh token directly via
 * `document.cookie`; it could still ride the cookies to make same-origin requests,
 * which is exactly why every state-changing route additionally requires the CSRF
 * double-submit header below (a cookie-riding request without the header, which an
 * attacker's cross-origin page cannot read to forge, is rejected).
 */
export const ACCESS_TOKEN_COOKIE = 'comm_at';
export const REFRESH_TOKEN_COOKIE = 'comm_rt';
export const CSRF_COOKIE = 'comm_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const isProd = process.env.NODE_ENV === 'production';

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setAccessTokenCookie(res: NextResponse, token: string, maxAgeSeconds: number): void {
  res.cookies.set(ACCESS_TOKEN_COOKIE, token, { ...baseCookieOptions(), maxAge: maxAgeSeconds });
}

export function setRefreshTokenCookie(res: NextResponse, token: string, maxAgeSeconds: number): void {
  res.cookies.set(REFRESH_TOKEN_COOKIE, token, { ...baseCookieOptions(), maxAge: maxAgeSeconds });
}

/** Not HttpOnly by design — the client must be able to read it to echo it back as the
 * `x-csrf-token` header (double-submit pattern). It is not itself a secret an
 * attacker gains anything from reading; what matters is that a cross-origin attacker
 * cannot set/read *this site's* cookie to forge the matching header. */
export function setCsrfCookie(res: NextResponse): string {
  const token = randomBytes(32).toString('base64url');
  res.cookies.set(CSRF_COOKIE, token, { ...baseCookieOptions(), httpOnly: false });
  return token;
}

export function clearAuthCookies(res: NextResponse): void {
  const expired = { ...baseCookieOptions(), maxAge: 0 };
  res.cookies.set(ACCESS_TOKEN_COOKIE, '', expired);
  res.cookies.set(REFRESH_TOKEN_COOKIE, '', expired);
  res.cookies.set(CSRF_COOKIE, '', { ...expired, httpOnly: false });
}
