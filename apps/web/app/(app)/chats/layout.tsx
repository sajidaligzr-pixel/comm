import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { listConversations } from '@/server/modules/conversations/service';
import { ChatsShell } from '@/components/chat/chats-shell';

export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContextOrRedirect();
  const conversations = await listConversations(ctx.userId);

  return (
    <ChatsShell initialConversations={conversations} currentUserId={ctx.userId}>
      {children}
    </ChatsShell>
  );
}
