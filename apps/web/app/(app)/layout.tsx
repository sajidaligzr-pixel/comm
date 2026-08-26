import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { isAdmin } from '@/server/modules/admin/service';
import { hasLocationAccess } from '@/server/modules/locations/service';
import { getMustChangePassword } from '@/server/modules/auth/service';
import { SignOutButton } from '@/components/sign-out-button';
import { Logo } from '@/components/logo';
import { RealtimeConnector } from '@/components/realtime-connector';
import { CallProvider } from '@/components/call/call-provider';
import { GroupCallProvider } from '@/components/call/group-call-provider';
import { GroupSessionProvider } from '@/components/group/group-session-provider';
import { NotificationPrompt } from '@/components/notification-prompt';
import { LocationPrompt } from '@/components/location-prompt';
import { UnlockGate } from '@/components/unlock-gate';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContextOrRedirect();

  // Enforced here, server-side, on every request under (app) — not just as a
  // post-login client redirect — see docs/07-auth-architecture.md. /change-password
  // itself lives outside the (app) route group specifically so this check can't
  // loop back onto it.
  if (await getMustChangePassword(ctx.userId)) {
    redirect('/change-password');
  }

  const [admin, canSeeMap] = await Promise.all([isAdmin(ctx.userId), hasLocationAccess(ctx.userId)]);

  return (
    // Fixed to the viewport height, not the document — the chats section manages
    // its own internal scroll regions (sidebar list, message thread) WhatsApp-style
    // rather than the whole page scrolling; other (app) pages opt back into normal
    // page scrolling themselves (see their own `overflow-y-auto` wrapper).
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <RealtimeConnector />
      <NotificationPrompt />
      <LocationPrompt />
      {/* Mounted at the app shell level, not inside the chats route — an incoming
          call must ring no matter which page is open (docs/13-roadmap.md's Phase 6
          slice), same reasoning as RealtimeConnector above. GroupCallProvider is a
          SEPARATE, sibling provider (docs/13-roadmap.md's group calls pass) — see
          its own module docstring for why it's not nested inside/merged with
          CallProvider despite the identical "mount once, ring anywhere" reasoning.
          GroupSessionProvider is here for the identical reason as both: a
          group.key-share/members-changed event can arrive while the user is
          anywhere in the app, not just an open group thread. */}
      <CallProvider>
        <GroupCallProvider>
          <GroupSessionProvider currentUserId={ctx.userId}>
            <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-6 text-foreground">
                <Logo className="h-6 w-auto" />
                <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
                  <Link href="/chats" className="hover:text-foreground">
                    Chats
                  </Link>
                  {admin && (
                    <Link href="/admin" className="hover:text-foreground">
                      Admin
                    </Link>
                  )}
                  {canSeeMap && (
                    <Link href="/admin/map" className="hover:text-foreground">
                      Location Map
                    </Link>
                  )}
                </nav>
              </div>
              <div className="flex items-center gap-1">
                {/* Icon-only nav on narrow screens, where the wordmark + text links above
                    would crowd the header — same destinations, just compact. */}
                <nav className="flex items-center gap-1 sm:hidden">
                  {admin && (
                    <Link
                      href="/admin"
                      className="flex h-9 items-center rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Admin
                    </Link>
                  )}
                  {canSeeMap && (
                    <Link
                      href="/admin/map"
                      className="flex h-9 items-center rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Map
                    </Link>
                  )}
                </nav>
                <SignOutButton />
              </div>
            </header>
            <main className="flex min-h-0 flex-1 flex-col">
              <UnlockGate>{children}</UnlockGate>
            </main>
          </GroupSessionProvider>
        </GroupCallProvider>
      </CallProvider>
    </div>
  );
}
