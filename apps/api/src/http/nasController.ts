import http from 'node:http';

export interface NasSharePlan {
  protocol: 'smb' | 'nfs';
  host: string;
  share: string;
  folder: string;
  username?: string;
  password?: string;
  readOnly?: boolean;
}

export interface NasController {
  browse(plan: Omit<NasSharePlan, 'folder'>): Promise<string[]>;
  configure(plan: NasSharePlan): Promise<{ mountedPath: string }>;
  remove(): Promise<void>;
}

/** Narrow Unix-socket client. The API never receives Docker authority; the
 * installer-owned helper accepts only these three storage operations. */
export function nasController(socketPath = process.env.JOSI_STORAGE_HELPER_SOCKET): NasController | null {
  if (!socketPath) return null;
  const call = <T>(path: string, body: unknown): Promise<T> => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? 'storage helper refused the request'));
          else resolve(parsed as T);
        } catch { reject(new Error('storage helper returned an invalid response')); }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('storage helper timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return {
    browse: (plan) => call<{ folders: string[] }>('/browse', plan).then((r) => r.folders),
    configure: (plan) => call('/configure', plan),
    remove: () => call('/remove', {}).then(() => undefined),
  };
}
