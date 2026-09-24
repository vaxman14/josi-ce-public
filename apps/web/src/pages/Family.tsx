// Family — Parental Controls as the two people in it see it.
//
// ONE PAGE, TWO READINGS, and the server decides which. A parent sees the
// children they look after; a child sees what is being looked at. Neither
// reading is hidden from the other: the child's half of this page is written to
// be shown to them, not to be a settings screen they are not supposed to find.
//
// The tone is deliberate. Everything here is about somebody's household, so the
// page says what is true in the plainest words available — what an adult can
// see, what they cannot, what a limit actually measures, and what happens if
// the licence lapses. A control page that overstates what it controls is worse
// than no control page: it is a parent believing a phone is limited when it is
// not.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Copyable, Empty, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface Honesty { scope: string; notDevice: string; minutes: string; admin: string }
interface Window { weekday: number; startMinute: number; endMinute: number }
interface Controls {
  timezone: string;
  dailyLimitMinutes: number | null;
  scheduleEnabled: boolean;
  windows: Window[];
}
interface Access { allowed: boolean; reason: string; message?: string | null; opensAgain?: string | null }
interface Child {
  childUserId: string;
  username: string;
  displayName: string | null;
  since: string;
  controls: Controls | null;
  usedMinutesToday: number;
  access: Access;
}
interface Overview {
  role: 'parent' | 'child' | 'none';
  honesty: Honesty;
  secondFactorReady?: boolean;
  maxChildren?: number;
  children?: Child[];
  child?: {
    guardian: string;
    since: string;
    controls: Controls | null;
    usedMinutesToday: number;
    access: Access;
    canSee: string[];
    cannotSee: string[];
    activity: Array<{ kind: string; at: string }>;
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minutesOf = (value: string): number => {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function Family() {
  return <FamilyComingSoon />;
}

function FamilyComingSoon() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4" aria-disabled="true">
      <h1 className="text-xl font-semibold tracking-tight">Family <Badge tone="muted">Coming Soon</Badge></h1>
      <Card className="opacity-75">
        <CardTitle>Parental Controls are being redesigned</CardTitle>
        <p className="text-sm text-muted-foreground">No supervision, schedules, limits, monitoring, or child-safety enforcement are active here today.</p>
        <p className="mt-2 text-sm text-muted-foreground">The future feature is intended to let parents or guardians create and manage child profiles, set age-appropriate access rules and schedules, review relevant Josi activity, and receive useful usage and safety information while keeping parental authority separate from ordinary administration.</p>
        <p className="mt-2 text-sm text-muted-foreground">Suggest features at <a className="underline" href="mailto:roman@socalreceptionist.com">roman@socalreceptionist.com</a>.</p>
      </Card>
    </div>
  );
}

function FamilyImplementation() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [absent, setAbsent] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setOverview(await api.get<Overview>('/parental/overview'));
      setAbsent(false);
    } catch (err) {
      // 404 is the honest answer on an installation that has not bought the
      // module, and it is what the nav uses to hide this page. Somebody who
      // typed the URL gets a sentence rather than a broken screen.
      if (err instanceof ApiError && err.status === 404) setAbsent(true);
      else setError(err instanceof Error ? err.message : 'Could not load this page');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (absent) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Family <Badge tone="danger">BETA</Badge></h1>
        <BetaWarning />
        <Empty title="Parental Controls is not part of this installation">
          It is a paid module. Until somebody activates a licence for it, nothing here exists:
          no account is managed, no conversation is visible to anybody else, and no timetable
          applies. Whoever administers this installation can add it.
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Family <Badge tone="danger">BETA</Badge></h1>
      <BetaWarning />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!overview ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {overview?.role === 'child' && overview.child
        ? <ChildView child={overview.child} honesty={overview.honesty} />
        : null}
      {overview && overview.role !== 'child'
        ? <ParentView overview={overview} reload={load} />
        : null}
    </div>
  );
}

