import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppError, disappearingTimerToMs, type DisappearingTimer } from '@comm/types';
import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { requireConversationMembership, listConversations } from '@/server/modules/conversations/service';
import { getGroup } from '@/server/modules/groups/service';
import { MessageThread } from '@/components/chat/message-thread';
import { GroupMessageThread } from '@/components/chat/group-message-thread';
import { Avatar } from '@/components/chat/avatar';
import { DisappearingTimerMenu } from '@/components/chat/disappearing-timer-menu';
import { CallButton } from '@/components/chat/call-button';
import { IconArrowLeft } from '@/components/icons';

const TIMER_LABEL: Partial<Record<DisappearingTimer, string>> = { h24: '24 hours', d7: '7 days', d30: '30 days' };

export default async function ChatThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params;
  const ctx = await getAuthContextOrRedirect();

  try {
    await requireConversationMembership(ctx.userId, conversationId);
  } catch (err) {
    if (err instanceof AppError) redirect('/chats');
    throw err;
  }

  // Reuses the list lookup rather than a dedicated single-conversation fetch —
  // Phase 3 doesn't have enough conversations per user yet for this to matter;
  // worth a dedicated `getConversation(id)` if that changes.
  const conversations = await listConversations(ctx.userId);
  const conversation = conversations.find((c) => c.id === conversationId);
  if (!conversation) redirect('/chats');

  const disappearingActive = conversation.disappearingTimer !== 'off';
  const timerLabel = disappearingActive ? `Disappearing: ${TIMER_LABEL[conversation.disappearingTimer]}` : null;

  // docs/13-roadmap.md's group chat pass — the two conversation shapes diverge enough
  // (no single "other user," a member list, no 1:1 call button) that they're two
  // full sub-trees here rather than one heavily-branching JSX block.
  if (conversation.type === 'group') {
    const group = await getGroup(conversation.group.id, ctx.userId);
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Link
            href="/chats"
            aria-label="Back to chats"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <IconArrowLeft className="h-5 w-5" />
          </Link>
          <Avatar name={group.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {timerLabel ?? `${group.members.length} member${group.members.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <DisappearingTimerMenu conversationId={conversationId} initialTimer={conversation.disappearingTimer} />
          {/* No call button here — group calls are explicitly out of scope
              (docs/13-roadmap.md's Voice calling pass: 1:1 only). */}
        </div>
        <GroupMessageThread
          conversationId={conversationId}
          groupId={group.id}
          currentUserId={ctx.userId}
          members={group.members}
          disappearingTimerMs={disappearingTimerToMs(conversation.disappearingTimer)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Link
          href="/chats"
          aria-label="Back to chats"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        >
          <IconArrowLeft className="h-5 w-5" />
        </Link>
        <Avatar name={conversation.otherUser.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{conversation.otherUser.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{timerLabel ?? `@${conversation.otherUser.username}`}</p>
        </div>
        <DisappearingTimerMenu conversationId={conversationId} initialTimer={conversation.disappearingTimer} />
        <CallButton
          conversationId={conversationId}
          otherUserId={conversation.otherUser.id}
          otherDisplayName={conversation.otherUser.displayName}
        />
      </div>
      <MessageThread
        conversationId={conversationId}
        currentUserId={ctx.userId}
        otherUserId={conversation.otherUser.id}
        otherDisplayName={conversation.otherUser.displayName}
        disappearingTimerMs={disappearingTimerToMs(conversation.disappearingTimer)}
      />
    </div>
  );
}
