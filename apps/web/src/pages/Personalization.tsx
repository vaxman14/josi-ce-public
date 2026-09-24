// Soul, About me, Working style, and Memory.
//
// The screen has one job beyond editing text: it must never let somebody
// believe a line worked when it did not. So every save shows what was ignored
// and why, and anything that reads like an instruction about permissions is
// called out explicitly — not refused, because it is their file, but named, so
// they know it changed nothing.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote } from '@/components/ui';

type Layer = 'soul' | 'user' | 'agents_user' | 'agents_admin';

interface Explanation { can: string[]; cannot: string[] }
interface IgnoredItem { field: string; reason: string; explanation: string }
interface AuthorityAttempt { field: string; phrase: string; line: string }

interface ProfileState {
  content: string;
  parsed: Record<string, unknown>;
  ignored: IgnoredItem[];
  version: number;
  readOnly?: boolean;
  explanation: Explanation;
}

interface Version { version: number; created_at: string; bytes: number }
interface Preset { key: string; name: string; describes: string; content: string }

interface Memory {
  id: string;
  content: string;
  provenance: string;
  confidence: number;
  pinned: boolean;
  confirmed_at: string | null;
}

const TABS: Array<{ key: Layer; label: string; blurb: string }> = [
  { key: 'soul', label: 'Soul', blurb: 'Who your assistant is to you.' },
  { key: 'user', label: 'About me', blurb: 'What it should know about you.' },
  { key: 'agents_user', label: 'Working style', blurb: 'How it should behave.' },
];

