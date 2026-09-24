// Talking to Josi.
//
// Ported from the engine's Assistant component, and the details below are the
// ones that were expensive to learn. The engine's send path was rewritten three
// times chasing a bug that turned out to be an account with no workspace — so
// what survived is deliberately the SIMPLEST thing that works, and it is worth
// stating why each piece is here before someone "cleans it up":
//
//   * A plain <form onSubmit> with a type="submit" button. The tap, the Enter
//     key and a mouse click all arrive through one path. Earlier versions bolted
//     pointerdown and touchend handlers on top, which on iOS produced double
//     sends and, on one path, none at all.
//   * text-base on the textarea. Anything smaller and Safari zooms the page
//     when the field takes focus, which reads to a user as a layout bug.
//   * h-11 w-11 on the button — 44x44, the iOS tap target minimum.
//   * pb-[max(...,env(safe-area-inset-bottom))] plus viewport-fit=cover in
//     index.html, or the composer sits under the home indicator.
//   * Plain 100dvh height, normal flex flow, NO VisualViewport JS. A previous
//     round drove the height from a VisualViewport handler and the composer
//     shot to the top of the screen when the keyboard opened (round-2 item
//     25). iOS pans the focused field into view natively; let it.
//   * A send lock, because a double tap must not send twice.
//
// The e2e suite taps this button in WebKit with touch emulation, which is the
// closest thing to Safari on an iPhone that runs unattended.
import { Fragment, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Message, type Thread, type TurnResult } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { VoiceChat } from '@/components/VoiceChat';

