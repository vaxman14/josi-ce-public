// Linking your Telegram to Josi.
//
// The screen has one job and it is a security job: make it obvious what
// linking DOES, show the code exactly once, and make unlinking a single
// unambiguous button rather than something buried.
//
// The code is deliberately never re-fetchable. It exists in this component's
// state after the request that minted it and nowhere else — the server has
// only a hash. Reloading the page loses it, which is correct: a code you can
// come back to is a code somebody else can come back to.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, NotYet } from '@/components/ui';

interface TelegramLink {
  id: string;
  chatId: string;
  telegramUsername: string | null;
  status: 'active' | 'revoked';
  linkedAt: string;
  revokedAt: string | null;
  lastInboundAt: string | null;
}

interface TelegramStatus {
  channel: {
    enabled: boolean;
    configured: boolean;
    botUsername: string | null;
    attachmentsEnabled: boolean;
  };
  links: TelegramLink[];
}

interface MintedCode {
  code: string;
  deepLink: string | null;
  expiresAt: string;
}

export function Telegram() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<TelegramStatus>('/telegram'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Telegram settings');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mint() {
    setError('');
    setBusy(true);
    try {
      setMinted(await api.post<MintedCode>('/telegram/link-code'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a link code');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(id: string) {
    setError('');
    setBusy(true);
    try {
      await api.del(`/telegram/links/${id}`);
      setMinted(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink that chat');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Telegram</h1>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    );
  }

  const active = status.links.filter((l) => l.status === 'active');

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Telegram</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!status.channel.enabled ? (
        <NotYet title="Telegram is not turned on">
          Your administrator has not set up a Telegram bot for this installation yet. Once they do,
          you will be able to link your own Telegram account here.
        </NotYet>
      ) : (
        <>
          <Card>
            <CardTitle>What linking does</CardTitle>
            <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
              <li>You can message Josi from Telegram and get answers there.</li>
              <li>
                Those messages become one of your own conversations, private to you, exactly like
                the ones you have here.
              </li>
              <li>
                Your administrator can see that a link exists and can remove it. They cannot read
                anything you send.
              </li>
              <li>
                {status.channel.attachmentsEnabled
                  ? 'Files you send are accepted, within the limits your administrator set.'
                  : 'Files are not accepted over Telegram on this installation.'}
              </li>
            </ul>
          </Card>

          {active.length === 0 ? (
            <Card>
              <CardTitle>Link your Telegram</CardTitle>
              <p className="mb-3 text-sm text-muted-foreground">
                Josi will give you a one-time link that opens Telegram. It works once and expires
                after 15 minutes.
              </p>
              <Button onClick={() => void mint()} disabled={busy}>
                {busy ? 'Working…' : 'Create a link'}
              </Button>

              {minted ? (
                <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-sm font-medium">Open this on the device with Telegram:</p>
                  {minted.deepLink ? (
                    <p className="mt-2 break-all text-sm">
                      <a
                        className="underline"
                        href={minted.deepLink}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {minted.deepLink}
                      </a>
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm text-muted-foreground">
                    Or send <code className="rounded bg-background px-1">/start {minted.code}</code>
                    {status.channel.botUsername ? ` to @${status.channel.botUsername}` : ' to the bot'}.
                  </p>
                  {/* Said plainly, because the alternative is somebody closing
                      the tab and filing a support ticket. */}
                  <p className="mt-2 text-xs text-muted-foreground">
                    This is shown once. If you lose it, create another — the old one stops working.
                  </p>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <CardTitle>Linked chats</CardTitle>
            {status.links.length === 0 ? (
              <Empty title="Nothing linked yet" />
            ) : (
              <ul className="space-y-3">
                {status.links.map((link) => (
                  <li
                    key={link.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {link.telegramUsername ? `@${link.telegramUsername}` : `Chat ${link.chatId}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {link.status === 'active'
                          ? `Linked ${new Date(link.linkedAt).toLocaleDateString()}`
                          : `Unlinked ${link.revokedAt ? new Date(link.revokedAt).toLocaleDateString() : ''}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={link.status === 'active' ? 'ok' : 'muted'}>
                        {link.status === 'active' ? 'Active' : 'Unlinked'}
                      </Badge>
                      {link.status === 'active' ? (
                        <Button
                          variant="secondary"
                          onClick={() => void unlink(link.id)}
                          disabled={busy}
                        >
                          Unlink
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
