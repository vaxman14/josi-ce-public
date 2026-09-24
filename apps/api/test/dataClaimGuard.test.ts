// Data claims require receipts too — item 41b, in the real turn loop.
//
// packages/agent/test/dataClaimGuard.test.ts covers the pure detector.
// This file is the loop-level counterpart to apps/api/test/claimGuard.test.ts:
// real search_documents/list_documents execution against the real schema,
// a scripted model, and the actual runAssistantTurn re-prompt/replace path —
// proving the guard fires inside a real turn, not just against a synthetic
// receipt.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { MasterKey, createThread, seal } from '@josi-ce/core';
import {
  DATA_CLAIM_GUARD_FALLBACK, NARRATED_SEARCH_GUARD_FALLBACK, runAssistantTurn,
} from '@josi-ce/agent';

let db: TestDb;
let userId: string;
let threadId: string;
let mappingId: string;
const KEY = new MasterKey(Buffer.alloc(32, 7));

beforeEach(async () => {
  db = await testDb();
  userId = (await createUser(db, { email: 'g2@ce.test', username: 'data-guard-owner', role: 'super_admin' })).id;
  threadId = (await createThread(db, { ownerUserId: userId })).id;
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,
    [seal(KEY, { apiKey: 'k' })],
  );
  const [root] = await db.query<{ id: string }>(
    `insert into storage_roots (container_path, label) values ('/data/roots/docs', 'Docs') returning id`,
  );
  const [mapping] = await db.query<{ id: string }>(
    `insert into folder_mappings (owner_user_id, provider, root_id, display_path)
     values ($1, 'local', $2, 'Docs') returning id`,
    [userId, root.id],
  );
  mappingId = mapping.id;
});

/** Seeds one real indexed document with real full-text search content — the
 * exact path search_documents reads, so the tool call in these tests returns
 * genuine hits rather than a stubbed shape. */
async function addDoc(args: { filename: string; text: string }): Promise<string> {
  const [doc] = await db.query<{ id: string }>(
    `insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
     values ($1, $2, $3, $3, 'indexed') returning id`,
    [mappingId, userId, args.filename],
  );
  await db.query(
    `insert into document_text (document_id, owner_user_id, content, char_count)
     values ($1, $2, $3, $4)`,
    [doc.id, userId, args.text, args.text.length],
  );
  await db.query(
    `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
     values ($1, $2, 0, 'page', '1', $3)`,
    [doc.id, userId, args.text],
  );
  return doc.id;
}

/** A provider that answers with a scripted sequence and records what it saw.
 * Same shape as claimGuard.test.ts's helper — kept local rather than shared
 * so each suite can evolve its scripts independently. */
