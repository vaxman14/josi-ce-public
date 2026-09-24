// The Bot API client: error categorisation, retries, and the download cap
// (L1.6, L1.7).
//
// The recurring assertion across this file is NEGATIVE: the bot token must not
// appear in anything a person or a log could see. Telegram puts the token in
// the URL, so an error that carries a URL carries a credential, and the ways
// that happens by accident — `err.message` including the cause, a description
// passed through, a rejected fetch stringified — are each tested for
// explicitly rather than assumed away.
import { describe, expect, it, vi } from 'vitest';
import { asSecret } from '@josi-ce/core';
import {
  TELEGRAM_API_ORIGIN, TelegramApiError, TelegramBotApi, categorise, withRetry,
} from '../src/telegram/api.js';

const TOKEN = '123456789:AAHtestTOKENvaluethatislongenough00';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('categorising a failure', () => {
  it('maps the statuses that matter', () => {
    expect(categorise(401, { description: 'Unauthorized' }).category).toBe('unauthorized');
    expect(categorise(404, {}).category).toBe('unauthorized');
    expect(categorise(429, { parameters: { retry_after: 7 } }).category).toBe('rate_limited');
    expect(categorise(500, {}).category).toBe('network');
    expect(categorise(502, {}).category).toBe('network');
    expect(categorise(400, {}).category).toBe('malformed');
    expect(categorise(418, {}).category).toBe('unknown');
  });

  it('tells "your token is wrong" apart from "they blocked you"', () => {
    // Both arrive as 403, and treating them the same means either revoking a
    // working bot or retrying a dead chat forever.
    expect(categorise(403, { description: 'Forbidden: bot was blocked by the user' }).category)
      .toBe('blocked_by_user');
    expect(categorise(403, { description: 'Forbidden: bot was kicked from the group chat' }).category)
      .toBe('blocked_by_user');
    expect(categorise(403, { description: 'Forbidden' }).category).toBe('unauthorized');
  });

  it('carries retry_after when Telegram supplies one', () => {
    expect(categorise(429, { parameters: { retry_after: 12 } }).retryAfterSeconds).toBe(12);
    expect(categorise(429, {}).retryAfterSeconds).toBeUndefined();
  });

  it('NEVER passes Telegram\'s description through to the message', () => {
    // A real 400 from Telegram can echo the request. The request URL contains
    // the token, so the description is untrusted output.
    const err = categorise(400, {
      description: `Bad Request: wrong url https://api.telegram.org/bot${TOKEN}/sendMessage`,
    });
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('api.telegram.org');
    expect(err.message).toBe('Telegram refused the request.');
  });

  it('knows what is worth retrying', () => {
    expect(new TelegramApiError('rate_limited', 'x').retryable).toBe(true);
    expect(new TelegramApiError('network', 'x').retryable).toBe(true);
    // A bad token cannot be fixed by trying again, and retrying it burns the
    // allowance the legitimate traffic needs.
    expect(new TelegramApiError('unauthorized', 'x').retryable).toBe(false);
    expect(new TelegramApiError('blocked_by_user', 'x').retryable).toBe(false);
    expect(new TelegramApiError('malformed', 'x').retryable).toBe(false);
    expect(new TelegramApiError('too_large', 'x').retryable).toBe(false);
  });
});

describe('retrying', () => {
  it('gives up immediately on something a retry cannot fix', async () => {
    const fn = vi.fn(async () => { throw new TelegramApiError('unauthorized', 'no'); });
    await expect(withRetry(fn, { maxAttempts: 3, sleep: async () => {} })).rejects.toThrow('no');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and honours the delay Telegram asked for', async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new TelegramApiError('rate_limited', 'slow down', 4);
      return 'ok';
    }, { maxAttempts: 3, sleep: async (ms) => { slept.push(ms); } });

    expect(result).toBe('ok');
    // Guessing a shorter delay than the number the server just gave is how a
    // rate limit becomes a longer rate limit.
    expect(slept).toEqual([4000, 4000]);
  });

  it('backs off exponentially when Telegram says nothing', async () => {
    const slept: number[] = [];
    await expect(withRetry(async () => {
      throw new TelegramApiError('network', 'down');
    }, { maxAttempts: 4, baseDelayMs: 100, sleep: async (ms) => { slept.push(ms); } }))
      .rejects.toThrow('down');
    expect(slept).toEqual([100, 200, 400]);
  });

  it('caps a hostile retry_after', async () => {
    const slept: number[] = [];
    await expect(withRetry(async () => {
      // A buggy or hostile server asking for a day.
      throw new TelegramApiError('rate_limited', 'wait', 86_400);
    }, { maxAttempts: 2, maxDelayMs: 30_000, sleep: async (ms) => { slept.push(ms); } }))
      .rejects.toThrow();
    expect(slept).toEqual([30_000]);
  });

  it('stops at maxAttempts and rethrows the last failure', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new TelegramApiError('network', `attempt ${calls}`);
    }, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} })).rejects.toThrow('attempt 3');
    expect(calls).toBe(3);
  });
});

