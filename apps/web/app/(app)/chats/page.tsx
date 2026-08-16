import { Logo } from '@/components/logo';
import { IconLock } from '@/components/icons';

// Desktop-only right-pane placeholder shown when no conversation is open —
// components/chat/chats-shell.tsx hides this on mobile (the sidebar itself takes
// the full screen there instead, WhatsApp-mobile-style, not a dead empty pane).
export default function ChatsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
      <Logo wordmark={false} className="h-16 w-16 opacity-90" />
      <div className="space-y-1">
        <p className="text-lg font-medium text-foreground">Select a chat to start messaging</p>
        <p className="mx-auto max-w-xs text-sm text-muted-foreground">
          Pick a conversation from the list, or tap the pencil icon to start a new one.
        </p>
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconLock className="h-3.5 w-3.5" />
        End-to-end encrypted —{' '}
        <a href="/about-encryption" className="underline underline-offset-2 hover:text-foreground">
          how it works
        </a>
      </p>
    </div>
  );
}
