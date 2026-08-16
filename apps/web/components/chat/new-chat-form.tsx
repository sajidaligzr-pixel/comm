'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';
import { Input, FieldError } from '../ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import type { ConversationSummary } from '@comm/types';

export function NewChatForm({ onStarted }: { onStarted?: () => void } = {}): React.JSX.Element {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const conversation = await apiFetch<ConversationSummary>('/api/conversations/direct', {
        body: { withUsername: username.trim().toLowerCase() },
      });
      onStarted?.();
      router.push(`/chats/${conversation.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start that conversation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="pt-1">
      <div className="flex gap-2">
        <Input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-label="Start a conversation with username"
          autoFocus
        />
        <Button type="submit" disabled={submitting || !username.trim()}>
          {submitting ? 'Starting…' : 'Chat'}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">Usernames are unique — enter exactly who you mean.</p>
      <FieldError>{error}</FieldError>
    </form>
  );
}
