import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { listCallHistory } from '@/server/modules/calls/history';
import { CallHistoryView } from '@/components/calls/call-history-view';

/** The "Calls" tab (docs/13-roadmap.md) — apps/mobile has had this since its own
 * Calls tab shipped; this is the same screen for web, reusing the same
 * `listCallHistory` service function server-side (mirrors how blocked/page.tsx
 * fetches directly rather than round-tripping through its own API route client-side). */
export default async function CallsPage() {
  const ctx = await getAuthContextOrRedirect();
  const calls = await listCallHistory(ctx.userId, 50);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl p-4">
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-foreground">Calls</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every call across your chats, newest first.</p>
        </div>
        <CallHistoryView initialCalls={calls} />
      </div>
    </div>
  );
}
