// The Telegram Bot API client.
//
// Small, and deliberately not a wrapper around a library. Four methods are
// needed and each one has a security property worth writing down next to it.
//
// THE HOST IS A CONSTANT. Phase 4 spent a lot of effort on SSRF because a
// self-hosted LLM base URL is operator-supplied and has to be. Nothing here is:
// the Bot API lives at api.telegram.org and there is no configuration surface
// that could point this anywhere else. `fetchImpl` is injected for tests, which
// is the only substitution that exists, and it is a constructor argument rather
// than something read from the database.
//
// THE TOKEN IS IN THE PATH. Telegram puts the bot token in the URL, which means
// the URL is a credential: it must never be logged, never appear in an error,
// and never reach an audit payload. Every error this module raises is a
// CATEGORY. The one place a URL is built is `endpoint()`, and the one place a
// message is produced is `categorise()`; neither interpolates a response body.
import { Secret } from '@josi-ce/core';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

export type TelegramErrorCategory =
  | 'unauthorized' | 'blocked_by_user' | 'chat_not_found' | 'rate_limited'
  | 'network' | 'too_large' | 'malformed' | 'unknown';

export class TelegramApiError extends Error {
  constructor(
    readonly category: TelegramErrorCategory,
    message: string,
    /** Seconds Telegram asked us to wait, when it said so. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  /** Whether a second attempt could plausibly succeed. A bad token cannot be
   * fixed by trying again, and retrying it just burns the rate limit that the
   * legitimate traffic needs. */
  get retryable(): boolean {
    return this.category === 'rate_limited' || this.category === 'network';
  }
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface BotApiOptions {
  token: Secret;
  /** Injected by tests. Absent in production, where global fetch is used. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injected by tests so a backoff test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Telegram's hard ceiling on a text message. Not a preference — the API
 * rejects anything longer, so chunking is correctness, not politeness. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** The largest file the Bot API will serve through getFile, whatever an
 * administrator sets as their own ceiling. Stated here so the attachment gate
 * can refuse before spending a request on something that cannot work. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramBotApi {
  readonly #token: Secret;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: BotApiOptions) {
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The only place a token-bearing URL is constructed. Private, and it returns
   * a string that must not be logged by anything. */
  #endpoint(method: string): string {
    return `${TELEGRAM_API_ORIGIN}/bot${this.#token.reveal()}/${method}`;
  }

  #fileEndpoint(path: string): string {
    return `${TELEGRAM_API_ORIGIN}/file/bot${this.#token.reveal()}/${path}`;
  }

  async #call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      // Includes the abort. Never carries the cause through: a fetch error
      // message contains the URL, and the URL contains the token.
      throw new TelegramApiError('network', 'Telegram could not be reached.');
    } finally {
      clearTimeout(timer);
    }

    let payload: TelegramEnvelope;
    try {
      payload = (await res.json()) as TelegramEnvelope;
    } catch {
      throw new TelegramApiError('malformed', 'Telegram sent a response Josi could not read.');
    }

    if (res.ok && payload?.ok === true) return payload.result as T;
    // The ENVELOPE's error_code wins over the HTTP status.
    //
    // Telegram sometimes answers 200 with `ok:false` and the real code inside.
    // Categorising on the transport status alone put those in `unknown`, so a
    // rejected send with `error_code: 403` would have been retried three times
    // and reported as a mystery instead of revoking a dead chat. Found by the
    // test below, not by reading the docs.
    throw categorise(payload?.error_code ?? res.status, payload);
  }

  /** Verifies a token and learns who the bot is. The setup probe.
   *
   * `getMe` is chosen over anything heavier on purpose: it changes nothing, it
   * costs nothing, and a token that can do this can do everything else. */
  async getMe(): Promise<TelegramUser> {
    return this.#call<TelegramUser>('getMe', {});
  }

  /** Sends one chunk. Chunking happens above this, in `format.ts`, so this
   * function has exactly one job and the retry logic wraps a single request. */
  async sendMessage(args: {
    chatId: number;
    text: string;
    parseMode?: 'MarkdownV2' | null;
    disableWebPagePreview?: boolean;
  }): Promise<{ message_id: number }> {
    return this.#call<{ message_id: number }>('sendMessage', {
      chat_id: args.chatId,
      text: args.text,
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      // A link preview is an outbound request made by Telegram's servers on
      // behalf of the content of somebody's private conversation. Off.
      link_preview_options: { is_disabled: args.disableWebPagePreview !== false },
    });
  }

  async setWebhook(args: {
    url: string;
    secretToken: Secret;
    /** Which update kinds to receive. Narrow by default: CE handles private
     * messages, so asking for channel posts and inline queries would be
     * accepting traffic it has no code to reason about. */
    allowedUpdates?: string[];
  }): Promise<true> {
    return this.#call<true>('setWebhook', {
      url: args.url,
      secret_token: args.secretToken.reveal(),
      allowed_updates: args.allowedUpdates ?? ['message'],
      // Old queued updates from a previous configuration are not this
      // installation's business, and replaying them would deliver messages
      // people sent to a bot that was not yet linked to anybody.
      drop_pending_updates: true,
      max_connections: 10,
    });
  }

  async deleteWebhook(): Promise<true> {
    return this.#call<true>('deleteWebhook', { drop_pending_updates: true });
  }

  /** Resolves a file id to a path. Separate from the download so the size can
   * be checked against the administrator's ceiling before any bytes move. */
  async getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    return this.#call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
  }

  /**
   * Downloads a file, refusing to exceed `maxBytes`.
   *
   * The cap is enforced on the BYTES AS THEY ARRIVE, not on the
   * `Content-Length` header and not on the `file_size` Telegram reported. Both
   * of those are claims. A response that declares 1 KB and then streams
   * forever is the ordinary way a size limit gets bypassed, and the only
   * defence is to stop reading.
   */
  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(this.#fileEndpoint(filePath), {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) throw categorise(res.status, null);

      // The cheap check first — a truthful oversize header saves the transfer.
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new TelegramApiError('too_large', 'That file is larger than this installation allows.');
      }

      const body = res.body;
      if (!body) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          throw new TelegramApiError('too_large', 'That file is larger than this installation allows.');
        }
        return buf;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          // Stop pulling. Without this a lying Content-Length is not a lie
          // that costs anything — it is a memory exhaustion primitive.
          await reader.cancel().catch(() => {});
          throw new TelegramApiError('too_large', 'That file is larger than this installation allows.');
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;
      throw new TelegramApiError('network', 'That file could not be downloaded.');
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TelegramEnvelope {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
  result?: unknown;
}

