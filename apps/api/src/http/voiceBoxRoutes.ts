import { request } from 'node:http';
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute } from './async.js';

export interface VoiceReply { status: number; type: string; data: Buffer }
export type VoiceHelper = (path: string, body?: unknown) => Promise<VoiceReply>;

/** The app receives access to this one socket, never a Docker capability. */
export function voiceHelper(socketPath?: string): VoiceHelper {
  return (path, body) => new Promise((resolve, reject) => {
    if (!socketPath) return reject(new Error('helper unavailable'));
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path, method: encoded === undefined ? 'GET' : 'POST',
      headers: encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) res.destroy(new Error('voice response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 503,
        type: res.headers['content-type'] ?? 'application/json', data: Buffer.concat(chunks) }));
    });
    req.setTimeout(50_000, () => req.destroy(new Error('voice timeout')));
    req.on('error', reject);
    req.end(encoded);
  });
}

const requirements = [
  '64-bit Linux with Docker Engine, Compose v2 and the optional host helper',
  '4 GB available RAM, 5 GB free disk and at least 2 CPU cores',
  'HTTPS or localhost for browser microphone access',
  'Kokoro provides local neural speech with Heart and Bella voices.',
];

export function voiceBoxRoutes(helper: VoiceHelper): { admin: Router; voice: Router } {
  const admin = Router();
  const voice = Router();
  admin.use(requireSuperAdmin);
  voice.use(requireAuth);
  const sessions = new Map<string, { owner: string; at: number; busy: boolean }>();
  const active = new Set<string>();
  const prune = () => {
    for (const [id, session] of sessions) if (Date.now() - session.at > 60_000) sessions.delete(id);
  };
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return await fn(req, res); }
    catch { return res.status(503).json({ error: 'Voice Box is unavailable. Check Admin → Voice Box.' }); }
  });
  const forward = (res: Response, reply: VoiceReply) => res.status(reply.status).type(reply.type).send(reply.data);
  const status = async () => JSON.parse((await helper('/status')).data.toString()) as Record<string, unknown>;
  admin.get('/', handle(async (_req, res) => {
    try { return res.json(await status()); }
    catch { return res.json({ helperAvailable: false, healthy: false, verified: false,
      releaseAvailable: false, phase: 'absent', requirements }); }
  }));
  for (const operation of ['install', 'update', 'restart', 'uninstall', 'rollback', 'settings']) {
    admin.post(`/${operation}`, handle(async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        return res.status(400).json({ error: 'Invalid Voice Box request' });
      if (operation !== 'settings' && Object.keys(req.body).length)
        return res.status(400).json({ error: 'This operation accepts no parameters' });
      return forward(res, await helper(`/operation/${operation}`, req.body));
    }));
  }
  admin.post('/preview', handle(async (req, res) => {
    if (Object.keys(req.body ?? {}).length) return res.status(400).json({ error: 'Preview accepts no parameters' });
    const current = await status();
    if (!current.verified || !current.healthy) return res.status(409).json({ error: 'Wait for healthy speech models before previewing' });
    return forward(res, await helper('/speech', { text: 'Hi, I’m Josi. This is how I will sound when we talk. What would you like to work on today?' }));
  }));
  voice.get('/status', handle(async (_req, res) => {
    try {
      const current = await status();
      return res.json({ available: current.verified === true && current.healthy === true && current.phase === 'ready' });
    } catch { return res.json({ available: false }); }
  }));
  voice.post('/session', handle(async (req, res) => {
    prune();
    const owner = req.user!.id;
    if (Object.keys(req.body ?? {}).length) return res.status(400).json({ error: 'Session accepts no parameters' });
    if (sessions.size >= 4 || active.has(owner) || [...sessions.values()].some((s) => s.owner === owner))
      return res.status(429).json({ error: 'A voice session is already open or Voice Box is busy' });
    active.add(owner);
    try {
      const reply = await helper('/session', {});
      if (reply.status === 200) {
        const { session } = JSON.parse(reply.data.toString()) as { session: string };
        if (!/^[a-f0-9]{48}$/.test(session)) throw new Error('invalid session');
        sessions.set(session, { owner, at: Date.now(), busy: false });
      }
      return forward(res, reply);
    } finally { active.delete(owner); }
  }));
  for (const operation of ['audio', 'close']) {
    voice.post(`/${operation}`, handle(async (req, res) => {
      prune();
      const body = req.body as Record<string, unknown> | undefined;
      const id = typeof body?.session === 'string' ? body.session : '';
      const session = sessions.get(id);
      if (!session || session.owner !== req.user!.id) return res.status(404).json({ error: 'Voice session not found' });
      const keys = Object.keys(body ?? {}).sort().join(',');
      if (operation === 'audio' && (keys !== 'pcm,seq,session' || !Number.isInteger(body!.seq)
        || typeof body!.pcm !== 'string' || body!.pcm.length > 44000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body!.pcm)))
        return res.status(400).json({ error: 'Invalid audio frame' });
      if (operation === 'close' && keys !== 'session') return res.status(400).json({ error: 'Invalid close request' });
      if (session.busy) return res.status(429).json({ error: 'A voice frame is still processing' });
      session.busy = true;
      session.at = Date.now();
      try {
        const reply = await helper(`/${operation}`, body);
        if (operation === 'close' || reply.status === 404) sessions.delete(id);
        return forward(res, reply);
      } finally { session.busy = false; }
    }));
  }
  voice.post('/speech', handle(async (req, res) => {
    const text = req.body?.text;
    if (Object.keys(req.body ?? {}).join(',') !== 'text' || typeof text !== 'string' || !text.trim() || text.length > 600)
      return res.status(400).json({ error: 'Provide between 1 and 600 characters to speak' });
    const owner = req.user!.id;
    if (active.has(owner) || active.size >= 4) return res.status(429).json({ error: 'Voice Box is busy' });
    active.add(owner);
    try { return forward(res, await helper('/speech', { text })); }
    finally { active.delete(owner); }
  }));
  return { admin, voice };
}
