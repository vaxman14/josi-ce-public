import type { Db } from '@josi-ce/core';

/** A retry is an exact, typed read invocation, never a guess recovered from
 * conversation prose. This object is small enough to live in messages.meta. */
export interface AssistantRetryTarget {
  version: 1;
  kind: 'read_tool';
  domain: 'workspace' | 'provider' | 'email' | 'calendar' | 'contacts' | 'documents' | 'tasks' | 'reminders' | 'developer';
  tool: string;
  input: Record<string, unknown>;
}

const READ_DOMAINS: Readonly<Record<string, AssistantRetryTarget['domain']>> = {
  list_workspace_mappings: 'workspace',
  workspace_list: 'workspace',
  workspace_read: 'workspace',
  workspace_code_status: 'workspace',
  get_provider_status: 'provider',
  check_email_availability: 'email',
  search_email: 'email',
  read_email: 'email',
  query_calendar: 'calendar',
  get_event: 'calendar',
  search_contacts: 'contacts',
  search_documents: 'documents',
  list_documents: 'documents',
  list_open_tasks: 'tasks',
  list_task_types: 'tasks',
  list_reminders: 'reminders',
  list_obsidian_vaults: 'developer',
  read_obsidian_note: 'developer',
  list_native_resources: 'developer',
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Return metadata only for fixed, owner-scoped, repeatable reads. A status
 * call with cancel=true is a mutation and is deliberately excluded. */
export function retryTargetFor(tool: string, input: Record<string, unknown>): AssistantRetryTarget | undefined {
  const domain = READ_DOMAINS[tool];
  if (!domain) return undefined;
  if (tool === 'workspace_code_status' && input.cancel === true) return undefined;
  return { version: 1, kind: 'read_tool', domain, tool, input: structuredClone(input) };
}

/** Validate persisted metadata against the same closed read-only catalogue.
 * The database is not treated as authority to introduce a new retryable tool. */
export function parseRetryTarget(value: unknown): AssistantRetryTarget | undefined {
  if (!plainRecord(value) || value.version !== 1 || value.kind !== 'read_tool'
    || typeof value.tool !== 'string' || !plainRecord(value.input)) return undefined;
  const target = retryTargetFor(value.tool, value.input);
  return target && target.domain === value.domain ? target : undefined;
}

export async function immediatelyPrecedingRetryTarget(
  db: Db,
  args: { ownerUserId: string; threadId: string; currentInboundMessageId?: string | null },
): Promise<AssistantRetryTarget | undefined> {
  const [message] = await db.query<{ direction: 'in' | 'out'; meta: Record<string, unknown> }>(
    `select m.direction,m.meta from messages m
       join threads t on t.id = m.thread_id
      where m.thread_id = $1 and t.owner_user_id = $2
        and ($3::uuid is null or m.id <> $3::uuid)
      order by m.created_at desc, m.id desc limit 1`,
    [args.threadId, args.ownerUserId, args.currentInboundMessageId ?? null],
  );
  if (message?.direction !== 'out') return undefined;
  return parseRetryTarget(message?.meta?.retry);
}

export const GENERIC_RETRY = /^(?:retry|try again|retry that|try that again)\s*[.!?]?$/i;

export function retryReply(target: AssistantRetryTarget, result: unknown): string {
  const record = plainRecord(result) ? result : {};
  if (record.ok === false || record.error) {
    const label = target.domain === 'workspace' ? 'workspace status/discovery check' : `${target.domain} read`;
    return `The ${label} failed again. Tell me if you want to try something else.`;
  }
  if (target.tool === 'list_workspace_mappings') {
    const count = Array.isArray(record.mappings) ? record.mappings.length : 0;
    return `I retried workspace discovery. Found ${count} authorized workspace mapping${count === 1 ? '' : 's'}.`;
  }
  if (target.tool === 'get_provider_status') return 'I retried the provider status check.';
  return `I retried the exact ${target.domain} read.`;
}