/**
 * Turns a failure into a category and a sentence a person can act on.
 *
 * Telegram's `description` is NEVER passed through. Two reasons, and the second
 * is the one that matters: some failures echo the request, and the request
 * carried the token; and a description is written for a bot author debugging at
 * a terminal, not for the operator of an assistant.
 *
 * Exported for the tests, which assert both the mapping and the absence of any
 * provider text in the result.
 */
export function categorise(status: number, payload: TelegramEnvelope | null): TelegramApiError {
  const retryAfter = payload?.parameters?.retry_after;
  const description = (payload?.description ?? '').toLowerCase();

  if (status === 401 || status === 403) {
    // 403 is two different problems wearing one status code, and telling them
    // apart is the difference between "your token is wrong" and "that person
    // blocked your bot". Matching on the description is safe here: the result
    // is a fixed string of ours, and nothing from `description` is carried out.
    if (description.includes('blocked') || description.includes('bot was kicked')) {
      return new TelegramApiError('blocked_by_user', 'That person has blocked this bot in Telegram.');
    }
    if (status === 403 && description.includes('chat not found')) {
      return new TelegramApiError('chat_not_found', 'That Telegram chat no longer exists.');
    }
    return new TelegramApiError('unauthorized', 'Telegram rejected the bot token.');
  }
  if (status === 400) {
    if (description.includes('chat not found')) {
      return new TelegramApiError('chat_not_found', 'That Telegram chat no longer exists.');
    }
    if (description.includes('too large') || description.includes('file is too big')) {
      return new TelegramApiError('too_large', 'Telegram refused that file as too large.');
    }
    return new TelegramApiError('malformed', 'Telegram refused the request.');
  }
  if (status === 404) {
    return new TelegramApiError('unauthorized', 'Telegram rejected the bot token.');
  }
  if (status === 429) {
    return new TelegramApiError(
      'rate_limited',
      'Telegram is rate limiting this bot.',
      typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : undefined,
    );
  }
  if (status >= 500) {
    return new TelegramApiError('network', 'Telegram is having trouble; Josi will try again.');
  }
  return new TelegramApiError('unknown', 'Telegram returned something unexpected.');
}

export interface RetryOptions {
  maxAttempts?: number;
  /** Base for exponential backoff. Injected small in tests. */
  baseDelayMs?: number;
  /** Ceiling on any single wait, including one Telegram asked for. A hostile
   * or buggy `retry_after` of 86400 must not park a request for a day. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries a Bot API call, and refuses to retry the failures that a second
 * attempt cannot fix.
 *
 * The rule is in `TelegramApiError.retryable`: rate limits and network trouble
 * get another go, an unauthorized token and a malformed request do not. Getting
 * this backwards is not a performance bug — hammering `sendMessage` with a
 * revoked token is how a bot gets throttled for the traffic that would have
 * worked.
 *
 * `retry_after` is honoured when Telegram supplies it, because guessing a
 * shorter delay than the number the server just gave is how a rate limit
 * becomes a longer rate limit.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const retryable = err instanceof TelegramApiError && err.retryable;
      if (!retryable || attempt === maxAttempts) break;

      const asked = err instanceof TelegramApiError && err.retryAfterSeconds !== undefined
        ? err.retryAfterSeconds * 1000
        : base * 2 ** (attempt - 1);
      await sleep(Math.min(maxDelay, Math.max(0, asked)));
    }
  }
  throw last;
}
