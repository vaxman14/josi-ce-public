// The assistant's window onto custom API connections.
//
// THE SHAPE OF THE BOUNDARY, because it is the whole security argument
//
// The model gets exactly two tools, and neither of them is "make an HTTP
// request". It names a CONNECTION and an ACTION, both of which are looked up in
// the administrator's allowlist; everything else about the request — the host,
// the scheme, the method, the path, the headers, the credential — comes from
// the row that lookup found. There is no argument anywhere in this file that
// the model could fill with a URL.
//
// Three separate gates stand between a model deciding something and it
// happening, and they are enforced in three different places on purpose:
//
//   1. OFFERING. A tool appears only when at least one enabled endpoint under
//      an enabled connection exists (`customApiToolAvailability`). Absent tool,
//      absent promise.
//   2. RESOLUTION. Execution re-resolves the action against the SAME enabled
//      set at call time (`resolveCustomApiAction`). A connection switched off
//      mid-conversation refuses, even though the tool was offered when the turn
//      began. The offering is never the authority.
//   3. APPROVAL. A read runs. A write or a delete becomes a pending request its
//      owner has to agree to, showing exactly what would be sent. The model
//      cannot opt out of this, because it is decided from the endpoint's
//      `capability` column, which the database ties to the HTTP method.
//
// WHOSE REQUEST IT IS. The connection is installation-wide; every call made
// through it is made FOR one person, and a pending approval is visible only to
// them. An administrator configures the pipe and does not get to see what
// somebody sent through it.
import type { Db, MasterKey } from '@josi-ce/core';
import {
  CustomApiError, CustomApiInputError,
  availableCustomApiActions, buildCustomApiRequest, categoryForCustomApiStatus, customApiFetch,
  customApiSentence, describeCustomApiCall, openCustomApiCredentials, recordCustomApiCheck,
  requestCustomApiCall, resolveCustomApiAction,
  type AvailableCustomApiAction, type CustomApiFetchOptions,
} from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';

/** How the executor reaches sealed credentials and the network. The same shape
 * the connected-data tools use, so one context serves both and a tool called
 * without it refuses rather than crashing. */
export interface CustomApiAccess {
  masterKey: () => MasterKey;
  customApiFetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}

/** How many actions are named inline in the tool description before the model
 * is pointed at `list_custom_api_actions` instead. A description carrying two
 * hundred lines of allowlist is a system prompt nobody can afford. */
const INLINE_ACTION_LIMIT = 25;

/** What `call_custom_api` is, said the same way whether or not anything is
 * configured. The live allowlist is appended to this per turn. */
const CALL_TOOL_DESCRIPTION_BASE =
  'Run one of the specific, pre-approved actions on a connected API. You can only choose from the '
  + 'allowed list — you cannot supply a web address, a method or a header, and there is no action '
  + 'that is not on the list. Call list_custom_api_actions if you are unsure what is available. '
  + 'Actions that change or delete something do NOT run when you call them: the user is shown '
  + 'exactly what would be sent and decides. Tell them it is waiting for them; never say it has '
  + 'been done.';

/** One line of the inline allowlist. The approval marker is part of the line
 * rather than a separate list, so a model reading it cannot pick up an action
 * name without also reading what calling it does. */
function actionLine(action: AvailableCustomApiAction): string {
  const { connection, endpoint } = action;
  const needsApproval = endpoint.capability === 'read' ? '' : ' [needs the user to approve first]';
  return `${connection.slug}.${endpoint.operation_id} — ${endpoint.summary}${needsApproval}`;
}

/**
 * The two tool definitions, as they exist in the catalogue.
 *
 * They are STATIC and live in `ALL_TOOLS` for two reasons that both bite if
 * they are not:
 *
 *   * `TOOL_SPECS_BY_NAME` is what the agent loop consults before executing a
 *     call at all. A tool offered from a dynamically built list and absent from
 *     the catalogue is a tool the model can be handed and then told does not
 *     exist.
 *   * The MCP server offers a subscription CLI's own agent loop exactly the
 *     tools that appear in both the turn's offering AND the catalogue. Without
 *     an entry here, an installation using a ChatGPT or Claude plan would
 *     silently lack this feature while every screen said it was configured.
 *
 * `customApiToolAvailability` returns COPIES with the live allowlist spliced
 * into the description. The catalogue entry is what may exist; the copy is what
 * this turn actually promises.
 */
