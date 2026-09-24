// Saying what happened, rather than printing what the column holds.
//
// LB12: an operator should not have to know that `insufficient_scope` is a
// connector error category, that `needs_reconnect` is a value of
// `connections.status`, or that `awaiting_owner` is a task state. Those are
// database enums. They are correct, they are how the server reasons, and none
// of them is a sentence.
//
// The rule is not "hide it". A person whose connection stopped working needs to
// know WHY, precisely enough to fix it — so every entry below is a plain
// sentence that carries the same information, and the raw value stays available
// in the advanced/detail surfaces where somebody debugging wants it.
//
// The mapping is checked against the database, not maintained by hand: the
// test parses the CHECK constraints in the migrations and fails if a value
// exists that has no plain-language entry. A new state added in SQL therefore
// cannot reach a screen as a bare identifier.

export interface Vocabulary {
  /** Where the values come from, so the test knows what to check against. */
  source: { migrationTable: string; column: string } | { literal: readonly string[] };
  labels: Record<string, string>;
  /** Longer text, where the label alone does not tell somebody what to do. */
  detail?: Record<string, string>;
}

export const VOCABULARIES: Record<string, Vocabulary> = {
  external_channel: {
    source: { literal: ['whatsapp', 'slack'] },
    labels: { whatsapp: 'WhatsApp', slack: 'Slack' },
  },

  calendar_provider: {
    source: { literal: ['google', 'microsoft'] },
    labels: { google: 'Google Calendar', microsoft: 'Microsoft Outlook' },
  },

  connection_status: {
    source: { migrationTable: 'connections', column: 'status' },
    labels: {
      active: 'Working',
      needs_reconnect: 'Needs reconnecting',
      revoked: 'Disconnected',
    },
    detail: {
      needs_reconnect: 'The provider stopped accepting the stored permission. Reconnecting fixes it.',
      revoked: 'Access was withdrawn, here or at the provider. Nothing was deleted.',
    },
  },

  connector_error: {
    // A TypeScript union rather than a database column, so it is listed here
    // and the test asserts it against the union's own source file.
    source: { literal: ['revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'] },
    labels: {
      revoked: 'Access was withdrawn',
      expired: 'The stored permission expired',
      insufficient_scope: 'A permission was removed',
      rate_limited: 'The provider is asking us to slow down',
      provider_error: 'The provider had a problem',
      network: 'The provider could not be reached',
    },
    detail: {
      insufficient_scope:
        'Somebody removed a permission this needs, at the provider or in Josi. Reconnecting and '
        + 'granting it again fixes it.',
      rate_limited: 'This usually clears on its own. Trying again later is the fix.',
      network: 'Check that this server is allowed to make outbound connections.',
    },
  },

  model_provider: {
    // `llm_providers.provider` carries no CHECK — it is validated in code — so
    // this is asserted against the `ProviderKind` union instead.
    source: {
      literal: [
        'openai', 'anthropic', 'xai', 'openai_compatible',
        'deepseek', 'qwen', 'mistral', 'moonshot', 'zhipu', 'openrouter', 'minimax',
        'gemini', 'cohere', 'bedrock', 'azure_ai', 'vertex_ai', 'ernie', 'hunyuan',
        'openai_subscription', 'anthropic_subscription',
      ],
    },
    labels: {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      xai: 'xAI',
      openai_compatible: 'Your own server',
      deepseek: 'DeepSeek',
      qwen: 'Alibaba Qwen',
      mistral: 'Mistral',
      moonshot: 'Moonshot (Kimi)',
      zhipu: 'Zhipu GLM',
      openrouter: 'OpenRouter',
      minimax: 'MiniMax',
      gemini: 'Google Gemini',
      cohere: 'Cohere',
      bedrock: 'AWS Bedrock',
      azure_ai: 'Azure AI',
      vertex_ai: 'Google Vertex AI',
      ernie: 'Baidu ERNIE',
      hunyuan: 'Tencent Hunyuan',
      openai_subscription: 'Your ChatGPT plan',
      anthropic_subscription: 'Your Claude plan',
    },
    detail: {
      openai_compatible: 'A model running on hardware you control. Nothing leaves this server for it.',
      // Where the request actually lands, for the providers where that is not
      // obvious from the name. Somebody choosing a model provider is choosing a
      // jurisdiction as much as a vendor, and the screen should say so.
      deepseek: 'Processed by DeepSeek on infrastructure in China.',
      qwen: 'Processed by Alibaba Cloud. Which region depends on the endpoint you set.',
      mistral: 'Processed by Mistral AI in the EU.',
      moonshot: 'Processed by Moonshot AI. Which region depends on the endpoint you set.',
      zhipu: 'Processed by Zhipu AI on infrastructure in China.',
      openrouter:
        'A broker rather than the model\'s operator. Each request is forwarded to whichever '
        + 'upstream provider serves the model you picked, and that provider\'s terms apply too.',
      minimax: 'Processed by MiniMax. Which region depends on the endpoint you set.',
      gemini:
        'Processed by Google under the Gemini API terms. The free tier is used to improve Google\'s '
        + 'products; a paid tier is not.',
      cohere: 'Processed by Cohere.',
      bedrock: 'Processed inside your own AWS account, in the region you chose.',
      azure_ai: 'Processed inside your own Azure resource, in its region.',
      vertex_ai: 'Processed inside your own Google Cloud project, in the region you chose.',
      ernie: 'Processed by Baidu on infrastructure in China.',
      hunyuan: 'Processed by Tencent Cloud on infrastructure in China.',
      openai_subscription:
        'Runs OpenAI\'s own Codex CLI, signed in as you. Shared across this installation, and it '
        + 'reports no cost, so every usage figure on this path is an estimate.',
      anthropic_subscription:
        'Runs Anthropic\'s own Claude Code CLI, signed in as you. Shared across this installation. '
        + 'It reports real token counts but no cost, because a monthly plan has no per-message '
        + 'price.',
    },
  },

  contact_sync_status: {
    source: { migrationTable: 'contact_sync_origins', column: 'status' },
    labels: {
      idle: 'Syncing',
      syncing: 'Syncing now',
      error: 'Not working',
      paused: 'Paused',
      disconnected: 'Stopped',
    },
    detail: {
      disconnected: 'The contacts it brought are still here, and nothing was changed at the provider.',
    },
  },

  contact_sync_mode: {
    source: { migrationTable: 'contact_sync_origins', column: 'sync_mode' },
    labels: {
      import_only: 'Import only',
      two_way: 'Two-way',
    },
    detail: {
      import_only: 'Contacts come in. Josi never writes back.',
      two_way: 'Changes made here are written back to the provider.',
    },
  },

  contact_source: {
    source: { migrationTable: 'contacts', column: 'source' },
    labels: {
      josi: 'Added here',
      google: 'Google',
      microsoft: 'Microsoft',
      device: 'Your phone',
    },
  },

  contact_conflict: {
    source: { migrationTable: 'contacts', column: 'conflict_state' },
    labels: {
      none: 'In step',
      both_changed: 'Changed in two places',
    },
    detail: {
      both_changed:
        'This changed here and at the provider since the last sync. Nothing was overwritten — '
        + 'edit it here to settle it.',
    },
  },

  task_state: {
    source: { migrationTable: 'tasks', column: 'state' },
    labels: {
      drafting: 'Being worked out',
      awaiting_approval: 'Waiting for you',
      ready: 'Ready to go',
      attempting: 'In progress',
      held: 'Holding',
      awaiting_owner: 'Waiting for you',
      confirmed: 'Confirmed',
      failed: 'Did not work',
      cancelled: 'Cancelled',
      closed: 'Done',
    },
  },

  reminder_status: {
    source: { migrationTable: 'reminders', column: 'status' },
    labels: {
      scheduled: 'Coming up',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      failed: 'Did not go out',
    },
    detail: {
      failed: 'Josi could not deliver this reminder anywhere. It will not fire again — set a new one.',
    },
  },

  mapping_status: {
    source: { migrationTable: 'folder_mappings', column: 'status' },
    labels: {
      active: 'Syncing',
      paused: 'Paused',
      revoked: 'Removed',
    },
    detail: {
      paused: 'Nothing was deleted. Fix the reason below and syncing resumes.',
      revoked: 'This folder is no longer connected. Everything Josi kept from it has been deleted.',
    },
  },

  document_state: {
    source: { migrationTable: 'documents', column: 'state' },
    labels: {
      discovered: 'Found', extracted: 'Read', indexed: 'Searchable',
      skipped: 'Skipped', blocked: 'Blocked', failed: 'Could not read',
    },
  },

  mapping_paused_reason: {
    source: { migrationTable: 'folder_mappings', column: 'paused_reason' },
    labels: {
      token_expired: 'The connection needs signing in again',
      admin_paused: 'An administrator paused it',
      global_pause: 'All document processing is paused',
      quota_exceeded: 'Your storage limit was reached',
      source_missing: 'The folder could not be found',
    },
    detail: {
      token_expired: 'Reconnect the account on this page and syncing resumes. Nothing was deleted.',
      quota_exceeded: 'Ask your administrator for more room, or unmap something else.',
    },
  },

  telegram_error: {
    source: { migrationTable: 'telegram_outbound', column: 'error_category' },
    labels: {
      unauthorized: 'The bot token was rejected',
      blocked_by_user: 'That person blocked the bot',
      chat_not_found: 'The chat no longer exists',
      rate_limited: 'Telegram is asking us to slow down',
      network: 'Telegram could not be reached',
      too_large: 'The message or file was too big',
      malformed: 'Telegram refused the message',
      unknown: 'Telegram refused it without saying why',
    },
    detail: {
      unauthorized: 'Check the bot token in the Telegram settings; it may have been revoked in BotFather.',
      blocked_by_user: 'Nothing to fix here — they can unblock the bot themselves.',
    },
  },

  telegram_link_status: {
    source: { migrationTable: 'telegram_links', column: 'status' },
    labels: {
      active: 'Linked',
      revoked: 'Unlinked',
    },
  },

  child_access: {
    source: { literal: ['allowed', 'outside_schedule', 'daily_limit', 'not_managed', 'module_inert'] },
    labels: {
      allowed: 'Josi is available now',
      outside_schedule: 'Outside the agreed hours',
      daily_limit: 'Today’s time is used up',
      not_managed: 'Not a managed account',
      module_inert: 'Parental Controls is not active here',
    },
    detail: {
      outside_schedule: 'Josi will answer again at the next time in the timetable.',
      daily_limit: 'The daily limit has been reached. It starts again tomorrow, in this account’s own timezone.',
      module_inert: 'Without a licence the hours and limits do not apply and nobody can see these conversations.',
    },
  },
  custom_api_status: {
    source: { migrationTable: 'custom_api_connections', column: 'status' },
    labels: { unverified: 'Not tested yet', active: 'Working', needs_attention: 'Needs attention' },
    detail: { needs_attention: 'The service or its credential changed and must be tested again before Josi can use it.' },
  },
  custom_api_capability: {
    source: { migrationTable: 'custom_api_endpoints', column: 'capability' },
    labels: { read: 'Reads only', write: 'Changes something', delete: 'Deletes something' },
  },
  custom_api_endpoint_source: {
    source: { migrationTable: 'custom_api_endpoints', column: 'source' },
    labels: { manual: 'Added by hand', openapi: 'Imported from a specification' },
  },
  custom_api_call_status: {
    source: { migrationTable: 'custom_api_pending_calls', column: 'status' },
    labels: { pending: 'Waiting for you', approved: 'Approved', denied: 'Declined', expired: 'Expired', executed: 'Sent', failed: 'Did not go through' },
  },
  workflow_provider: {
    source: { literal: ['zapier', 'n8n', 'make'] },
    labels: { zapier: 'Zapier', n8n: 'n8n automation', make: 'Make' },
  },
  workflow_run_status: {
    source: { literal: ['pending', 'approved', 'running', 'succeeded', 'failed', 'denied', 'expired'] },
    labels: {
      pending: 'Waiting for approval', approved: 'Approved', running: 'Running',
      succeeded: 'Completed', failed: 'Failed', denied: 'Declined', expired: 'Expired',
    },
  },
  workflow_integration_status: {
    source: { migrationTable: 'workflow_integrations', column: 'status' },
    labels: { active: 'Connected', error: 'Needs attention', disconnected: 'Disconnected' },
  },
};

/** The sentence for a value, or the value itself if nothing knows it.
 *
 * Falling back to the raw value is deliberate. A screen that renders nothing
 * for an unknown state is a screen that hides a state, and the test below means
 * an unknown one cannot reach here in the first place. */
export function plain(vocabulary: keyof typeof VOCABULARIES, value: string | null | undefined): string {
  if (!value) return '';
  return VOCABULARIES[vocabulary]?.labels[value] ?? value;
}

/** The longer explanation, where there is one. */
export function plainDetail(
  vocabulary: keyof typeof VOCABULARIES,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return VOCABULARIES[vocabulary]?.detail?.[value] ?? null;
}
