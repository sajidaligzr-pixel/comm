import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AppError } from '@comm/types';
import { authenticateAccessToken } from '@/server/common/auth';
import { ACCESS_TOKEN_COOKIE } from '@/server/common/cookies';

export default async function RootPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;

  // `redirect()` works by throwing a special Next.js control-flow error, so it must
  // never be called from inside a try block that also catches generic errors — it
  // would swallow its own redirect. Decide first, redirect after, outside any catch.
  let authenticated = false;
  try {
    await authenticateAccessToken(token);
    authenticated = true;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }

  redirect(authenticated ? '/chats' : '/login');
}
