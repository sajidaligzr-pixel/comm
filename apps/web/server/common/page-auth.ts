import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppError } from '@comm/types';
import { authenticateAccessToken, requireAdmin, requireLocationAccess, type AuthContext } from './auth';
import { ACCESS_TOKEN_COOKIE } from './cookies';

/**
 * Server Component equivalent of `requireAuth` — reads the same HttpOnly cookie via
 * `next/headers` instead of a `NextRequest`, then defers to the same DB-checking
 * core (`authenticateAccessToken`) so the two entry points can never drift in what
 * counts as "authenticated." Redirects rather than throwing, since a page render
 * (unlike a Route Handler) has nowhere to return a JSON error to.
 */
export async function getAuthContextOrRedirect(): Promise<AuthContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  try {
    return await authenticateAccessToken(token);
  } catch (err) {
    if (err instanceof AppError) {
      redirect('/login');
    }
    throw err;
  }
}

export async function getAdminContextOrRedirect(): Promise<AuthContext> {
  const ctx = await getAuthContextOrRedirect();
  try {
    await requireAdmin(ctx);
  } catch (err) {
    if (err instanceof AppError) {
      redirect('/devices');
    }
    throw err;
  }
  return ctx;
}

/** Same shape as `getAdminContextOrRedirect`, but for the live-location map/pages
 * that a granted `LocationViewer` must also reach — not admin-only. */
export async function getLocationAccessContextOrRedirect(): Promise<AuthContext> {
  const ctx = await getAuthContextOrRedirect();
  try {
    await requireLocationAccess(ctx);
  } catch (err) {
    if (err instanceof AppError) {
      redirect('/devices');
    }
    throw err;
  }
  return ctx;
}