function scripted(replies: Array<{ content?: string; tool_calls?: unknown[] }>) {
  const seen: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    const next = replies.shift() ?? { content: 'ok' };
    return new Response(
      JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const registry = (fetchImpl: typeof fetch) =>
  ({ db, masterKey: KEY, fetchImpl, resolve: async () => ['203.0.113.5'] });

const turn = (fetchImpl: typeof fetch, inbound = 'what documents do I have?') =>
  runAssistantTurn({ db, registry: registry(fetchImpl), userId, threadId, history: [], inbound });

/** A real search_documents tool call, formatted the way an OpenAI-shaped
 * provider actually sends one. */
function searchDocumentsCall(query = 'lease') {
  return {
    id: 'c1', type: 'function',
    function: { name: 'search_documents', arguments: JSON.stringify({ query }) },
  };
}

function listDocumentsCall() {
  return {
    id: 'c1', type: 'function',
    function: { name: 'list_documents', arguments: JSON.stringify({}) },
  };
}

describe('data claims require receipts — in the real turn loop', () => {
  it('(a) a reply that correctly quotes real search_documents results passes untouched', async () => {
    await addDoc({ filename: 'Lease Agreement.pdf', text: 'the tenant shall pay rent on the first of the month' });
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [searchDocumentsCall('rent')],
      },
      { content: 'I found one match: Lease Agreement.pdf, about paying rent.' },
    ]);
    const result = await turn(fetchImpl, 'do I have anything about rent?');
    expect(result.reply).toBe('I found one match: Lease Agreement.pdf, about paying rent.');
    expect(result.actions.map((a) => a.tool)).toContain('search_documents');
    // No corrective third call — the guard never fired.
    expect(seen).toHaveLength(2);
  });

  it('(a) a reply that correctly quotes list_documents results and its real count passes untouched', async () => {
    await addDoc({ filename: 'Invoice.pdf', text: 'total due 450.00' });
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [listDocumentsCall()],
      },
      { content: 'You have 1 indexed document: Invoice.pdf.' },
    ]);
    const result = await turn(fetchImpl, 'what do you see?');
    expect(result.reply).toBe('You have 1 indexed document: Invoice.pdf.');
    expect(seen).toHaveLength(2);
  });

  it('(b) a reply that invents a filename not in the tool result triggers the guard and produces a corrected reply', async () => {
    await addDoc({ filename: 'Lease Agreement.pdf', text: 'the tenant shall pay rent on the first of the month' });
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [searchDocumentsCall('rent')],
      },
      // The exact failure shape from item 33: a plausible-sounding filename
      // that was never in the real result.
      { content: 'I found Crystal Rodriguez.pdf and AmeriEstate ebook.pdf about your rent.' },
      // The corrective hop: the model restates using only the real result.
      { content: 'I found one match: Lease Agreement.pdf, about paying rent.' },
    ]);
    const result = await turn(fetchImpl, 'do I have anything about rent?');
    expect(result.reply).toBe('I found one match: Lease Agreement.pdf, about paying rent.');
    // Three model calls: the tool call, the fabrication, the corrected retry.
    expect(seen).toHaveLength(3);
    const reprompt = seen[2].messages.at(-1);
    expect(reprompt?.role).toBe('user');
    expect(reprompt?.content).toMatch(/do not match what the tool actually returned/);
  });

  it('(b) replaces the reply outright when the model fabricates a filename twice', async () => {
    await addDoc({ filename: 'Lease Agreement.pdf', text: 'the tenant shall pay rent on the first of the month' });
    const { fetchImpl } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [searchDocumentsCall('rent')],
      },
      { content: 'I found Crystal Rodriguez.pdf about your rent.' },
      { content: 'Also see temp_EG.txt for more on rent.' }, // doubles down with a DIFFERENT fabrication
    ]);
    const result = await turn(fetchImpl, 'do I have anything about rent?');
    expect(result.reply).toBe(DATA_CLAIM_GUARD_FALLBACK);
    const events = await db.query<{ kind: string }>(
      `select kind from events where kind = 'agent.data_claim_without_receipt'`,
    );
    expect(events).toHaveLength(1);
  });

  it('(c) a reply that states a count contradicting the tool result\'s actual length triggers the guard', async () => {
    await addDoc({ filename: 'Invoice.pdf', text: 'total due 450.00' });
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [listDocumentsCall()],
      },
      // The item-41 shape: a count that does not match what the tool actually
      // returned (1 real document, claimed as 38).
      { content: 'You have 38 indexed documents.' },
      { content: 'You have 1 indexed document: Invoice.pdf.' },
    ]);
    const result = await turn(fetchImpl, 'how many documents are indexed?');
    expect(result.reply).toBe('You have 1 indexed document: Invoice.pdf.');
    expect(seen).toHaveLength(3);
  });

  it('(d) the guard does not false-positive on a turn with no data-returning tool call', async () => {
    const { fetchImpl, seen } = scripted([
      { content: 'I can help you look through your documents — what are you looking for?' },
    ]);
    const result = await turn(fetchImpl, 'hi');
    expect(result.reply).toMatch(/what are you looking for/);
    expect(seen).toHaveLength(1); // no corrective second call
  });

  it('(d) does not false-positive on a turn whose only tool call was a task/reminder tool', async () => {
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'schedule_reminder', arguments: JSON.stringify({ message: 'call', in_minutes: 5 }) },
        }],
      },
      { content: 'Done — reminder set, it fires in 5 minutes.' },
    ]);
    const result = await turn(fetchImpl, 'remind me to call in 5 minutes');
    // The ACTION guard (item 12) correctly lets this through — a real tool
    // ran. The DATA guard must not pile on: schedule_reminder is not in its
    // vocabulary, so it has nothing to check and stays silent.
    expect(result.reply).toMatch(/Done — reminder set/);
    expect(seen).toHaveLength(2); // no data-claim-guard third call
  });

  it('an honest empty report against a real empty result passes untouched', async () => {
    // No documents seeded at all — the real search_documents path returns
    // hits: [] with the "no documents indexed yet" message.
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [searchDocumentsCall('anything')],
      },
      { content: 'No documents are indexed yet. Connect a folder on the Connections page first.' },
    ]);
    const result = await turn(fetchImpl, 'do you see any documents?');
    expect(result.reply).toMatch(/No documents are indexed yet/);
    expect(seen).toHaveLength(2);
  });
});

