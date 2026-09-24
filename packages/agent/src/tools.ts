// What Josi is allowed to do, and what it is allowed to be offered.
//
// A tool is offered only when the thing behind it actually exists. That is the
// engine's rule and it is the one that keeps the assistant honest: a model with
// a `book_appointment` tool and no calendar will promise a booking, because the
// tool's existence is the promise. Absent tool, absent promise.
import { WORKSPACE_TOOLS } from './workspaceTools.js';
import type { ToolDefinition } from '@josi-ce/llm';
import { CUSTOM_API_TOOLS } from './customApiTools.js';
import { DATA_TOOLS } from './dataTools.js';
import { WORKFLOW_TOOLS } from './workflowTools.js';
import { DEVELOPER_INTEGRATION_TOOLS, OBSIDIAN_TOOLS } from './developerIntegrationTools.js';

/** Everything the assistant can do that changes something.
 *
 * `actionClass` feeds the approval level (M33); `sensitive` feeds the step-up
 * gate. They are separate on purpose: "does the owner want to be asked about
 * this kind of work" and "is this session allowed to do something irreversible"
 * are different questions with different answers. */
export interface ToolSpec {
  def: ToolDefinition;
  /** Null for tools that only read. */
  actionClass: string | null;
  /** Requires a capability the installation may not have yet. */
  requiresCapability?: string;
}

