import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';

const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const HEIC_MEDIA_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

export class ChatImageError extends Error {}

export interface NormalizedChatImage {
  filename: string;
  contentType: string;
  bytes: Buffer;
  converted: boolean;
}

export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') return false;
  const brandBytes = Buffer.from(bytes.subarray(8, Math.min(bytes.length, 40)));
  for (let offset = 0; offset + 4 <= brandBytes.length; offset += 4) {
    if (HEIF_BRANDS.has(brandBytes.subarray(offset, offset + 4).toString('ascii'))) return true;
  }
  return false;
}

function jpegFilename(filename: string): string {
  const extension = extname(filename);
  const base = extension ? filename.slice(0, -extension.length) : filename;
  return `${base || 'image'}.jpg`.slice(0, 240);
}

async function convertHeicInWorker(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heicWorker.js', import.meta.url), { workerData: bytes });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new ChatImageError('That HEIC image took too long to process. Try exporting it as JPEG.'));
    }, 30_000);
    worker.once('message', (message: { ok: boolean; output?: Uint8Array; error?: string }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (!message.ok || !message.output) {
        reject(new ChatImageError('That HEIC image is damaged or uses an unsupported encoding. Try exporting it as JPEG.'));
        return;
      }
      resolve(Buffer.from(message.output));
    });
    worker.once('error', () => {
      clearTimeout(timeout);
      reject(new ChatImageError('Josi could not process that HEIC image. Try exporting it as JPEG.'));
    });
  });
}

export async function normalizeChatImage(args: {
  filename: string;
  declaredContentType: string;
  bytes: Buffer;
  convertHeic?: (bytes: Buffer) => Promise<Buffer>;
}): Promise<NormalizedChatImage> {
  const extension = extname(args.filename).replace(/^\./, '').toLowerCase();
  const declared = args.declaredContentType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  const claimedHeic = HEIC_EXTENSIONS.has(extension) || HEIC_MEDIA_TYPES.has(declared);
  const actualHeic = isHeic(args.bytes);

  if (!claimedHeic && !actualHeic) {
    return { filename: args.filename, contentType: args.declaredContentType, bytes: args.bytes, converted: false };
  }
  if (!actualHeic) {
    throw new ChatImageError('That file is named as a HEIC image, but its contents are not a valid HEIC/HEIF image.');
  }
  if (!HEIC_EXTENSIONS.has(extension) || !HEIC_MEDIA_TYPES.has(declared)) {
    throw new ChatImageError('The HEIC/HEIF extension, declared MIME type, and file signature must agree.');
  }

  const output = await (args.convertHeic ?? convertHeicInWorker)(args.bytes);
  if (output.length < 4 || output[0] !== 0xff || output[1] !== 0xd8 || output.at(-2) !== 0xff || output.at(-1) !== 0xd9) {
    throw new ChatImageError('Josi could not safely convert that HEIC image. Try exporting it as JPEG.');
  }
  if (output.length > MAX_CHAT_IMAGE_BYTES) {
    throw new ChatImageError('That HEIC image becomes larger than 20 MB after conversion. Export a smaller JPEG and try again.');
  }
  return { filename: jpegFilename(args.filename), contentType: 'image/jpeg', bytes: output, converted: true };
}