export const CUSTOM_API_TOOLS: ToolSpec[] = [
  {
    def: {
      name: 'list_custom_api_actions',
      description:
        'List the exact actions an administrator has allowed on this installation\'s connected '
        + 'APIs, with the parameters each one takes. Read-only and makes no request to any API. '
        + 'Use it when you are unsure of an action id or what it needs.',
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'call_custom_api',
      description: CALL_TOOL_DESCRIPTION_BASE,
      parameters: {
        type: 'object',
        properties: {
          connection: {
            type: 'string',
            description: 'Which connected API, by the short name list_custom_api_actions gives.',
          },
          operation: {
            type: 'string',
            description: 'Which action, exactly as named in the list. Not a path and not a URL.',
          },
          arguments: {
            type: 'object',
            description:
              'Values for the parameters this action declares, by name. Anything not declared is '
              + 'ignored.',
          },
          body: {
            type: 'object',
            description:
              'The details to send, for actions that take a body. Ignored by actions that do not.',
          },
        },
        required: ['connection', 'operation'],
      },
    },
    // No action class. The approval decision here does NOT come from the
    // per-user approval level — it comes from the endpoint's `capability`
    // column, which the database ties to the HTTP method. A user preference
    // that could make a delete automatic is exactly what this feature must not
    // have.
    actionClass: null,
  },
];

const CUSTOM_API_TOOL_NAMES = new Set(CUSTOM_API_TOOLS.map((t) => t.def.name));

export function isCustomApiTool(name: string): boolean {
  return CUSTOM_API_TOOL_NAMES.has(name);
}

export interface CustomApiAvailability {
  /** Specs to offer this turn. Empty when nothing is switched on. */
  specs: ToolSpec[];
  /** For the system prompt: what the assistant can honestly claim exists. */
  connectionNames: string[];
}

/**
 * Which custom API actions are switched on RIGHT NOW.
 *
 * Called once per turn. Nothing is cached: a connection an administrator turned
 * off between two messages is gone from the next list, and execution checks
 * again anyway.
 */
export async function customApiToolAvailability(db: Db): Promise<CustomApiAvailability> {
  const actions = await availableCustomApiActions(db);
  if (!actions.length) return { specs: [], connectionNames: [] };

  const names = [...new Set(actions.map((a) => a.connection.name))];
  const shown = actions.slice(0, INLINE_ACTION_LIMIT).map(actionLine);
  const catalogue = shown.join('; ')
    + (actions.length > shown.length
      ? `; and ${actions.length - shown.length} more — call list_custom_api_actions to see them`
      : '');
  const slugs = [...new Set(actions.map((a) => a.connection.slug))].join(', ');

  const specs = CUSTOM_API_TOOLS.map((spec) => {
    if (spec.def.name !== 'call_custom_api') return spec;
    return {
      ...spec,
      def: {
        ...spec.def,
        description: `${CALL_TOOL_DESCRIPTION_BASE} Available: ${catalogue}`,
        parameters: {
          ...spec.def.parameters,
          properties: {
            ...(spec.def.parameters.properties as Record<string, unknown>),
            connection: { type: 'string', description: `Which connected API. One of: ${slugs}.` },
          },
        },
      },
    } as ToolSpec;
  });

  return { specs, connectionNames: names };
}

// ---------------------------------------------------------------- execution

const NO_ACCESS = {
  ok: false,
  error: 'unavailable',
  message: 'Connected APIs cannot be reached right now. Tell the user so rather than guessing at a result.',
};

/** Runs one custom API tool. The caller has already matched the name against
 * `isCustomApiTool`; anything else does not belong here. */
export async function executeCustomApiTool(
  db: Db,
  ctx: { userId: string; threadId: string | null; access: CustomApiAccess | null },
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'list_custom_api_actions') return listActions(db);
  if (name !== 'call_custom_api') {
    return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  }
  return callAction(db, ctx, input);
}

async function listActions(db: Db): Promise<unknown> {
  const actions = await availableCustomApiActions(db);
  return {
    ok: true,
    actions: actions.map(({ connection, endpoint }) => ({
      connection: connection.slug,
      connection_name: connection.name,
      operation: endpoint.operation_id,
      what_it_does: endpoint.summary,
      // Named in the model's own vocabulary rather than as an HTTP method, so
      // it cannot mistake PATCH for something harmless.
      kind: endpoint.capability === 'read' ? 'read' : endpoint.capability,
      needs_user_approval: endpoint.capability !== 'read',
      parameters: (endpoint.parameters ?? []).map((p) => ({
        name: p.name, required: p.required, description: p.description,
      })),
      takes_body: endpoint.accepts_body,
    })),
    ...(actions.length ? {} : {
      message: 'No connected API actions are switched on. An administrator sets these up under '
        + 'Custom API in the admin section. Say so plainly rather than describing what one might do.',
    }),
  };
}

