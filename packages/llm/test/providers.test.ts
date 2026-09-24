// The two adapters and the capability probe, against stubbed provider HTTP.
// No live provider is contacted anywhere in this suite.
import { describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from '../src/providers/anthropic.js';
import { openAiCompatibleProvider } from '../src/providers/openaiCompatible.js';
import { probeProvider } from '../src/probe.js';
import { LlmError, disabledFeatures, featureAvailable, type LlmProvider } from '../src/types.js';

const resolve = async () => ['1.1.1.1'];
const localResolve = async () => ['127.0.0.1'];

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return (async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(String(url), init ?? {})) as unknown as typeof fetch;
}

const oaiReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the OpenAI-shaped adapter', () => {
  it('normalises a plain reply and its token usage', async () => {
    const provider = openAiCompatibleProvider({
      kind: 'openai', model: 'gpt-test', apiKey: 'k', external: true, resolve,
      fetchImpl: stubFetch(() => oaiReply({
        choices: [{ message: { content: 'hello there' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      })),
    });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('hello there');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('normalises tool calls, including malformed arguments', async () => {
    const provider = openAiCompatibleProvider({
      kind: 'openai', model: 'gpt-test', apiKey: 'k', external: true, resolve,
      fetchImpl: stubFetch(() => oaiReply({
        choices: [{ message: { tool_calls: [
          { id: 'a', function: { name: 'record_number', arguments: '{"value":7}' } },
          { id: 'b', function: { name: 'broken', arguments: 'not json' } },
        ] } }],
      })),
    });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(res.toolCalls[0]).toMatchObject({ name: 'record_number', input: { value: 7 } });
    // A model emitting invalid arguments has still attempted the call; the name
    // survives so the probe can see it, with empty input rather than a crash.
    expect(res.toolCalls[1]).toMatchObject({ name: 'broken', input: {} });
  });

  it('sends no Authorization header when a self-hosted endpoint has no key', async () => {
    let seen: RequestInit = {};
    const provider = openAiCompatibleProvider({
      kind: 'openai_compatible', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1',
      external: false, resolve: localResolve,
      fetchImpl: stubFetch((_u, init) => { seen = init; return oaiReply({ choices: [{ message: { content: 'ok' } }] }); }),
    });
    await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    // Some local runtimes reject an empty bearer outright.
    expect((seen.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('classifies failures without repeating the provider text', async () => {
    const cases: Array<[number, Partial<LlmError>]> = [
      [401, { needsReconfiguration: true }],
      [403, { needsReconfiguration: true }],
      [429, { retryable: true }],
      [500, { retryable: true }],
      [400, {}],
    ];
    for (const [status, expected] of cases) {
      const provider = openAiCompatibleProvider({
        kind: 'openai', model: 'm', apiKey: 'k', external: true, resolve,
        fetchImpl: stubFetch(() => oaiReply({ error: { message: 'your prompt was: SECRET-PROMPT-TEXT' } }, status)),
      });
      await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] }), String(status))
        .rejects.toMatchObject(expected);
      // The provider echoes request content in errors; none of it may surface.
      await provider.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e: LlmError) => {
        expect(e.message).not.toContain('SECRET-PROMPT-TEXT');
      });
    }
  });

  it('treats a 200 that is not JSON as a contract break', async () => {
    const provider = openAiCompatibleProvider({
      kind: 'openai', model: 'm', apiKey: 'k', external: true, resolve,
      fetchImpl: stubFetch(() => new Response('<html>proxy error</html>', { status: 200 })),
    });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/not valid JSON/);
  });

  it('turns an unsafe endpoint into a reconfiguration error', async () => {
    const provider = openAiCompatibleProvider({
      kind: 'openai_compatible', model: 'm', baseUrl: 'http://169.254.169.254/v1', external: false,
      resolve: async () => ['169.254.169.254'],
      fetchImpl: stubFetch(() => oaiReply({})),
    });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ needsReconfiguration: true });
  });
});

