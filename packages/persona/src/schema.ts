// What a profile is allowed to say.
//
// THE WHOLE PHASE TURNS ON THIS FILE.
//
// The plan's risk: "reproducing OpenClaw's unrestricted instruction-file
// semantics would turn personalization into privilege escalation." An
// instruction file that becomes part of a privileged prompt is a place where
// anyone who can write a sentence can rewrite the rules.
//
// So a profile is not instructions. It is a form. The fields below are the
// entire vocabulary; each one has an enumerated set of values or a hard length
// limit; anything else in the file is IGNORED and REPORTED. There is no
// passthrough, no "extra" field, no escape hatch — because an escape hatch is
// the feature being refused.
//
// The free-text fields are the interesting case. `custom_personality` and
// `working_style` genuinely accept prose, because the plan requires "a fully
// custom personality". They are bounded in length, they are placed in a
// clearly-delimited section of the prompt labelled as the person's own
// preference, and — the part that actually matters — THEY CANNOT GRANT
// ANYTHING. Approvals, ownership and tool permission are enforced in code, by
// routes that read database rows. A model entirely persuaded by a hostile
// personality still cannot delete a file, because the delete route checks an
// approval row rather than the assistant's willingness.

/** Layers, in the order they are assembled. */
export type Layer = 'agents_admin' | 'agents_user' | 'soul' | 'user';

export type FieldKind = 'enum' | 'text' | 'name' | 'list';

export interface FieldSpec {
  kind: FieldKind;
  /** For `enum`. The first value is the default. */
  values?: readonly string[];
  /** For `text` and `name`. */
  maxLength?: number;
  /** For `list`. */
  maxItems?: number;
  maxItemLength?: number;
  /** Shown in the UI, and in the "this did nothing" explanation. */
  describes: string;
}

// ---------------------------------------------------------------------------
// SOUL.md — who the assistant is to this person.
// ---------------------------------------------------------------------------
export const SOUL_FIELDS = {
  assistant_name: {
    kind: 'name', maxLength: 40,
    describes: 'what you call your assistant',
  },
  relationship: {
    kind: 'enum',
    values: ['professional', 'friendly', 'warm', 'candid'],
    describes: 'how the assistant relates to you',
  },
  tone: {
    kind: 'enum',
    values: ['brief', 'plain', 'detailed', 'formal'],
    describes: 'how much it says and how',
  },
  humour: {
    kind: 'enum',
    values: ['none', 'dry', 'light', 'playful'],
    describes: 'whether it makes jokes',
  },
  verbosity: {
    kind: 'enum',
    values: ['terse', 'balanced', 'thorough'],
    describes: 'default answer length',
  },
  custom_personality: {
    kind: 'text', maxLength: 2000,
    describes: 'anything else about how it should sound',
  },
  boundaries: {
    kind: 'list', maxItems: 20, maxItemLength: 200,
    describes: 'subjects or behaviours you do not want',
  },
} as const satisfies Record<string, FieldSpec>;

// ---------------------------------------------------------------------------
// USER.md — who the person is.
// ---------------------------------------------------------------------------
export const USER_FIELDS = {
  preferred_name: { kind: 'name', maxLength: 60, describes: 'what to call you' },
  pronouns: { kind: 'name', maxLength: 40, describes: 'your pronouns' },
  role: { kind: 'name', maxLength: 120, describes: 'what you do' },
  locale: { kind: 'name', maxLength: 20, describes: 'language and region' },
  timezone: { kind: 'name', maxLength: 60, describes: 'your timezone' },
  about_me: { kind: 'text', maxLength: 2000, describes: 'anything the assistant should know about you' },
  working_style: { kind: 'text', maxLength: 2000, describes: 'how you like to work' },
  interests: { kind: 'list', maxItems: 30, maxItemLength: 100, describes: 'things you care about' },
} as const satisfies Record<string, FieldSpec>;