describe('the client', () => {
  it('talks only to api.telegram.org, and puts the token in the path', async () => {
    let seen = '';
    const api = new TelegramBotApi({
      token: asSecret(TOKEN),
      fetchImpl: async (url) => {
        seen = String(url);
        return jsonResponse(200, { ok: true, result: { id: 7, is_bot: true, username: 'josi_bot' } });
      },
    });
    const me = await api.getMe();
    expect(me.username).toBe('josi_bot');
    expect(seen).toBe(`${TELEGRAM_API_ORIGIN}/bot${TOKEN}/getMe`);
    // There is no configuration surface that could point this elsewhere, which
    // is why this package needs none of Phase 4's SSRF machinery.
    expect(seen.startsWith('https://api.telegram.org/')).toBe(true);
  });

  it('turns a network failure into a category with no URL in it', async () => {
    const api = new TelegramBotApi({
      token: asSecret(TOKEN),
      fetchImpl: async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`); },
    });
    await expect(api.getMe()).rejects.toMatchObject({ category: 'network' });
    await api.getMe().catch((err: Error) => {
      expect(err.message).not.toContain(TOKEN);
    });
  });

  it('turns unparseable output into `malformed` rather than crashing', async () => {
    const api = new TelegramBotApi({
      token: asSecret(TOKEN),
      fetchImpl: async () => new Response('<html>502</html>', { status: 200 }),
    });
    await expect(api.getMe()).rejects.toMatchObject({ category: 'malformed' });
  });

  it('treats ok:false with a 200 as a failure, and reads the code from the envelope', async () => {
    // Telegram sometimes answers HTTP 200 with `ok:false` and the real code
    // inside. Categorising on the transport status alone put every one of those
    // in `unknown` — so a "bot was blocked" rejection would have been retried
    // three times and reported as a mystery instead of revoking a dead chat.
    const cases: Array<[number, string, string]> = [
      [400, 'Bad Request: message is too long', 'malformed'],
      [401, 'Unauthorized', 'unauthorized'],
      [403, 'Forbidden: bot was blocked by the user', 'blocked_by_user'],
      [429, 'Too Many Requests', 'rate_limited'],
    ];
    for (const [code, description, expected] of cases) {
      const api = new TelegramBotApi({
        token: asSecret(TOKEN),
        fetchImpl: async () => jsonResponse(200, { ok: false, error_code: code, description }),
      });
      await expect(api.getMe(), `error_code ${code}`)
        .rejects.toMatchObject({ category: expected });
    }
  });

  it('disables link previews, because a preview is an outbound request about a private message', async () => {
    let body: any = null;
    const api = new TelegramBotApi({
      token: asSecret(TOKEN),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return jsonResponse(200, { ok: true, result: { message_id: 1 } });
      },
    });
    await api.sendMessage({ chatId: 5, text: 'hi' });
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body.chat_id).toBe(5);
  });

  it('narrows the webhook to messages and drops the queue from a previous bot', async () => {
    let body: any = null;
    const api = new TelegramBotApi({
      token: asSecret(TOKEN),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return jsonResponse(200, { ok: true, result: true });
      },
    });
    await api.setWebhook({ url: 'https://josi.example/telegram/webhook', secretToken: asSecret('s3cr3t') });
    expect(body.allowed_updates).toEqual(['message']);
    // Replaying a queue from a previous configuration would deliver messages
    // people sent to a bot that was not yet linked to anybody.
    expect(body.drop_pending_updates).toBe(true);
    expect(body.secret_token).toBe('s3cr3t');
  });
});

describe('downloading a file', () => {
  const api = (fetchImpl: typeof fetch) => new TelegramBotApi({ token: asSecret(TOKEN), fetchImpl });

  it('refuses a truthfully oversize Content-Length before transferring', async () => {
    // `bodyUsed` flips the moment the body is disturbed — which `getReader()`
    // does. Asserting it stayed false is the direct statement that a truthful
    // oversize header saved the whole transfer. (A stream's own `pull` cannot
    // be used for this: the default queuing strategy prefetches one chunk
    // before anybody reads, so counting pulls would measure the platform.)
    let response: Response | null = null;
    const client = api(async () => {
      response = new Response(
        new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); } }),
        { status: 200, headers: { 'content-length': '9999999' } },
      );
      return response;
    });
    await expect(client.downloadFile('docs/x.pdf', 1024))
      .rejects.toMatchObject({ category: 'too_large' });
    expect(response!.bodyUsed).toBe(false);
  });

  it('refuses a LYING Content-Length by counting the bytes as they arrive', async () => {
    // The important one. Content-Length is a claim; without a running total,
    // a response declaring 1 KB and streaming forever is a memory-exhaustion
    // primitive rather than a limit that was bypassed.
    let cancelled = false;
    const client = api(async () => new Response(
      new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(512)); },
        cancel() { cancelled = true; },
      }),
      { status: 200, headers: { 'content-length': '10' } },
    ));
    await expect(client.downloadFile('docs/x.pdf', 2048))
      .rejects.toMatchObject({ category: 'too_large' });
    expect(cancelled).toBe(true);
  });

  it('returns the bytes when they fit', async () => {
    const client = api(async () => new Response(Buffer.from('hello'), { status: 200 }));
    const buf = await client.downloadFile('docs/x.txt', 1024);
    expect(buf.toString()).toBe('hello');
  });

  it('does not follow a redirect', async () => {
    // `redirect: 'error'` is the property being asserted. A redirect from the
    // file endpoint is not something Telegram does, and following one would
    // make this the one place in the package that can be pointed elsewhere.
    let init: RequestInit | undefined;
    const client = api(async (_u, i) => { init = i as RequestInit; return new Response('x', { status: 200 }); });
    await client.downloadFile('docs/x.txt', 1024);
    expect(init?.redirect).toBe('error');
  });
});