async function callAction(
  db: Db,
  ctx: { userId: string; threadId: string | null; access: CustomApiAccess | null },
  input: Record<string, unknown>,
): Promise<unknown> {
  const slug = String(input.connection ?? '').trim().toLowerCase();
  const operationId = String(input.operation ?? '').trim().toLowerCase();
  if (!slug || !operationId) {
    return {
      ok: false, error: 'bad_request',
      message: 'Name both the connection and the action, exactly as list_custom_api_actions gives them.',
    };
  }

  // Re-resolved NOW against the enabled set. This is gate 2, and it is the one
  // that makes an administrator's switch take effect mid-conversation.
  const action = await resolveCustomApiAction(db, { slug, operationId });
  if (!action) {
    return {
      ok: false, error: 'not_found',
      message: `There is no allowed action called "${operationId}" on "${slug}". Use `
        + 'list_custom_api_actions and choose one from it. There is no way to call anything else.',
    };
  }
  if (!ctx.access) return NO_ACCESS;

  const { connection, endpoint } = action;
  const args = (input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
    ? input.arguments
    : {}) as Record<string, unknown>;

  let request;
  try {
    request = buildCustomApiRequest({ connection, endpoint, arguments: args, body: input.body });
  } catch (err) {
    if (err instanceof CustomApiInputError || err instanceof CustomApiError) {
      // A refusal the model can act on: fix the arguments and try again. Never
      // a stack trace and never anything derived from the credential.
      return { ok: false, error: 'bad_arguments', message: err.message };
    }
    throw err;
  }

  // Gate 3. A write or a delete stops here, every time, for everybody. There is
  // no preference, no admin setting and no argument that skips it.
  if (endpoint.capability !== 'read') {
    const summary = describeCustomApiCall({
      connection, endpoint, arguments: args, hasBody: request.body !== null,
    });
    const pending = await requestCustomApiCall(db, ctx.access.masterKey(), {
      ownerUserId: ctx.userId,
      threadId: ctx.threadId,
      connection,
      endpoint,
      request,
      summary,
    });
    return {
      ok: false,
      error: 'needs_approval',
      approval_id: pending.id,
      what_would_happen: summary,
      message: 'This has NOT been done. It is waiting on the user\'s Approvals page, where they can '
        + 'see exactly what would be sent. Tell them it is waiting for them and do not describe it '
        + 'as completed.',
      ...(request.ignored.length ? { ignored_arguments: request.ignored } : {}),
    };
  }

  // A read. Runs now.
  let response;
  try {
    response = await customApiFetch(
      { connection, request, secret: openCustomApiCredentials(ctx.access.masterKey(), connection) },
      { fetchImpl: ctx.access.customApiFetch, resolve: ctx.access.resolve } satisfies CustomApiFetchOptions,
    );
  } catch (err) {
    const category = err instanceof CustomApiError ? err.category : 'provider_error';
    await recordCustomApiCheck(db, { connectionId: connection.id, ok: false, category });
    return {
      ok: false,
      error: 'api_unavailable',
      message: err instanceof CustomApiError ? err.message : customApiSentence(connection.name, category),
    };
  }

  if (response.status >= 400) {
    const category = categoryForCustomApiStatus(response.status);
    await recordCustomApiCheck(db, { connectionId: connection.id, ok: false, category });
    return {
      ok: false,
      error: 'api_refused',
      status: response.status,
      // CE's sentence, never the API's body. An arbitrary API's error text is
      // attacker-influenced and may quote the request — and the request carried
      // this installation's credential.
      message: customApiSentence(connection.name, category),
    };
  }

  await recordCustomApiCheck(db, { connectionId: connection.id, ok: true });
  return {
    ok: true,
    connection: connection.slug,
    operation: endpoint.operation_id,
    status: response.status,
    // What the API actually returned. Empty is reported as empty; there is no
    // path here that invents a row.
    result: response.body,
    ...(response.truncated
      ? { note: 'The answer was longer than Josi will pass on; this is the beginning of it. Say so.' }
      : {}),
    ...(request.ignored.length ? { ignored_arguments: request.ignored } : {}),
  };
}