export function Personalization() {
  const [schema, setSchema] = useState<{ boundary: string } | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileState>>({});
  const [effective, setEffective] = useState<Record<string, unknown>>({});
  const [narrowed, setNarrowed] = useState<string[]>([]);
  const [tab, setTab] = useState<Layer>('soul');
  const [draft, setDraft] = useState('');
  const [ignored, setIgnored] = useState<IgnoredItem[]>([]);
  const [attempts, setAttempts] = useState<AuthorityAttempt[]>([]);
  const [notice, setNotice] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [onboarding, setOnboarding] = useState<{ needed: boolean; note: string } | null>(null);
  const [preview, setPreview] = useState<{ reply?: string; reason?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    void api.get<{ boundary: string }>('/persona/schema').then(setSchema).catch(() => undefined);
    void api.get<{ presets: Preset[] }>('/persona/presets')
      .then((r) => setPresets(r.presets)).catch(() => undefined);
    void api.get<{ needed: boolean; note: string }>('/persona/onboarding')
      .then(setOnboarding).catch(() => undefined);
    void reload();
    void reloadMemories();
  }, []);

  useEffect(() => {
    setDraft(profiles[tab]?.content ?? '');
    setIgnored(profiles[tab]?.ignored ?? []);
    setAttempts([]);
    setNotice('');
    setSaved(false);
    setPreview(null);
    void api.get<{ versions: Version[] }>(`/persona/profiles/${tab}/versions`)
      .then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  }, [tab, profiles]);

  async function reload() {
    try {
      const r = await api.get<{
        profiles: Record<string, ProfileState>;
        effectivePolicy: Record<string, unknown>;
        narrowedByPolicy: string[];
      }>('/persona/profiles');
      setProfiles(r.profiles);
      setEffective(r.effectivePolicy);
      setNarrowed(r.narrowedByPolicy ?? []);
    } catch {
      setError('Could not load your settings.');
    }
  }

  async function reloadMemories() {
    try {
      const r = await api.get<{ memories: Memory[] }>('/persona/memories');
      setMemories(r.memories);
    } catch { /* an empty list is a fine starting point */ }
  }

  async function save() {
    setError('');
    setSaved(false);
    try {
      const r = await api.put<{
        ignored: IgnoredItem[]; authorityAttempts: AuthorityAttempt[]; notice?: string;
      }>(`/persona/profiles/${tab}`, { content: draft });
      setIgnored(r.ignored ?? []);
      setAttempts(r.authorityAttempts ?? []);
      setNotice(r.notice ?? '');
      setSaved(true);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    }
  }

  async function addMemory() {
    const content = newMemory.trim();
    if (!content) return;
    setError('');
    try {
      await api.post('/persona/memories', { content });
      setNewMemory('');
      await reloadMemories();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that memory.');
    }
  }

  async function removeMemory(id: string) {
    await api.del(`/persona/memories/${id}`).catch(() => undefined);
    await reloadMemories();
  }

  async function togglePin(m: Memory) {
    await api.put(`/persona/memories/${m.id}`, { pinned: !m.pinned }).catch(() => undefined);
    await reloadMemories();
  }

  async function runPreview() {
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await api.post<{ available: boolean; reply?: string; reason?: string }>(
        '/persona/preview/live', {},
      );
      setPreview(r.available ? { reply: r.reply } : { reason: r.reason });
    } catch (e) {
      setPreview({ reason: e instanceof Error ? e.message : 'Preview unavailable.' });
    } finally {
      setPreviewing(false);
    }
  }

  async function applyPreset(preset: Preset) {
    setDraft(preset.content);
    setTab('soul');
  }

  async function restoreVersion(version: number) {
    setError('');
    try {
      await api.post(`/persona/profiles/${tab}/reset`, { toVersion: version });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore that version.');
    }
  }

  async function finishOnboarding(skip: boolean, presetKey?: string) {
    await api.post('/persona/onboarding', { skip, preset: presetKey }).catch(() => undefined);
    setOnboarding({ needed: false, note: '' });
    await reload();
  }

  const current = profiles[tab];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4">
      <div>
        <h1 className="text-xl font-semibold">Personalization</h1>
        {schema && (
          // The one sentence somebody most needs before they start typing.
          <p className="mt-2 text-sm text-muted-foreground">{schema.boundary}</p>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>

      {onboarding?.needed && (
        <Card>
          <CardTitle>Set up your assistant</CardTitle>
          <p className="text-sm text-muted-foreground">{onboarding.note}</p>
          <div className="mt-3 space-y-2">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className="block w-full rounded-md border p-3 text-left hover:bg-accent min-h-11"
                onClick={() => void finishOnboarding(false, p.key)}
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{p.describes}</span>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <Button variant="secondary" className="min-h-11" onClick={() => void finishOnboarding(true)}>
              Skip — use the default
            </Button>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? 'primary' : 'secondary'}
            className="min-h-11"
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardTitle>{TABS.find((t) => t.key === tab)?.label}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {TABS.find((t) => t.key === tab)?.blurb}
        </p>

        {current?.explanation && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">This can</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {current.explanation.can.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-medium">This cannot</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {current.explanation.cannot.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            </div>
          </div>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="profile-editor">
          Your {TABS.find((t) => t.key === tab)?.label.toLowerCase()} file
        </label>
        <textarea
          id="profile-editor"
          className="mt-1 h-64 w-full rounded-md border bg-background p-3 font-mono text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tab === 'soul'
            ? 'assistant_name: Josi\ntone: brief\nhumour: dry'
            : tab === 'user'
              ? 'preferred_name: Alex\nrole: Operations lead\nworking_style: Short answers first.'
              : 'proactivity: ask_first\nformatting: bullets'}
        />

        <div className="mt-3 flex items-center gap-3">
          <Button className="min-h-11" onClick={() => void save()}>Save</Button>
          {saved && <Badge>Saved</Badge>}
          {current?.version ? (
            <span className="text-sm text-muted-foreground">Version {current.version}</span>
          ) : null}
        </div>

        {tab === 'soul' && presets.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium">Start from a preset</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {presets.map((p) => (
                <Button
                  key={p.key}
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => void applyPreset(p)}
                  title={p.describes}
                >
                  {p.name}
                </Button>
              ))}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              A preset fills in the file below. Edit it afterwards, or write your own.
            </p>
          </div>
        )}

        <div className="mt-4">
          <Button variant="secondary" className="min-h-11" onClick={() => void runPreview()}>
            {previewing ? 'Asking…' : 'Hear how it sounds'}
          </Button>
          {preview?.reply && (
            <div className="mt-2 rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">Josi would say:</span>
              <p className="mt-1">{preview.reply}</p>
            </div>
          )}
          {preview?.reason && (
            <p className="mt-2 text-sm text-muted-foreground">{preview.reason}</p>
          )}
        </div>

        {versions.length > 0 && (
          <div className="mt-4 text-sm">
            <h3 className="font-medium">Earlier versions</h3>
            <ul className="mt-1 space-y-1">
              {versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    Version {v.version} · {new Date(v.created_at).toLocaleString()} · {v.bytes} bytes
                  </span>
                  <Button
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => void restoreVersion(v.version)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {notice && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {notice}
          </div>
        )}

        {attempts.length > 0 && (
          <div className="mt-3 text-sm">
            <h3 className="font-medium">Lines that read like instructions</h3>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {attempts.map((a, i) => (
                <li key={`${a.phrase}-${i}`}>· “{a.phrase}” — kept as personality, changed nothing.</li>
              ))}
            </ul>
          </div>
        )}

        {ignored.length > 0 && (
          <div className="mt-3 text-sm">
            <h3 className="font-medium">Lines that did nothing</h3>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {ignored.map((i, n) => (
                <li key={`${i.field}-${n}`}>· <code>{i.field}</code> — {i.explanation}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {tab === 'agents_user' && (
        <CollapsibleCard title="What is actually in force" summary="Your choices after administrator policy is applied">
          <p className="text-sm text-muted-foreground">
            Your choices, after your administrator&rsquo;s policy is applied.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {Object.entries(effective).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {String(v)}
                {narrowed.includes(k) && (
                  <span className="ml-2 text-amber-600">
                    — your administrator requires this
                  </span>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleCard>
      )}

      <CollapsibleCard title="Memory" summary={`${memories.length} saved ${memories.length === 1 ? 'item' : 'items'}`}>
        <p className="text-sm text-muted-foreground">
          Things Josi keeps about you. Deleting one deletes it — it is not hidden.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            className="min-h-11 flex-1 rounded-md border bg-background px-3 text-sm"
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
            placeholder="Something Josi should remember"
            aria-label="New memory"
          />
          <Button className="min-h-11" onClick={() => void addMemory()}>Add</Button>
        </div>

        <ul className="mt-4 space-y-2">
          {memories.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm">{m.content}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.provenance}
                  {m.confidence < 1 && ` · confidence ${Math.round(m.confidence * 100)}%`}
                  {m.confirmed_at ? ' · confirmed' : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" className="min-h-11" onClick={() => void togglePin(m)}>
                  {m.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button variant="secondary" className="min-h-11" onClick={() => void removeMemory(m.id)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
          {memories.length === 0 && (
            <li className="text-sm text-muted-foreground">Nothing yet.</li>
          )}
        </ul>
      </CollapsibleCard>
    </div>
  );
}