/** "Today", "Yesterday", or the date — the label WhatsApp taught everyone. */
function dayLabel(at: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: at.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
import { ErrorNote } from '@/components/ui';

const talkCache = new Map<string, { thread: Thread; messages: Message[] }>();

export function Talk() {
  const { user } = useAuth();
  const cached = user ? talkCache.get(user.id) : undefined;
  const [thread, setThread] = useState<Thread | null>(cached?.thread ?? null);
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [sending, setSending] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);

  // The most recent thread, or a new one. A member always has somewhere to talk.
  useEffect(() => {
    if (!user || talkCache.has(user.id)) return;
    void (async () => {
      try {
        const { threads } = await api.get<{ threads: Thread[] }>('/assistant/threads');
        const existing = threads[0];
        if (existing) {
          setThread(existing);
          const detail = await api.get<{ messages: Message[] }>(`/assistant/threads/${existing.id}`);
          setMessages(detail.messages);
          talkCache.set(user.id, { thread: existing, messages: detail.messages });
        } else {
          const created = await api.post<{ thread: Thread }>('/assistant/threads', { title: 'Talk' });
          setThread(created.thread);
          talkCache.set(user.id, { thread: created.thread, messages: [] });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the conversation');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  useEffect(() => {
    if (user && thread) talkCache.set(user.id, { thread, messages });
  }, [messages, thread, user]);

  // Never animate through the full transcript when a message is sent. On a
  // long thread, that looked exactly like the conversation was being fetched
  // and replayed from the top (especially while Chrome-on-iOS also resized its
  // toolbar). Put the newest message in place immediately; the bubble itself is
  // the motion/feedback the user needs.
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' as ScrollBehavior });
  }, [messages]);

  // When the keyboard opens/closes the page height changes and the scrolling
  // list reflows from the top — visually indistinguishable from the whole
  // conversation reloading (round-2 item 25, Chrome-on-iOS evidence). Re-pin
  // the newest message instantly on every viewport resize so the list never
  // appears to reset. `instant` because an animated correction reads as a
  // second glitch, not a fix.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const repin = () => {
      if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    };
    vv.addEventListener('resize', repin);
    return () => vv.removeEventListener('resize', repin);
  }, []);

  async function send(spoken?: string): Promise<string | undefined> {
    if (spoken === undefined && voiceActive) return;
    // Read the DOM value as well as React state: iOS can display composition
    // text before a controlled component catches up.
    const body = (spoken ?? inputElement.current?.value ?? input).trim();
    const attachments = spoken === undefined ? files : [];
    if (!thread || (!body && !attachments.length) || sendLock.current) return;
    sendLock.current = true;

    const optimistic: Message = {
      id: `pending-${Math.random().toString(36).slice(2)}`,
      thread_id: thread.id, direction: 'in', channel: 'web', body: body || 'Sent an attachment',
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    if (spoken === undefined) setInput('');
    setSending(true);
    setError('');

    try {
      const attachmentIds: string[] = [];
      for (const file of attachments) {
        const form = new FormData(); form.append('file', file);
        const uploaded = await api.upload<{ attachment: { id: string; filename: string; contentType: string } }>(`/assistant/threads/${thread.id}/attachments`, form);
        attachmentIds.push(uploaded.attachment.id);
      }
      const uploadedMeta = attachments.map((file, index) => ({
        id: attachmentIds[index], filename: file.name, contentType: file.type || 'application/octet-stream',
      }));
      setMessages((current) => current.map((message) => message.id === optimistic.id
        ? { ...message, meta: { attachments: uploadedMeta } } : message));
      const result = await api.post<TurnResult>(`/assistant/threads/${thread.id}/talk`, { message: body, attachmentIds });
      if (spoken === undefined) setFiles([]);
      if (result.reply !== undefined) {
        setMessages((current) => [...current, {
          id: `reply-${Math.random().toString(36).slice(2)}`,
          thread_id: thread.id, direction: 'out', channel: 'web', body: result.reply!,
          created_at: new Date().toISOString(),
        }]);
      }
      return result.reply;
    } catch (err) {
      // A refusal is not a reply. The server answers 503 with the reason when
      // no model is configured, over its cap, or Local-only blocks it; that
      // sentence is shown as itself rather than dressed up as something Josi
      // said.
      const refusal = err instanceof ApiError ? (err.body as TurnResult | null)?.refusal : null;
      const message = refusal?.message ?? (err instanceof ApiError ? err.message : 'Josi could not answer');
      // A refusal (503 with a reason) RECORDED the inbound message server-side.
      // Removing the bubble here made the client disagree with the database,
      // and the next load showed an unexplained duplicate. Keep what was truly
      // recorded; only a transport failure (nothing stored) takes the bubble back.
      if (!refusal) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        if (spoken === undefined) setInput(body);
      }
      setError(message);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  return (
    <div
      // The chat sizes itself with plain 100dvh and lives in normal flow: a
      // flex column of header / scrolling list / composer. When the iOS
      // keyboard opens, Safari pans the visual viewport to keep the focused
      // composer visible — native behaviour, no JS. The previous release drove
      // this height from a VisualViewport handler and the composer ended up
      // rendered at the TOP of the screen with the history invisible (round-2
      // item 25). data-viewport-managed opts out of the global focus helper.
      data-viewport-managed
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_20%,hsl(var(--secondary)/0.18),transparent_52%)] lg:rounded-2xl lg:border lg:border-border lg:bg-card"
      style={{ height: '100%' }}
    >
      <section ref={transcript} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
        {loading ? <p className="text-sm text-muted-foreground">Opening…</p> : null}
        {!loading && messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-sm text-center">
            <h2 className="text-lg font-semibold">What are we doing?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask Josi to remember something, plan it, or start a task.
            </p>
          </div>
        ) : null}
        {messages.map((message, index) => {
          const mine = message.direction === 'in';
          const at = new Date(message.created_at);
          const prev = index > 0 ? new Date(messages[index - 1].created_at) : null;
          const newDay = !prev || prev.toDateString() !== at.toDateString();
          return (
            <Fragment key={message.id}>
              {newDay ? (
                <div className="flex justify-center">
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    {dayLabel(at)}
                  </span>
                </div>
              ) : null}
              <div className={`flex items-start gap-3 ${mine ? 'justify-end' : 'justify-start'}`}>
                {!mine ? <img src="/brand/josi-mark.png" alt="" width={40} height={40} className="mt-1 h-10 w-10 shrink-0 rounded-full" /> : null}
                <div className={`flex max-w-[82%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div className={`whitespace-pre-wrap break-words rounded-[1.65rem] px-4 py-3 text-base leading-6 ${mine ? 'rounded-br-lg bg-primary text-primary-foreground' : 'rounded-bl-lg bg-secondary text-secondary-foreground'}`}>
                  {message.meta?.attachments?.length ? (
                    <div className="mb-1 space-y-1 text-xs opacity-80">
                      {message.meta.attachments.map((attachment) => attachment.contentType.startsWith('image/') ? (
                        <a key={attachment.id} href={`/api/assistant/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                          <img src={`/api/assistant/attachments/${attachment.id}`} alt={attachment.filename}
                               className="max-h-64 max-w-full rounded-lg object-contain" />
                        </a>
                      ) : (
                        <a key={attachment.id} className="block underline" href={`/api/assistant/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                          📎 {attachment.filename}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  {message.body}
                </div>
                <span className="mt-1.5 px-2 text-xs text-muted-foreground">{at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{mine ? <span className="ml-2 text-primary" aria-label="Sent">✓✓</span> : null}</span>
                </div>
              </div>
            </Fragment>
          );
        })}
        {sending ? <p className="text-sm text-muted-foreground">Josi is working…</p> : null}
        <div ref={end} />
      </section>

      <footer className="w-full min-w-0 max-w-full shrink-0 overflow-x-clip px-2 pb-3 pt-14 sm:px-4">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <form
          onSubmit={(event) => { event.preventDefault(); void send(); }}
          className="talk-composer flex min-h-14 w-full min-w-0 max-w-full items-center gap-0.5 overflow-hidden rounded-[1.75rem] border border-border bg-secondary/25 p-1.5 shadow-lg backdrop-blur"
        >
          <label className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80" aria-label="Attach pictures or files">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <input type="file" multiple className="sr-only" accept="image/*,.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv" onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 10))} />
          </label>
          <span aria-hidden className="mx-1 h-8 w-px shrink-0 bg-border" />
          <textarea
            ref={inputElement}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            rows={1}
            maxLength={8000}
            enterKeyHint="send"
            placeholder="Message Josi…"
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            aria-label="Message Josi"
          />
          <VoiceChat onTurn={send} disabled={sending || loading || !thread} onActiveChange={setVoiceActive} />
          <button type="submit" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={sending || voiceActive} aria-label="Send message">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 -rotate-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </button>
        </form>
        {files.length ? <p className="mt-1 truncate text-xs text-muted-foreground">Attached: {files.map((file) => file.name).join(', ')}</p> : null}
      </footer>
    </div>
  );
}
