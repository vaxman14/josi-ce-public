// Does this model actually do what CE needs?
//
// The alternative — infer capability from the model name — is guesswork that
// fails silently in production, months later, in front of a customer. A name is
// a marketing decision; this is a compatibility question, so it is answered by
// asking the model.
//
// Five questions, in order of how much they cost, stopping early when a
// prerequisite fails. Nothing is inferred: `toolCalling: true` means a tool call
// came back in a response we read, and `vision: true` means the model was
// actually shown a picture and answered a verifiable question about it.
import type { Capabilities, ChatRequest, LlmProvider } from './types.js';
import { LlmError } from './types.js';

// An 8x8 solid-red PNG, generated once and pinned here as a literal rather
// than shipped as a file: the probe must not depend on a fixture surviving a
// build step, and the whole point of asking "what colour" is that the answer
// is unambiguous and easy to grade without another model in the loop.
const RED_SWATCH_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';

export interface ProbeStep {
  id: keyof Capabilities | 'context';
  label: string;
  passed: boolean;
  /** One sentence for the operator. Never the provider's own error text. */
  detail: string;
  latencyMs?: number;
}

export interface ProbeResult {
  capabilities: Capabilities;
  steps: ProbeStep[];
  /** Set when the probe could not run at all — bad key, unreachable endpoint. */
  fatal?: string;
  fatalCategory?: string;
  fatalProviderCode?: string;
  probedAt: string;
}

const PROBE_TOOL = {
  name: 'record_number',
  description: 'Record a single number. Call this with the number 7.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'number', description: 'The number to record.' } },
    required: ['value'],
  },
};

export interface ProbeOptions {
  /** Injected in tests. */
  now?: () => Date;
}

