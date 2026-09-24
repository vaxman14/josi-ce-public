import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';

const input = Buffer.from(workerData as Uint8Array);

try {
  const output = await convert({ buffer: input, format: 'JPEG', quality: 0.9 });
  parentPort?.postMessage({ ok: true, output });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : 'conversion failed' });
}