function BetaWarning() {
  return (
    <div role="alert" className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
      <p className="font-semibold text-amber-200">BETA — do not rely on these controls for a child&rsquo;s safety.</p>
      <p className="mt-1 text-amber-100/90">
        This feature is experimental and may fail, be delayed, or behave unexpectedly. It controls only access to Josi;
        it cannot supervise a device, block other apps or websites, provide emergency monitoring, or replace active adult supervision
        and device-level parental controls. Verify important restrictions yourself.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ the child

function ChildView({ child, honesty }: { child: NonNullable<Overview['child']>; honesty: Honesty }) {
  return (
    <>
      <Card>
        <CardTitle>{child.guardian} looks after this account</CardTitle>
        <p className="text-sm text-muted-foreground">
          This is not hidden from you, and it is not meant to be. Here is exactly what that
          means, so you are never guessing.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-sm font-semibold">They can</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {child.canSee.map((line) => <li key={line}>• {line}</li>)}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold">They cannot</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {child.cannotSee.map((line) => <li key={line}>• {line}</li>)}
            </ul>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Right now</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={child.access.allowed ? 'ok' : 'danger'}>
            {plain('child_access', child.access.reason)}
          </Badge>
          {child.access.opensAgain ? <Badge tone="muted">Back at {child.access.opensAgain}</Badge> : null}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {plainDetail('child_access', child.access.reason) ?? honesty.minutes}
        </p>
        <p className="mt-2 text-sm">
          Used today: <strong>{child.usedMinutesToday}</strong> minute{child.usedMinutesToday === 1 ? '' : 's'}
          {child.controls?.dailyLimitMinutes
            ? <> of {child.controls.dailyLimitMinutes}</>
            : <> — no daily limit is set</>}
        </p>
        {child.controls?.scheduleEnabled ? <Timetable windows={child.controls.windows} /> : null}
      </Card>

      <Card>
        <CardTitle>When they looked</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Every time {child.guardian} opened one of your conversations, or changed your hours, it
          is written down here. Supervision you can see is different from being watched.
        </p>
        {child.activity.length ? (
          <ul className="space-y-1 text-sm">
            {child.activity.map((entry, i) => (
              <li key={`${entry.kind}-${entry.at}-${i}`} className="flex flex-wrap justify-between gap-2 border-t border-border pt-1 first:border-0">
                <span>{describeAccess(entry.kind)}</span>
                <span className="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nothing yet.</p>}
      </Card>

      <HonestyCard honesty={honesty} />
    </>
  );
}

function describeAccess(kind: string): string {
  switch (kind) {
    case 'parental.conversation_read': return 'Read one of your conversations';
    case 'parental.conversations_listed': return 'Looked at the list of your conversations';
    case 'parental.usage_viewed': return 'Looked at how much you have used Josi';
    case 'parental.controls_updated': return 'Changed your hours or your daily limit';
    case 'parental.link_created': return 'Set this account up';
    case 'parental.link_ended': return 'Stopped looking after this account';
    default: return kind;
  }
}

// ----------------------------------------------------------------- the parent

function ParentView({ overview, reload }: { overview: Overview; reload: () => Promise<void> }) {
  const children = overview.children ?? [];
  return (
    <>
      <HonestyCard honesty={overview.honesty} />
      {!children.length ? (
        <Empty title="You are not looking after any accounts">
          Adding a child creates a new account here and links it to yours. They are told, on
          their own Family page, exactly what you can see.
        </Empty>
      ) : null}
      {children.map((child) => (
        <ChildCard key={child.childUserId} child={child} reload={reload} />
      ))}
      <AddChild
        secondFactorReady={!!overview.secondFactorReady}
        atCeiling={children.length >= (overview.maxChildren ?? 0)}
        reload={reload}
      />
    </>
  );
}

function HonestyCard({ honesty }: { honesty: Honesty }) {
  return (
    <Card>
      <CardTitle>What this does, and what it does not</CardTitle>
      <p className="text-sm text-muted-foreground">{honesty.scope}</p>
      <p className="mt-2 text-sm text-muted-foreground">{honesty.notDevice}</p>
      <p className="mt-2 text-sm text-muted-foreground">{honesty.minutes}</p>
      <p className="mt-2 text-sm text-muted-foreground">{honesty.admin}</p>
    </Card>
  );
}

/** Password and code together, which is what the server asks for before a
 * relationship is created or ended. Deliberately not two steps: a form that
 * accepts the password first leaves a session half way through. */
function AuthorityPrompt({
  label, busyLabel, onProved,
}: { label: string; busyLabel: string; onProved: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/parental/authority', { password, code });
      await onProved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false); setPassword(''); setCode('');
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">
        Changing who looks after whom needs your password <em>and</em> a code from your
        authenticator, together. A signed-in browser on its own is not enough.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm" htmlFor="parental-password">Your password</label>
          <Input id="parental-password" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-sm" htmlFor="parental-code">Six-digit code</label>
          <Input id="parental-code" inputMode="numeric" autoComplete="one-time-code"
            value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
      </div>
      <Button type="submit" disabled={busy}>{busy ? busyLabel : label}</Button>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </form>
  );
}

function AddChild({
  secondFactorReady, atCeiling, reload,
}: { secondFactorReady: boolean; atCeiling: boolean; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');

  async function create() {
    setError('');
    try {
      const created = await api.post<{ inviteLink: string }>('/parental/children', {
        username, email, displayName,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setInvite(created.inviteLink);
      setUsername(''); setEmail(''); setDisplayName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    }
  }

  if (atCeiling) {
    return (
      <Card>
        <CardTitle>Add a child</CardTitle>
        <p className="text-sm text-muted-foreground">
          You are looking after as many accounts as one account may. Ending a relationship frees
          a place.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Add a child</CardTitle>
      <p className="text-sm text-muted-foreground">
        This creates a <strong>new</strong> account and links it to yours. There is deliberately
        no way to take over an account that already exists here — somebody else&rsquo;s account
        cannot become a managed one without them being asked.
      </p>
      {!secondFactorReady ? (
        <p className="mt-3 text-sm">
          First, turn on two-factor authentication for your own account, under Settings. Looking
          after somebody else&rsquo;s conversations should cost more than one secret.
        </p>
      ) : !open ? (
        <Button className="mt-3" onClick={() => setOpen(true)}>Add a child</Button>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm" htmlFor="child-username">Username</label>
              <Input id="child-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm" htmlFor="child-email">Email address</label>
              <Input id="child-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm" htmlFor="child-name">What to call them</label>
              <Input id="child-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
          </div>
          <AuthorityPrompt label="Confirm and create the account" busyLabel="Checking…" onProved={create} />
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      )}
      {invite ? (
        <div className="mt-4">
          <Copyable label="Set-up link — open this on their device" value={invite} />
          <p className="text-sm text-muted-foreground">
            The link sets their password once and then stops working. Their Family page will show
            them what you can see.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function ChildCard({ child, reload }: { child: Child; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<'controls' | 'conversations' | 'usage' | 'end'>('controls');
  const label = child.displayName || child.username;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>{label}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {child.username} · looked after since {new Date(child.since).toLocaleDateString()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={child.access.allowed ? 'ok' : 'danger'}>{plain('child_access', child.access.reason)}</Badge>
          <Badge tone="muted">
            {child.usedMinutesToday} min today
            {child.controls?.dailyLimitMinutes ? ` of ${child.controls.dailyLimitMinutes}` : ''}
          </Badge>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {([
          ['controls', 'Hours and limit'],
          ['conversations', 'Conversations'],
          ['usage', 'How much'],
          ['end', 'Stop looking after'],
        ] as const).map(([key, text]) => (
          <Button key={key} variant={tab === key ? 'secondary' : 'ghost'} onClick={() => setTab(key)}>
            {text}
          </Button>
        ))}
      </div>

      {tab === 'controls' ? <ControlsEditor child={child} reload={reload} /> : null}
      {tab === 'conversations' ? <Conversations childUserId={child.childUserId} /> : null}
      {tab === 'usage' ? <UsagePanel childUserId={child.childUserId} /> : null}
      {tab === 'end' ? <EndRelationship child={child} reload={reload} /> : null}
    </Card>
  );
}

function ControlsEditor({ child, reload }: { child: Child; reload: () => Promise<void> }) {
  const [controls, setControls] = useState<Controls>(child.controls ?? {
    timezone: 'UTC', dailyLimitMinutes: null, scheduleEnabled: false, windows: [],
  });
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  async function save() {
    setError(''); setNote('');
    try {
      await api.put(`/parental/children/${child.childUserId}/controls`, {
        timezone: controls.timezone,
        dailyLimitMinutes: controls.dailyLimitMinutes,
        scheduleEnabled: controls.scheduleEnabled,
        windows: controls.windows,
      });
      setNeedsPassword(false);
      setNote('Saved. It applies to their next message.');
      await reload();
    } catch (err) {
      // The server asks for the password again for exactly this change — the
      // threat is somebody using the parent's own open laptop.
      if (err instanceof ApiError && err.status === 401) {
        setNeedsPassword(true);
        setError(err.message);
      } else setError(err instanceof Error ? err.message : 'That did not save');
    }
  }

  async function confirmPassword(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.post('/assistant/step-up', { password });
      setPassword('');
      await save();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That password did not match');
    }
  }

  const setWindow = (weekday: number, patch: Partial<Window> | null) => {
    setControls((current) => {
      const rest = current.windows.filter((w) => w.weekday !== weekday);
      if (patch === null) return { ...current, windows: rest };
      const existing = current.windows.find((w) => w.weekday === weekday)
        ?? { weekday, startMinute: 16 * 60, endMinute: 19 * 60 };
      return { ...current, windows: [...rest, { ...existing, ...patch }].sort((a, b) => a.weekday - b.weekday) };
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm" htmlFor={`tz-${child.childUserId}`}>Their timezone</label>
          <Input id={`tz-${child.childUserId}`} value={controls.timezone}
            onChange={(e) => setControls({ ...controls, timezone: e.target.value })} />
          <p className="mt-1 text-xs text-muted-foreground">
            The day is cut here, not where the server is.
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm" htmlFor={`limit-${child.childUserId}`}>
            Minutes a day (blank for no limit)
          </label>
          <Input id={`limit-${child.childUserId}`} inputMode="numeric"
            value={controls.dailyLimitMinutes === null ? '' : String(controls.dailyLimitMinutes)}
            onChange={(e) => setControls({
              ...controls,
              dailyLimitMinutes: e.target.value.trim() === '' ? null : Number(e.target.value),
            })} />
          <p className="mt-1 text-xs text-muted-foreground">
            Counted as minutes in which they sent something to Josi.
          </p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={controls.scheduleEnabled}
          onChange={(e) => setControls({ ...controls, scheduleEnabled: e.target.checked })} />
        Only answer during set hours
      </label>
      {controls.scheduleEnabled ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            A day with no hours is a day Josi does not answer. For a stretch that runs past
            midnight, set hours on both days.
          </p>
          {DAYS.map((name, weekday) => {
            const window = controls.windows.find((w) => w.weekday === weekday);
            return (
              <div key={name} className="flex flex-wrap items-center gap-2">
                <label className="flex w-32 items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={!!window}
                    onChange={(e) => setWindow(weekday, e.target.checked ? {} : null)} />
                  {name}
                </label>
                {window ? (
                  <>
                    <Input aria-label={`${name} from`} type="time" className="w-32"
                      value={clock(window.startMinute)}
                      onChange={(e) => setWindow(weekday, { startMinute: minutesOf(e.target.value) })} />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input aria-label={`${name} until`} type="time" className="w-32"
                      value={clock(window.endMinute % 1440)}
                      onChange={(e) => setWindow(weekday, { endMinute: minutesOf(e.target.value) || 1440 })} />
                  </>
                ) : <span className="text-sm text-muted-foreground">Josi does not answer</span>}
              </div>
            );
          })}
        </div>
      ) : null}

      <Button onClick={() => void save()}>Save</Button>
      {needsPassword ? (
        <form onSubmit={confirmPassword} className="space-y-2 rounded-md border border-border p-3">
          <label className="block text-sm" htmlFor={`pw-${child.childUserId}`}>
            Confirm your password to change this
          </label>
          <Input id={`pw-${child.childUserId}`} type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit">Confirm and save</Button>
        </form>
      ) : null}
      {note ? <p className="text-sm text-emerald-400">{note}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function Timetable({ windows }: { windows: Window[] }) {
  if (!windows.length) {
    return <p className="mt-2 text-sm text-muted-foreground">No hours are set, so Josi does not answer.</p>;
  }
  return (
    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
      {windows.map((w) => (
        <li key={`${w.weekday}-${w.startMinute}`}>
          {DAYS[w.weekday]}: {clock(w.startMinute)} to {clock(w.endMinute % 1440)}
        </li>
      ))}
    </ul>
  );
}

function Conversations({ childUserId }: { childUserId: string }) {
  const [list, setList] = useState<Array<{ id: string; title: string | null; lastActivityAt: string; messages: number }> | null>(null);
  const [open, setOpen] = useState<{ id: string; messages: Array<{ id: string; direction: string; body: string; createdAt: string }> } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ conversations: typeof list }>(`/parental/children/${childUserId}/conversations`)
      .then((res) => setList(res.conversations))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [childUserId]);

  async function read(id: string) {
    setError('');
    try {
      const res = await api.get<{ messages: NonNullable<typeof open>['messages'] }>(
        `/parental/children/${childUserId}/conversations/${id}`,
      );
      setOpen({ id, messages: res.messages });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that');
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Opening a conversation is written down, and they can see it on their own Family page.
        That is the deal this feature makes with both of you.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!list ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {list && !list.length ? <p className="text-sm text-muted-foreground">Nothing here yet.</p> : null}
      <ul className="space-y-1">
        {(list ?? []).map((conversation) => (
          <li key={conversation.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-0">
            <span className="min-w-0 break-words text-sm">
              {conversation.title || 'Untitled conversation'}
              <span className="text-muted-foreground"> · {conversation.messages} messages · {new Date(conversation.lastActivityAt).toLocaleString()}</span>
            </span>
            <Button variant="ghost" onClick={() => void read(conversation.id)}>Read</Button>
          </li>
        ))}
      </ul>
      {open ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          {open.messages.map((message) => (
            <p key={message.id} className="text-sm">
              <span className="text-muted-foreground">
                {message.direction === 'in' ? 'Them' : 'Josi'} · {new Date(message.createdAt).toLocaleString()}
              </span>
              <br />
              {message.body}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UsagePanel({ childUserId }: { childUserId: string }) {
  const [usage, setUsage] = useState<{
    days: Array<{ day: string; minutes: number }>; totalMinutes: number;
    conversations: number; messagesSent: number; busiestDay: string | null; timezone: string;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ usage: typeof usage }>(`/parental/children/${childUserId}/usage?days=14`)
      .then((res) => setUsage(res.usage))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [childUserId]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!usage) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const busiest = Math.max(1, ...usage.days.map((d) => d.minutes));
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <strong>{usage.totalMinutes}</strong> minutes over the last two weeks, across{' '}
        <strong>{usage.conversations}</strong> conversations and{' '}
        <strong>{usage.messagesSent}</strong> messages sent. Days are counted in {usage.timezone}.
      </p>
      {!usage.days.length ? <p className="text-sm text-muted-foreground">Nothing in this period.</p> : null}
      <ul className="space-y-1">
        {usage.days.map((day) => (
          <li key={day.day} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 text-muted-foreground">{day.day}</span>
            <span className="h-2 rounded bg-primary" style={{ width: `${Math.round((day.minutes / busiest) * 60)}%` }} />
            <span>{day.minutes} min</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EndRelationship({ child, reload }: { child: Child; reload: () => Promise<void> }) {
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  async function end() {
    setError('');
    try {
      const res = await api.del<{ note: string }>(`/parental/children/${child.childUserId}`);
      setDone(res.note);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    }
  }

  if (done) return <p className="text-sm text-emerald-400">{done}</p>;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Their account stays and becomes an ordinary account here. You stop being able to see
        their conversations, and their hours and daily limit are removed. Nothing they wrote is
        deleted, and nothing of theirs is transferred to you.
      </p>
      <AuthorityPrompt label="Confirm and stop looking after" busyLabel="Checking…" onProved={end} />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
