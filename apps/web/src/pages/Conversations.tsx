// Past conversations with Josi. Yours, and only yours.
import { useEffect, useState } from 'react';
import { api, type Message, type Thread } from '@/lib/api';
import { Button, Card, Empty } from '@/components/ui';

export function Conversations() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    void api.get<{ threads: Thread[] }>('/assistant/threads').then((r) => setThreads(r.threads)).catch(() => undefined);
  }, []);

  async function open(id: string) {
    if (openId === id) { setOpenId(null); return; }
    const detail = await api.get<{ messages: Message[] }>(`/assistant/threads/${id}`);
    setMessages(detail.messages);
    setOpenId(id);
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
      <p className="text-sm text-muted-foreground">
        Private to you. Nobody else in this workspace sees them, including an administrator.
      </p>

      {threads.length === 0 ? (
        <Empty title="No conversations yet">Start one on the Talk page.</Empty>
      ) : (
        <ul className="space-y-2">
          {threads.map((t) => (
            <li key={t.id}>
              <Card>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{t.title ?? 'Conversation'}</span>
                  <Button variant="secondary" onClick={() => void open(t.id)} aria-expanded={openId === t.id}>
                    {openId === t.id ? 'Hide' : 'Open'}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(t.last_activity_at).toLocaleString()}
                </p>
                {openId === t.id ? (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    {messages.map((m) => (
                      <p key={m.id} className="whitespace-pre-wrap break-words text-sm">
                        <span className="text-muted-foreground">{m.direction === 'in' ? 'You: ' : 'Josi: '}</span>
                        {m.body}
                      </p>
                    ))}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