export const TASK_TOOLS: ToolSpec[] = [
  ...WORKSPACE_TOOLS,
  { def: { name: 'get_provider_status', description: 'Read current owner-scoped connection, capability, mapped storage, index/queue and contact-sync metadata. Use for connectivity or available-file claims. Treat the receipt, observation time, account metadata and identifiers as internal grounding evidence: never show them to the person. Summarize useful status with a human-facing provider/source name. Connection status is not proof of provider reachability or indexed files.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, actionClass: null },
  {
    def: {
      name: 'create_task',
      description:
        'Start a piece of work for the user. Fill in every required slot you already know; '
        + 'if something required is missing, ask the user for it rather than guessing.',
      parameters: {
        type: 'object',
        properties: {
          template_key: { type: 'string', description: 'Which kind of work. Use list_task_types first if unsure.' },
          slots: { type: 'object', description: 'Known values for the template slots.' },
        },
        required: ['template_key'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'update_task_slots',
      description: 'Fill or correct slots on an existing task — for example when the user answers a question.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, slots: { type: 'object' } },
        required: ['task_id', 'slots'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'list_open_tasks',
      description: "List the user's own open tasks with their state and what is still missing.",
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'list_task_types',
      description: 'List the kinds of work this installation can take on, and what each one needs.',
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'approve_task',
      description: 'Approve an existing generic task that is already waiting on the user. Never use this to create a new calendar event, email, contact change, or other action; use that action\'s draft tool instead.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'cancel_task',
      description: 'The user cancels a task. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'schedule_reminder',
      description:
        'Schedule a reminder for the user. When it comes due, Josi delivers the message back to '
        + 'them in this conversation (and on Telegram if they have linked it). Give either '
        + 'in_minutes (how far from now) or due_at (an exact ISO 8601 time with timezone).',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to say when the reminder fires.' },
          calendar_event_id: { type: 'string', description: 'For a calendar-related reminder, copy the exact event_id from query_calendar. The original calendar/account source is verified and retained.' },
          in_minutes: { type: 'number', description: 'Deliver this many minutes from now. Use for "in 5 minutes".' },
          due_at: { type: 'string', description: 'Exact delivery time, ISO 8601 with explicit offset. Use for "at 3pm".' },
          timezone: { type: 'string', description: 'IANA timezone for the requested local time, such as America/Los_Angeles. Omit only when the registered device timezone should be used.' },
        },
        required: ['message'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'search_documents',
      description:
        'Use only when the user explicitly asks to search or inspect their files/documents, or clearly continues such a request. Never use for greetings, ordinary conversation, or a bare word such as "test". Search the text of documents the user has connected and indexed (mapped folders, Google '
        + 'Drive, OneDrive). Read-only. Returns matching passages with a citation for each. If '
        + 'nothing is indexed, it says so — report that honestly rather than guessing at file '
        + 'contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in plain words.' },
        },
        required: ['query'],
      },
    },
    // Reads only. Owner-scoped by construction in the executor.
    actionClass: null,
  },
  {
    def: {
      name: 'list_documents',
      description: 'Use only when the user explicitly asks about their files/documents or clearly continues such a request. Never use for greetings, ordinary conversation, or a bare word such as "test". List the user\'s own indexed and skipped documents with filenames, folder labels, states, and skip reasons. Use this when the user asks what Josi can see rather than searching for a phrase.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Maximum items, up to 100.' } },
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'update_reminder',
      description: 'Edit one scheduled reminder. Preserve its id and conversation while increasing its revision. Supply only fields the user explicitly changes.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string' },
          message: { type: 'string' },
          in_minutes: { type: 'number' },
          due_at: { type: 'string', description: 'Exact ISO 8601 instant with explicit offset.' },
          timezone: { type: 'string', description: 'IANA timezone for the requested local time.' },
        },
        required: ['reminder_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'list_reminders',
      description: "List the user's own upcoming reminders, with each one's id and delivery time.",
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'cancel_reminder',
      description: 'Cancel one of the user\'s scheduled reminders before it fires. Use list_reminders first if unsure of the id.',
      parameters: {
        type: 'object',
        properties: { reminder_id: { type: 'string' } },
        required: ['reminder_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: { name: 'draft_email', description: 'Create or continue the current email draft. Supply only facts the user gave; omitted fields are preserved only from the active email-send action in this conversation. Optional template_id or template_name renders the saved structured template; supply merge_values for name/date/time literally as the user intends. Recipient comes from the To address. Never guess missing merge values. Display the complete final summary before asking approval.', parameters: {
      type: 'object', properties: { template_id: { type: 'string', description: 'Exact owned Email Template ID. Use either ID or exact case-sensitive name, never both.' }, template_name: { type: 'string', description: 'Exact case-sensitive name; ambiguous names are refused.' }, merge_values: { type: 'object', properties: { name: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } }, additionalProperties: false }, recipient: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'array', items: { type: 'string' } } },
      required: [],
    } }, actionClass: 'email_send', requiresCapability: 'email_send',
  },
  {
    def: { name: 'draft_calendar_event', description: 'Create or continue the current calendar draft. Omitted fields are preserved only from the active calendar operation in this conversation. Use event_id only for an explicit edit/replacement; a new event remains separate.', parameters: {
      type: 'object', properties: { source_id: { type: 'string', description: 'Exact source_id from a calendar receipt.' }, calendar: {type:'string',description:'The user\'s calendar choice, such as “the main one”; the server resolves it only against primary/default metadata.'}, event_id: { type: 'string', description: 'Exact event_id receipt for an explicit edit.' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, duration_minutes: {type:'number',description:'Whole minutes supplied by the user. Use this when continuing a draft that already has a start but still needs its end.'}, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } },
      required: [],
    } }, actionClass: 'calendar_write', requiresCapability: 'calendar_write',
  },
  {
    def: { name: 'draft_contact_update', description: 'Prepare a contact creation or update for the user to approve.', parameters: {
      type: 'object', properties: { contact_id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' } }, required: ['name'],
    } }, actionClass: 'contacts_write', requiresCapability: 'contacts_write',
  },
];

/** The full catalogue: task tools, connected-data tools and the custom API
 * boundary. What a TURN offers is a subset of this, decided per person per turn
 * — the catalogue is what CAN exist, never what IS offered.
 *
 * The custom API pair is here rather than only in the per-turn list because
 * this map is what the agent loop consults before executing anything, and what
 * the MCP server intersects with a turn's offering. A tool that can be offered
 * and cannot be found is a tool the model is handed and then told does not
 * exist. */
export const ALL_TOOLS: ToolSpec[] = [
  ...TASK_TOOLS,
  ...DATA_TOOLS,
  ...CUSTOM_API_TOOLS,
  ...WORKFLOW_TOOLS,
  ...DEVELOPER_INTEGRATION_TOOLS,
  ...OBSIDIAN_TOOLS,
];

/** Names that map to the step-up gate. The gate keys on the tool name, so
 * adding a destructive tool later means adding it to SENSITIVE_ACTIONS in core
 * — not remembering to write a guard at the call site. */
export const TOOL_SPECS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.def.name, t]));