export async function probeProvider(provider: LlmProvider, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? (() => new Date());
  const steps: ProbeStep[] = [];
  const capabilities: Capabilities = {
    chat: false,
    structuredOutput: false,
    toolCalling: false,
    vision: false,
    contextTokens: null,
  };

  const ask = async (request: ChatRequest) => provider.chat(request);

  // ---- 1. chat -----------------------------------------------------------
  // Everything else is meaningless if the model cannot answer at all, so a
  // failure here is fatal and the remaining probes are skipped rather than run
  // and reported as separate failures.
  try {
    const res = await ask({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 32,
      temperature: 0,
    });
    const passed = res.text.trim().length > 0;
    capabilities.chat = passed;
    steps.push({
      id: 'chat',
      label: 'Basic reply',
      passed,
      latencyMs: res.latencyMs,
      detail: passed ? 'The model answered.' : 'The model returned an empty reply.',
    });
    if (!passed) {
      return { capabilities, steps, probedAt: now().toISOString() };
    }
  } catch (err) {
    const message = err instanceof LlmError ? err.message : 'the model could not be reached';
    steps.push({ id: 'chat', label: 'Basic reply', passed: false, detail: message });
    return {
      capabilities, steps, fatal: message,
      fatalCategory: err instanceof LlmError ? err.category : 'unknown',
      fatalProviderCode: err instanceof LlmError ? err.providerCode : undefined,
      probedAt: now().toISOString(),
    };
  }

  // ---- 2. structured output ----------------------------------------------
  // Judged by parsing what came back, not by whether the request was accepted.
  // Plenty of endpoints accept `response_format` and then return prose.
  try {
    const res = await ask({
      messages: [{
        role: 'user',
        content: 'Return a JSON object with exactly one key "ok" whose value is the boolean true. No other text.',
      }],
      jsonMode: true,
      maxTokens: 64,
      temperature: 0,
    });
    let passed = false;
    try {
      // Models commonly wrap JSON in a fenced block even when told not to.
      const cleaned = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
      const value = JSON.parse(cleaned) as Record<string, unknown>;
      passed = typeof value === 'object' && value !== null && 'ok' in value;
    } catch {
      passed = false;
    }
    capabilities.structuredOutput = passed;
    steps.push({
      id: 'structuredOutput',
      label: 'Structured output',
      passed,
      latencyMs: res.latencyMs,
      detail: passed
        ? 'The model returned valid JSON when asked.'
        : 'The model did not return valid JSON, so features that depend on structured answers stay off.',
    });
  } catch (err) {
    steps.push({
      id: 'structuredOutput',
      label: 'Structured output',
      passed: false,
      detail: err instanceof LlmError ? err.message : 'the structured-output check failed',
    });
  }

  // ---- 3. tool calling ----------------------------------------------------
  try {
    const res = await ask({
      // Imperative on purpose. "Record the number 7" alone reads, to some
      // models, like a request they can satisfy in prose — and a probe that
      // flaps on phrasing measures the prompt, not the capability.
      messages: [{ role: 'user', content: 'Call the record_number tool with the number 7. You must use the tool; do not answer in text.' }],
      tools: [PROBE_TOOL],
      maxTokens: 128,
      temperature: 0,
    });
    // Two ways a call can "come back in a response we read": an HTTP provider
    // returns it as a pending request, and the CLI harness reports it as an
    // executed fact after Josi's own MCP server recorded it. Both are the
    // model genuinely calling a tool end-to-end — the harness case even more
    // so, since the call demonstrably reached our server. (`record_number` is
    // implemented by that server as a no-op for exactly this reason.)
    const observed = [...res.toolCalls, ...(res.executedToolCalls ?? [])];
    const passed = observed.some((c) => c.name === PROBE_TOOL.name);
    capabilities.toolCalling = passed;
    steps.push({
      id: 'toolCalling',
      label: 'Tool calling',
      passed,
      latencyMs: res.latencyMs,
      detail: passed
        ? 'The model called the tool it was offered.'
        : 'The model did not call the tool it was offered, so calendar, email and document features stay off.',
    });
  } catch (err) {
    steps.push({
      id: 'toolCalling',
      label: 'Tool calling',
      passed: false,
      detail: err instanceof LlmError ? err.message : 'the tool-calling check failed',
    });
  }

  // ---- 4. vision -----------------------------------------------------------
  // Shown, not assumed. A tiny solid-red swatch and a question whose only
  // honest answers are a shade of red or "I cannot see images" — nothing in
  // between, so a model guessing from context (no image bytes reached it at
  // all) is very unlikely to land on the right colour by chance.
  //
  // A provider adapter that has no code path for `images` on `ChatMessage`
  // simply ignores the field today (see providers/*.ts) rather than erroring,
  // so this step is a real signal for the ones that DO look at it (Anthropic's
  // HTTP adapter) and an honest, quiet failure for the ones that do not yet
  // (the OpenAI-compatible adapter, and both CLI subscription harnesses, which
  // flatten every message to text before it ever reaches the model).
  try {
    const res = await ask({
      messages: [{
        role: 'user',
        content: 'What color is this image? Answer with one word.',
        images: [{ mediaType: 'image/png', base64: RED_SWATCH_PNG_BASE64 }],
      }],
      maxTokens: 32,
      temperature: 0,
    });
    const passed = /\bred\b/i.test(res.text);
    capabilities.vision = passed;
    steps.push({
      id: 'vision',
      label: 'Image understanding',
      passed,
      latencyMs: res.latencyMs,
      detail: passed
        ? 'The model correctly identified the color of a test image.'
        : 'The model did not correctly identify a test image, so Josi will not describe attached '
          + 'pictures with it — it will say plainly that it cannot see them.',
    });
  } catch (err) {
    steps.push({
      id: 'vision',
      label: 'Image understanding',
      passed: false,
      detail: err instanceof LlmError ? err.message : 'the image-understanding check failed',
    });
  }

  // ---- 5. usable context --------------------------------------------------
  // Deliberately NOT a binary-search for the true window: that would cost real
  // money and take minutes. This asks whether a working minimum survives the
  // round trip, which is the question that matters for "will Josi function".
  const MINIMUM_USEFUL_TOKENS = 8000;
  try {
    // ~4 characters per token is rough but adequate; the check is "does a
    // prompt of roughly this size come back at all", not an exact measurement.
    const filler = 'word '.repeat(Math.floor((MINIMUM_USEFUL_TOKENS * 4) / 5));
    const res = await ask({
      messages: [{
        role: 'user',
        content: `${filler}\n\nIgnore the text above. Reply with the single word: ok`,
      }],
      maxTokens: 32,
      temperature: 0,
    });
    const passed = res.text.trim().length > 0;
    capabilities.contextTokens = passed ? MINIMUM_USEFUL_TOKENS : null;
    steps.push({
      id: 'context',
      label: 'Usable context',
      passed,
      latencyMs: res.latencyMs,
      detail: passed
        ? `The model handled a prompt of about ${MINIMUM_USEFUL_TOKENS.toLocaleString()} tokens.`
        : 'The model could not handle a prompt Josi routinely sends. Conversations will fail once they grow.',
    });
  } catch (err) {
    const message = err instanceof LlmError ? err.message : 'the context check failed';
    steps.push({ id: 'context', label: 'Usable context', passed: false, detail: message });
  }

  return { capabilities, steps, probedAt: now().toISOString() };
}
