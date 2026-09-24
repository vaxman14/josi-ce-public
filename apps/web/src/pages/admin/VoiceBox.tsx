import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fetchVoiceAudio } from '@/lib/voiceAudio';
import { Button, ErrorNote } from '@/components/ui';

interface Settings { voice: string; model: string; threshold: number; silenceMs: number; speed: number; device: 'cpu' | 'cuda' }
interface Status {
  helperAvailable: boolean; healthy: boolean; verified: boolean; releaseAvailable: boolean; gpuAvailable?: boolean;
  phase: string; error?: string; requirements: string[]; settings?: Settings; previous?: unknown;
  apiReady?: boolean; modelsReady?: boolean;
}
export function AdminVoiceBox() {
  const [status, setStatus] = useState<Status>();
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef<{ context?: AudioContext; abort?: AbortController }>({});
  const savedSettings = JSON.stringify(status?.settings);
  useEffect(() => { if (status?.settings) setSettings(status.settings); }, [savedSettings]);
  async function refresh() {
    const value = await api.get<Status>('/admin/voice-box');
    setStatus(value);
    return value;
  }
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const value = await api.get<Status>('/admin/voice-box'); if (alive) { setStatus(value); setSettings((old) => old ?? value.settings); } }
      catch (err) { if (alive) setError((err as Error).message); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(timer); preview.current.abort?.abort(); void preview.current.context?.close(); };
  }, []);
  async function operation(name: string, body = {}) {
    setBusy(true); setError('');
    try { await api.post(`/admin/voice-box/${name}`, body); await refresh(); setRemove(false); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function playPreview() {
    if (previewing) return;
    setPreviewing(true); setError('');
    const context = new AudioContext();
    const abort = new AbortController();
    preview.current = { context, abort };
    try {
      await context.resume();
      const data = await fetchVoiceAudio('/admin/voice-box/preview', {}, abort.signal);
      const buffer = await context.decodeAudioData(data);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      const done = new Promise<void>((resolve) => { source.onended = () => resolve(); });
      source.start(); await done;
    } catch (err) { if (!abort.signal.aborted) setError((err as Error).message); }
    finally { if (context.state !== 'closed') await context.close(); setPreviewing(false); }
  }
  const working = busy || status?.phase === 'working';
  const inputClass = 'block min-h-11 w-full rounded border border-input bg-background p-2';
  return <div className="mx-auto max-w-2xl space-y-5">
    <h1 className="text-xl font-semibold">Voice Box</h1>
    <p>Optional local voice chat for Josi. Kokoro provides neural speech on your CPU. Audio stays on this installation; transcripts go through your configured Josi model and its existing permissions.</p>
    {error && <ErrorNote>{error}</ErrorNote>}
    {!status ? <p>Checking Voice Box…</p> : <>
      <p role="status">{working ? 'Applying changes and checking speech models…' : status.healthy ? 'Speech models are ready' : status.apiReady ? 'API is ready; speech models are not ready' : status.phase === 'absent' ? 'Voice Box is not installed' : 'Voice Box is not ready'}</p>
      {status.error && <ErrorNote>{status.error}</ErrorNote>}
      {!status.verified ? <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-semibold">Before you install</h2>
        <ul className="list-disc space-y-1 pl-5">{status.requirements.map((item) => <li key={item}>{item}</li>)}</ul>
        <p className="text-sm">Kokoro weights and the included Heart and Bella voices use Apache-2.0 terms. Whisper uses MIT terms. Third-party notices accompany the pinned image. Installation downloads the image; no microphone audio is sent to a speech provider.</p>
        {!status.helperAvailable && <p>The host operator must enable the optional Voice Box helper once. Follow the repository’s Voice Box setup guide.</p>}
        {status.helperAvailable && !status.releaseAvailable && <p>A Voice Box image has not yet been authorized for release.</p>}
        <Button disabled={working || !status.helperAvailable || !status.releaseAvailable} onClick={() => void operation('install')}>Install Voice Box</Button>
      </section> : settings && <section className="space-y-4 rounded border border-border p-4">
        <h2 className="font-semibold">Speech settings</h2>
        <fieldset disabled={working || !status.healthy} className="grid gap-4 sm:grid-cols-2">
          <label>Voice<select aria-label="Voice" className={inputClass} value={settings.voice} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}>
            <option value="af_heart">Heart — US English</option><option value="af_bella">Bella — US English</option>
          </select></label>
          <label>Transcription model<select className={inputClass} value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })}><option value="base.en">Whisper Base — English</option><option value="tiny.en">Whisper Tiny — lighter English model</option></select></label>
          <label>Transcription acceleration<select className={inputClass} value={settings.device} onChange={(e) => setSettings({ ...settings, device: e.target.value as Settings['device'] })}><option value="cpu">CPU</option><option value="cuda" disabled={!status.gpuAvailable}>NVIDIA GPU (optional)</option></select></label>
          <label>Speech detection threshold<input className={inputClass} type="number" min="0.2" max="0.9" step="0.05" value={settings.threshold} onChange={(e) => setSettings({ ...settings, threshold: Number(e.target.value) })} /></label>
          <label>Pause before sending (ms)<input className={inputClass} type="number" min="300" max="1800" step="100" value={settings.silenceMs} onChange={(e) => setSettings({ ...settings, silenceMs: Number(e.target.value) })} /></label>
          <label>Speaking speed<input className={inputClass} type="number" min="0.7" max="1.4" step="0.05" value={settings.speed} onChange={(e) => setSettings({ ...settings, speed: Number(e.target.value) })} /></label>
        </fieldset>
        <p className="text-sm text-muted-foreground">Save and wait for model verification before previewing a new voice.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={working || !status.healthy} onClick={() => void operation('settings', settings)}>Save and verify</Button>
          <Button disabled={working || !status.healthy || previewing || JSON.stringify(settings) !== savedSettings} onClick={() => void playPreview()}>{previewing ? 'Playing preview…' : 'Preview voice'}</Button>
          <Button disabled={working} onClick={() => void operation('restart')}>Restart</Button>
          <Button disabled={working || !status.releaseAvailable} onClick={() => void operation('update')}>Update Voice Box</Button>
          <Button disabled={working || !status.previous} onClick={() => void operation('rollback')}>Roll back</Button>
          <Button disabled={working} onClick={() => setRemove(true)}>Uninstall</Button>
        </div>
        {remove && <div className="space-y-2"><p>Stop and remove the Voice Box container? Josi conversations and settings are preserved.</p><Button disabled={working} onClick={() => void operation('uninstall')}>Confirm uninstall</Button> <Button onClick={() => setRemove(false)}>Cancel</Button></div>}
      </section>}
    </>}
  </div>;
}