// ---------------------------------------------------------------------------
// AGENTS.md — behaviour, and ONLY the choices the core exposes.
//
// The plan is explicit: "These may tune only choices the core explicitly
// exposes (proactivity, formatting, research behaviour, escalation preferences,
// and supported-tool workflow); they are not raw system-prompt extensions."
//
// So this list is short on purpose, and every value is an enum. There is
// deliberately no free-text field in this layer at all: behaviour is where a
// sentence would do the most damage.
// ---------------------------------------------------------------------------
export const AGENTS_FIELDS = {
  proactivity: {
    kind: 'enum',
    values: ['ask_first', 'suggest', 'act_on_routine'],
    describes: 'how much it does without being asked',
  },
  formatting: {
    kind: 'enum',
    values: ['prose', 'bullets', 'structured'],
    describes: 'how answers are laid out',
  },
  research: {
    kind: 'enum',
    values: ['ask_before_searching', 'search_when_useful', 'search_freely'],
    describes: 'when it looks things up',
  },
  escalation: {
    kind: 'enum',
    values: ['always_ask', 'ask_when_unsure', 'proceed_and_report'],
    describes: 'what it does when a task is ambiguous',
  },
  tool_workflow: {
    kind: 'enum',
    values: ['confirm_each', 'confirm_writes', 'confirm_destructive'],
    describes: 'how often it checks before using a tool',
  },
} as const satisfies Record<string, FieldSpec>;

/**
 * How restrictive each behaviour value is, most restrictive first.
 *
 * M-new says the administrator "may tighten, not grant", and this is the same
 * monotonicity rule Phase 7 used for connector capabilities: a user's own
 * profile may only choose a value at least as cautious as the installation
 * policy. Without an ordering, "tighten" is a word rather than a check.
 */
export const CAUTION_ORDER: Record<keyof typeof AGENTS_FIELDS, readonly string[]> = {
  proactivity: ['ask_first', 'suggest', 'act_on_routine'],
  formatting: [], // Not a security choice; a user may pick freely.
  research: ['ask_before_searching', 'search_when_useful', 'search_freely'],
  escalation: ['always_ask', 'ask_when_unsure', 'proceed_and_report'],
  tool_workflow: ['confirm_each', 'confirm_writes', 'confirm_destructive'],
};

export const FIELDS: Record<Layer, Record<string, FieldSpec>> = {
  soul: SOUL_FIELDS,
  user: USER_FIELDS,
  agents_user: AGENTS_FIELDS,
  agents_admin: AGENTS_FIELDS,
};

/** The whole file, whatever the layer. Enforced by the parser and again by a
 * database constraint, because a parser is a function somebody can call
 * differently. */
export const MAX_PROFILE_BYTES = 20_000;

/**
 * Words that look like an attempt to give the assistant orders about its own
 * rules.
 *
 * These do NOT cause a rejection, and it is worth being precise about why.
 * Refusing them would imply the parser is what stops privilege escalation, and
 * it is not — the parser stops nothing, because none of this text becomes a
 * rule in the first place. What this list does is let the product SAY SO: if
 * somebody writes "ignore all safety rules" in their personality, they are told
 * plainly that it was stored as tone and changed no permissions, rather than
 * being left to believe it worked.
 */
export const AUTHORITY_PHRASES: readonly RegExp[] = [
  /\bignore (all |any )?(previous |prior |safety |security )?(rules?|instructions?)\b/i,
  /\b(disable|bypass|skip|turn off) (the )?(approval|permission|security|safety|audit)/i,
  /\byou (are|have) (now )?(an? )?(admin|administrator|root|superuser)\b/i,
  /\bgrant (me|yourself|us) (access|permission)\b/i,
  /\b(act|behave) as (if )?(you are|an?) (admin|root|unrestricted)\b/i,
  /\bwithout (asking|approval|permission|confirmation)\b/i,
  /\bdelete (everything|all|any) (files?|data|documents?)\b/i,
  /\bshow (me )?(the )?(master key|api key|password|secret|token)/i,
  /\baccess (another|other|someone else'?s?) (user|account|files?|mail)/i,
  /\bsystem prompt\b/i,
  /\boverride (the )?(core|policy|rules?)\b/i,
];

export interface AuthorityAttempt {
  field: string;
  phrase: string;
  line: string;
}

/** Find them so the UI can say what did nothing. */
export function findAuthorityAttempts(field: string, value: string): AuthorityAttempt[] {
  const found: AuthorityAttempt[] = [];
  for (const line of value.split('\n')) {
    for (const re of AUTHORITY_PHRASES) {
      const m = re.exec(line);
      if (m) found.push({ field, phrase: m[0], line: line.trim().slice(0, 200) });
    }
  }
  return found;
}
