// The administrator's Telegram plumbing.
//
// Everything on this screen is configuration and health. There is nothing here
// that reads a message, and nothing that shows a chat id — an administrator who
// holds the bot token and also knew a colleague's chat id could message that
// colleague's private Telegram as Josi, so the server does not send it and this
// screen has nowhere to put it.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, CollapsibleCard, Empty, ErrorNote, Input } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';

interface AdminTelegramConfig {
  enabled: boolean;
  tokenSet: boolean;
  botUsername: string | null;
  botId: string | null;
  webhookUrl: string | null;
  webhookSetAt: string | null;
  probedAt: string | null;
  probeOk: boolean | null;
  probeError: string | null;
  attachmentsEnabled: boolean;
  maxAttachmentBytes: number;
}

interface AdminLink {
  id: string;
  owner_user_id: string;
  status: string;
  linked_at: string;
  revoked_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

interface Health {
  outbound: { sent: number; failed: number; pending: number };
  inbound: Record<string, number>;
  errors: Array<{ category: string; count: number }>;
}

const PROBE_EXPLANATIONS: Record<string, string> = {
  unauthorized: 'Telegram rejected the token. Check it in BotFather, or generate a new one.',
  network: 'Telegram could not be reached from this server. Check outbound HTTPS.',
  rate_limited: 'Telegram is rate limiting this bot. Wait and test again.',
  malformed: 'Telegram refused the request. This is a bug worth reporting.',
  unknown: 'Telegram returned something unexpected.',
};

export function AdminTelegram() {
  const [config, setConfig] = useState<AdminTelegramConfig | null>(null);
  const [links, setLinks] = useState<AdminLink[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, l, h] = await Promise.all([
        api.get<{ telegram: AdminTelegramConfig }>('/admin/telegram'),
        api.get<{ links: AdminLink[] }>('/admin/telegram/links'),
        api.get<Health>('/admin/telegram/health'),
      ]);
      setConfig(c.telegram);
      setLinks(l.links);
      setHealth(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Telegram settings');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(what: () => Promise<unknown>, ok: string) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await what();
      setNotice(ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Telegram</h1>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Telegram</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="text-sm text-emerald-300">{notice}</p> : null}

      <CollapsibleCard title="Bot" summary={config.botUsername ? `@${config.botUsername}` : 'Bot credentials and status'} status={<Badge tone={config.enabled ? 'ok' : 'muted'}>{config.enabled ? 'On' : 'Off'}</Badge>} defaultOpen={!config.tokenSet}>
        <p className="mb-3 text-sm text-muted-foreground">
          Josi uses your own bot, created in Telegram&apos;s BotFather. Nothing sits between your
          bot and this server — there is no Josi relay and nowhere to configure one.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={config.enabled ? 'ok' : 'muted'}>{config.enabled ? 'On' : 'Off'}</Badge>
          <Badge tone={config.tokenSet ? 'ok' : 'muted'}>
            {config.tokenSet ? 'Token set' : 'No token'}
          </Badge>
          {config.botUsername ? <Badge tone="primary">@{config.botUsername}</Badge> : null}
          {config.probeOk === false ? <Badge tone="danger">Test failed</Badge> : null}
        </div>

        {config.probeOk === false && config.probeError ? (
          <ErrorNote>{PROBE_EXPLANATIONS[config.probeError] ?? PROBE_EXPLANATIONS.unknown}</ErrorNote>
        ) : null}

        <div className="mt-3 space-y-2">
          <label className="block text-sm font-medium" htmlFor="tg-token">
            Bot token from BotFather
          </label>
          <Input
            id="tg-token"
            type="password"
            autoComplete="off"
            placeholder="123456789:AA…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {/* The token is proven against getMe before it is stored, so a bad
              paste fails here rather than at 2am. */}
          <Button
            disabled={busy || !token.trim()}
            onClick={() => void run(async () => {
              await api.post('/admin/telegram/token', { token: token.trim() });
              setToken('');
            }, 'Token saved and tested. Turn the channel on when you are ready.')}
          >
            Save and test
          </Button>
        </div>
      </CollapsibleCard>

      {config.tokenSet ? (
        <CollapsibleCard title="Delivery" summary={config.webhookUrl ? 'Webhook registered' : 'Webhook not registered'}>
          <p className="mb-3 text-sm text-muted-foreground">
            Telegram delivers messages to this installation over HTTPS. Register the webhook after
            your public address is working; re-register it if the address changes.
          </p>
          <p className="mb-3 break-all text-sm">
            {config.webhookUrl
              ? <>Registered: <code>{config.webhookUrl}</code></>
              : 'Not registered yet.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => api.post('/admin/telegram/probe'), 'Tested.')}
            >
              Test the token
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => api.post('/admin/telegram/webhook'), 'Webhook registered.')}
            >
              Register the webhook
            </Button>
            <Button
              disabled={busy || config.probeOk !== true}
              onClick={() => void run(
                () => api.post('/admin/telegram/enabled', { enabled: !config.enabled }),
                config.enabled ? 'Telegram is off.' : 'Telegram is on.',
              )}
            >
              {config.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </div>
        </CollapsibleCard>
      ) : null}

      <CollapsibleCard title="Files" summary={config.attachmentsEnabled ? 'Attachments accepted' : 'Attachments refused'}>
        <p className="mb-3 text-sm text-muted-foreground">
          Off by default. Telegram will not serve a file larger than 20 MB whatever you set here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={config.attachmentsEnabled ? 'ok' : 'muted'}>
            {config.attachmentsEnabled ? 'Accepted' : 'Refused'}
          </Badge>
          <span className="text-sm text-muted-foreground">
            Limit {Math.round(config.maxAttachmentBytes / (1024 * 1024) * 10) / 10} MB
          </span>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(
              () => api.post('/admin/telegram/attachments', { enabled: !config.attachmentsEnabled }),
              config.attachmentsEnabled ? 'Files are refused.' : 'Files are accepted.',
            )}
          >
            {config.attachmentsEnabled ? 'Stop accepting files' : 'Accept files'}
          </Button>
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Linked accounts" summary={`${links.length} ${links.length === 1 ? 'account' : 'accounts'}`}>
        <p className="mb-3 text-sm text-muted-foreground">
          You can see that a link exists and remove it. You cannot read anything sent over it, and
          the chat identifier is deliberately not shown here.
        </p>
        {links.length === 0 ? (
          <Empty title="Nobody has linked yet" />
        ) : (
          <ul className="space-y-3">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{link.owner_user_id}</p>
                  <p className="text-xs text-muted-foreground">
                    Linked {new Date(link.linked_at).toLocaleDateString()}
                    {link.last_inbound_at
                      ? ` · last message ${new Date(link.last_inbound_at).toLocaleDateString()}`
                      : ' · no messages yet'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={link.status === 'active' ? 'ok' : 'muted'}>{plain('telegram_link_status', link.status)}</Badge>
                  {link.status === 'active' ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void run(
                        () => api.del(`/admin/telegram/links/${link.id}`), 'Link revoked.',
                      )}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleCard>

      {health ? (
        <CollapsibleCard title="Delivery health" summary="Last 7 days">
          <p className="text-sm text-muted-foreground">
            Sent {health.outbound.sent} · failed {health.outbound.failed} · accepted{' '}
            {health.inbound.accepted ?? 0} · refused {health.inbound.refused ?? 0} · from unlinked
            chats {health.inbound.unlinked ?? 0}
          </p>
          {health.errors.length ? (
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {health.errors.map((e) => (
                <li key={e.category}>{plain('telegram_error', e.category)}: {e.count}</li>
              ))}
            </ul>
          ) : null}
        </CollapsibleCard>
      ) : null}

      <CollapsibleCard title="Remove the bot" summary="Disconnect Telegram from this installation">
        <p className="mb-3 text-sm text-muted-foreground">
          Deletes the stored token and the webhook registration. Existing links stay in place but
          nothing can be delivered until a bot is configured again.
        </p>
        <Button
          variant="secondary"
          disabled={busy || !config.tokenSet}
          onClick={() => void run(() => api.del('/admin/telegram'), 'Bot removed.')}
        >
          Remove
        </Button>
      </CollapsibleCard>
    </div>
  );
}
