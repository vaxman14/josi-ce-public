/** Fetch audio with the same session/CSRF contract as the normal JSON API. */
export async function fetchVoiceAudio(path: string, body: unknown, signal?: AbortSignal): Promise<ArrayBuffer> {
  const token = /(?:^|;\s*)josi_csrf=([^;]+)/.exec(document.cookie)?.[1];
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-josi-csrf': decodeURIComponent(token) } : {}) },
    body: JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? 'Voice audio could not be loaded');
  }
  return response.arrayBuffer();
}

export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = Math.min(400, remaining.length);
    if (end < remaining.length) {
      const sentence = remaining.slice(0, end).search(/[.!?][^.!?]*$/);
      end = sentence > 100 ? sentence + 1 : remaining.lastIndexOf(' ', end);
      if (end <= 0) end = 400;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

/** Combine captured PCM16 frames without exceeding Voice Box's one-second limit. */
export function takeVoiceFrame(frames: Uint8Array[], maxBytes = 32_000): Uint8Array {
  let size = 0;
  let count = 0;
  while (count < frames.length && size + frames[count].byteLength <= maxBytes) {
    size += frames[count].byteLength;
    count++;
  }
  if (!count) throw new Error('Voice capture produced an oversized audio frame');
  if (count === 1) return frames.shift()!;
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const frame of frames.splice(0, count)) {
    combined.set(frame, offset);
    offset += frame.byteLength;
  }
  return combined;
}