describe('the Anthropic adapter', () => {
  it('lifts system out of the message list and reads content blocks', async () => {
    let body: any;
    const provider = anthropicProvider({
      model: 'claude-test', apiKey: 'k', resolve,
      fetchImpl: stubFetch((_u, init) => {
        body = JSON.parse(String(init.body));
        return oaiReply({
          content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'record_number', input: { value: 7 } }],
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      }),
    });
    const res = await provider.chat({ system: 'be brief', messages: [{ role: 'user', content: 'x' }] });
    expect(body.system).toBe('be brief');
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
    expect(res.text).toBe('hi');
    expect(res.toolCalls[0]).toMatchObject({ name: 'record_number', input: { value: 7 } });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('pins the API version header', async () => {
    let headers: Record<string, string> = {};
    const provider = anthropicProvider({
      model: 'claude-test', apiKey: 'k', resolve,
      fetchImpl: stubFetch((_u, init) => { headers = init.headers as Record<string, string>; return oaiReply({ content: [] }); }),
    });
    await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe('k');
  });

  it('asks for JSON in the system prompt, since there is no response_format', async () => {
    let body: any;
    const provider = anthropicProvider({
      model: 'claude-test', apiKey: 'k', resolve,
      fetchImpl: stubFetch((_u, init) => { body = JSON.parse(String(init.body)); return oaiReply({ content: [] }); }),
    });
    await provider.chat({ messages: [{ role: 'user', content: 'x' }], jsonMode: true });
    expect(body.system).toMatch(/valid JSON object/i);
    expect(body.response_format).toBeUndefined();
  });
});

// ------------------------------------------------------------------- probe

/** A model that behaves however the test says, so each capability can be
 * failed independently. */
function fakeModel(behaviour: {
  chat?: boolean; json?: boolean | 'prose' | 'fenced'; tools?: boolean; context?: boolean;
  image?: boolean; throwOn?: string;
}): LlmProvider {
  return {
    kind: 'openai_compatible', model: 'fake', external: false,
    async chat(request) {
      const content = request.messages.map((m) => m.content).join(' ');
      const isJson = request.jsonMode;
      const isTools = !!request.tools?.length;
      const isImage = request.messages.some((m) => m.images?.length);
      const isContext = !isImage && content.length > 5000;

      if (behaviour.throwOn === 'chat' && !isJson && !isTools && !isImage && !isContext) {
        throw new LlmError('the model provider rejected the API key', { needsReconfiguration: true });
      }
      if (isTools) {
        return {
          text: '', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: behaviour.tools ? [{ id: 'a', name: 'record_number', input: { value: 7 } }] : [],
        };
      }
      if (isImage) {
        return {
          text: behaviour.image ? 'Red' : 'I cannot tell', latencyMs: 1, toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (isJson) {
        const text = behaviour.json === true ? '{"ok":true}'
          : behaviour.json === 'fenced' ? '```json\n{"ok":true}\n```'
          : 'Sure! Here is your answer.';
        return { text, latencyMs: 1, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (isContext) {
        return {
          text: behaviour.context === false ? '' : 'ok',
          latencyMs: 1, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        text: behaviour.chat === false ? '' : 'ready',
        latencyMs: 1, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe('the capability probe', () => {
  it('records what a fully capable model does', async () => {
    const result = await probeProvider(fakeModel({ chat: true, json: true, tools: true, context: true, image: true }));
    expect(result.capabilities).toMatchObject({ chat: true, structuredOutput: true, toolCalling: true, vision: true });
    expect(result.capabilities.contextTokens).toBeGreaterThan(0);
    expect(result.steps).toHaveLength(5);
    expect(result.fatal).toBeUndefined();
  });

  it('stops after chat fails, rather than reporting three more failures', async () => {
    const result = await probeProvider(fakeModel({ throwOn: 'chat' }));
    expect(result.capabilities.chat).toBe(false);
    expect(result.fatal).toBeTruthy();
    expect(result.steps).toHaveLength(1);
  });

  it('judges structured output by parsing the reply, not by the request being accepted', async () => {
    const prose = await probeProvider(fakeModel({ json: 'prose', tools: true }));
    expect(prose.capabilities.structuredOutput).toBe(false);
    // A fenced block is what models actually return; it counts.
    const fenced = await probeProvider(fakeModel({ json: 'fenced', tools: true }));
    expect(fenced.capabilities.structuredOutput).toBe(true);
  });

  it('records tool calling only when a tool call actually came back', async () => {
    const without = await probeProvider(fakeModel({ json: true, tools: false }));
    expect(without.capabilities.toolCalling).toBe(false);
    expect(without.steps.find((s) => s.id === 'toolCalling')?.detail).toMatch(/calendar, email/i);
  });

  it('never infers a capability from the model name', async () => {
    // A model called "gpt-4o-with-tools" that does not call tools is recorded
    // as not calling tools.
    const provider = { ...fakeModel({ json: true, tools: false }), model: 'gpt-4o-with-tools-and-json' };
    const result = await probeProvider(provider);
    expect(result.capabilities.toolCalling).toBe(false);
    expect(result.capabilities.structuredOutput).toBe(true);
  });

  it('records vision only when the model actually answered a question about the test image', async () => {
    const withImage = await probeProvider(fakeModel({ json: true, tools: true, image: true }));
    expect(withImage.capabilities.vision).toBe(true);
    const withoutImage = await probeProvider(fakeModel({ json: true, tools: true, image: false }));
    expect(withoutImage.capabilities.vision).toBe(false);
    expect(withoutImage.steps.find((s) => s.id === 'vision')?.detail).toMatch(/will not describe/i);
  });

  it('an adapter that ignores the images field entirely fails the vision step honestly', async () => {
    // Simulates the OpenAI-compatible adapter and both CLI harnesses today:
    // no code path reads `ChatMessage.images`, so the model never sees the
    // picture and cannot answer correctly by chance.
    const blind: LlmProvider = {
      kind: 'openai_compatible', model: 'blind', external: false,
      async chat() {
        return { text: 'ready', latencyMs: 1, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await probeProvider(blind);
    expect(result.capabilities.vision).toBe(false);
  });
});

describe('feature gating', () => {
  it('disables everything when no probe has run', () => {
    const disabled = disabledFeatures(null);
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.every((d) => /no model has been tested/i.test(d.reason))).toBe(true);
    expect(featureAvailable('assistant_chat', null)).toBe(false);
  });

  it('disables exactly the tool-dependent features when tool calling is missing', () => {
    const caps = { chat: true, structuredOutput: true, toolCalling: false, vision: true, contextTokens: 8000 };
    const disabled = disabledFeatures(caps).map((d) => d.feature).sort();
    expect(disabled).toEqual(['calendar_tools', 'document_search', 'email_tools']);
    expect(featureAvailable('assistant_chat', caps)).toBe(true);
    expect(featureAvailable('calendar_tools', caps)).toBe(false);
  });

  it('disables task extraction when structured output is missing', () => {
    const caps = { chat: true, structuredOutput: false, toolCalling: true, vision: true, contextTokens: 8000 };
    expect(featureAvailable('task_extraction', caps)).toBe(false);
    expect(disabledFeatures(caps).find((d) => d.feature === 'task_extraction')?.reason).toMatch(/JSON/);
  });

  it('gives every disabled feature a reason a human can act on', () => {
    const caps = { chat: true, structuredOutput: false, toolCalling: false, vision: false, contextTokens: null };
    for (const d of disabledFeatures(caps)) {
      expect(d.reason.length).toBeGreaterThan(20);
      expect(d.reason).toMatch(/model/i);
    }
  });

  it('disables chat_vision when vision is missing, and nothing else', () => {
    const caps = { chat: true, structuredOutput: true, toolCalling: true, vision: false, contextTokens: 8000 };
    const disabled = disabledFeatures(caps).map((d) => d.feature);
    expect(disabled).toEqual(['chat_vision']);
    expect(featureAvailable('chat_vision', caps)).toBe(false);
  });
});