// The 2026-09-04 04:54 UTC incident, reproduced against the REAL turn loop:
// a one-word ambiguous message ("Test") gets a reply that narrates running a
// search and reports specific invented results — with ZERO tool calls in the
// turn at all. Before the fix: checkDataClaims is never even called (its call
// site in assistantAgent.ts is gated on `dataReceipts.length`), so this reply
// reaches the person completely unchecked. After the fix: the new
// checkNarratedSearchWithoutTool guard fires on the narration itself.
describe('narrated search with ZERO tool calls — in the real turn loop (2026-09-04 incident)', () => {
  it('catches the exact incident shape: "Test" in, a fabricated confident search-result reply out, no tool call at all', async () => {
    // No documents seeded — doesn't matter, because the point is NO TOOL RUNS
    // this turn. The model just free-writes a plausible-sounding "search
    // result" directly, the way the real incident's `meta: {}` + 6ms gap
    // proved happened live.
    const { fetchImpl, seen } = scripted([
      {
        // No tool_calls at all — this is the whole bug: the model never even
        // tried to call search_documents/list_documents.
        content: "Search for 'test' returned eight passages across six files: "
          + 'ResumeMartinVu.pdf, Plan-Comparison.csv, LinkedIn_Employer_Brand_Playbook.pdf and three others.',
      },
      // The corrective hop: given the honest choice (search for real, or say
      // it hasn't), the scripted model restates honestly this time.
      { content: 'I have not searched your documents for "test" — ask me again and I will.' },
    ]);
    const result = await turn(fetchImpl, 'Test');
    expect(result.reply).toMatch(/have not searched/);
    expect(result.actions).toHaveLength(0); // never claims a tool ran, because none did
    // Two model calls: the fabrication, then the corrective re-prompt hop.
    expect(seen).toHaveLength(2);
    const reprompt = seen[1].messages.at(-1);
    expect(reprompt?.role).toBe('user');
    expect(reprompt?.content).toMatch(/did not call any tool this turn/);
  });

  it('replaces the reply outright when the model fabricates search results twice with no tool call', async () => {
    const { fetchImpl } = scripted([
      { content: "Search for 'test' returned eight passages across six files." },
      // Doubles down on the SAME fabrication pattern with a different tool call story.
      { content: 'I checked your documents and found 3 matching files about test.' },
    ]);
    const result = await turn(fetchImpl, 'Test');
    expect(result.reply).toBe(NARRATED_SEARCH_GUARD_FALLBACK);
    const events = await db.query<{ kind: string }>(
      `select kind from events where kind = 'agent.narrated_search_without_tool'`,
    );
    expect(events).toHaveLength(1);
  });

  it('does NOT fire when the model actually calls search_documents for real, even against an ambiguous "Test" message', async () => {
    await addDoc({ filename: 'Notes.pdf', text: 'this is a test document about testing' });
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [searchDocumentsCall('test')],
      },
      { content: 'I found one match: Notes.pdf, about testing.' },
    ]);
    const result = await turn(fetchImpl, 'Test');
    expect(result.reply).toBe('I found one match: Notes.pdf, about testing.');
    expect(result.actions.map((a) => a.tool)).toContain('search_documents');
    expect(seen).toHaveLength(2); // real tool call + real answer, no guard hop needed
  });

  it('does NOT fire on an ordinary reply to "Test" that never claims to have searched anything', async () => {
    const { fetchImpl, seen } = scripted([
      { content: 'Test received. What would you like help with?' },
    ]);
    const result = await turn(fetchImpl, 'Test');
    expect(result.reply).toBe('Test received. What would you like help with?');
    expect(seen).toHaveLength(1); // no corrective hop — nothing to correct
  });
});
