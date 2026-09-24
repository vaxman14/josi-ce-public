// Claims require receipts. A product invariant, enforced here.
//
// Round-2 item 12: the assistant told Roman "Done — reminder set… fires at
// 03:51 UTC" and later posted a fake "Reminder: call me" — without ever
// calling the scheduling tool. Nothing was created. The architecture already
// refuses to re-run executed facts; this module extends the same honesty to
// the REPLY: an assistant message that claims a completed action, in a turn
// where zero tools ran, is intercepted before it reaches the person.
//
// Deliberately conservative. A false positive here blocks honest prose
// ("your meeting is scheduled for 3pm" said while *reading* a calendar), which
// is worse than missing a fabrication. So:
//
//   * only STRONG completed-action claims match — first-person or passive
//     perfective phrasings about things this assistant can do (reminders,
//     tasks, emails, messages, events, cancellations);
//   * the guard only fires when the turn executed ZERO tools. One tool call —
//     any tool, either path (in-process loop or the subscription CLI harness,
//     whose out-of-process executions are recorded as actions too) — and the
//     reply passes untouched. Receipts exist; judging their sufficiency is a
//     harder problem than this defect.
//
// When it fires the loop re-prompts once — the model may either actually call
// the tool or restate honestly. If the second attempt still claims with no
// receipt, the reply is replaced outright with an honest refusal.

/** Things the assistant acts on. Kept narrow on purpose: claims about
 * domains the assistant has no tools for read as conversation, not receipts. */
const ACTED_ON =
  '(?:reminder|task|email|e-mail|message|event|meeting|appointment|invite|notification|alert|timer)';
const ARTIFACT =
  '(?:images?|pictures?|photos?|logos?|avatars?|icons?|banners?|posters?|wallpapers?|files?|documents?|reports?|audio|videos?|attachments?|downloads?)';

/** Perfective, completed-action shapes. Each pattern must assert COMPLETION
 * ("set", "sent", "I've scheduled"), never intent ("I will schedule"). */
const CLAIM_PATTERNS: RegExp[] = [
  // "reminder set", "your reminder is set", "task created", "email sent".
  // set/sent/created are agentive verbs — somebody did them just now.
  new RegExp(
    `\\b${ACTED_ON}\\b[^.!?\\n]{0,40}?\\b(?:is|are|has been|have been)?\\s*(?:set|sent|created)\\b`,
    'i',
  ),
  // "the meeting has been scheduled/cancelled" — perfective only. Present
  // "is scheduled for 3pm" is deliberately NOT matched: that is how honest
  // prose describes a pre-existing state (read from recall or history).
  new RegExp(
    `\\b${ACTED_ON}\\b[^.!?\\n]{0,40}?\\b(?:has been|have been)\\s+` +
    `(?:scheduled|booked|cancelled|canceled|deleted|updated)\\b`,
    'i',
  ),
  // "I've scheduled…", "I have set…", "I just sent…", "I created…"
  new RegExp(
    `\\bI(?:'ve| have|'d)?\\s+(?:just\\s+|now\\s+|already\\s+)?` +
    `(?:set(?: up)?|scheduled|created|sent|booked|cancelled|canceled|deleted)\\b` +
    `[^.!?\\n]{0,60}?\\b${ACTED_ON}?`,
    'i',
  ),
  // "Done — reminder…" / "All set — it fires at…"
  new RegExp(`\\b(?:done|all set)\\b\\s*[—:,-]?[^.!?\\n]{0,80}?\\b(?:${ACTED_ON}|fires? at|goes? off at)\\b`, 'i'),
  // "…will fire at 03:51", "it goes off at 3pm" — fabricated timer specifics.
  /\b(?:fires?|will fire|goes? off|will go off)\s+(?:at|in)\b/i,
  // Artifact-bearing work: "Done — here's your image", "I generated the
  // file", "the report is ready". These require an artifact receipt, not
  // merely an unrelated tool call in the same turn.
  new RegExp(`\\b(?:done|finished|completed|ready)\\b[^.!?\\n]{0,80}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\b(?:here(?:'s| is)|attached is|download)\\b[^.!?\\n]{0,60}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\bI(?:'ve| have)?\\s+(?:just\\s+|now\\s+|already\\s+)?(?:created|generated|made|rendered|edited|uploaded|attached|exported|saved)\\b[^.!?\\n]{0,60}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\b${ARTIFACT}\\b[^.!?\\n]{0,50}?\\b(?:is|are)\\s+(?:done|ready|attached|available for download)\\b`, 'i'),
];

/** Phrasings that make a sentence honest even though it names an action:
 * negation, inability, futurity, questions, quoting the user. A single one
 * anywhere in the text stands down the guard — misses are cheaper than
 * blocking honesty. */
const HONEST_MARKERS: RegExp[] = [
  /\b(?:can't|cannot|can not|couldn't|could not|unable to|not able to)\b/i,
  /\b(?:wasn't|was not|isn't|is not|hasn't|has not|haven't|have not|didn't|did not|won't|will not)\s+(?:been\s+)?(?:set|sent|created|scheduled|booked|able)\b/i,
  /\bno\s+(?:reminder|task|email|message|event)\b/i,
  /\b(?:not\s+(?:yet\s+)?(?:set|sent|created|scheduled|booked|connected|scheduled yet))\b/i,
  /\b(?:would you|should I|do you want|shall I|want me to)\b/i,
  /\b(?:I(?:'ll| will| can| could)\s+(?:set|schedule|create|send|book))\b/i, // intent, not completion
  /\bif you(?:'d| would)? like\b/i,
  new RegExp(`\\bno\\s+${ARTIFACT}\\s+(?:was|were|has been|have been)?\\s*(?:created|generated|made|attached|produced)\\b`, 'i'),
  new RegExp(`\\b${ARTIFACT}\\s+(?:generation|creation|editing)?\\s*(?:is|are)?\\s*(?:unavailable|not available|unsupported)\\b`, 'i'),
];

/**
 * True when `text` makes a strong completed-action claim. The caller decides
 * whether receipts exist; this function only reads the words.
 */
export function claimsCompletedAction(text: string): boolean {
  if (!text || text.length > 20_000) return false;
  if (!CLAIM_PATTERNS.some((p) => p.test(text))) return false;
  if (HONEST_MARKERS.some((p) => p.test(text))) return false;
  return true;
}

const ARTIFACT_CLAIM_PATTERNS = [
  new RegExp(`\\b(?:done|finished|completed|ready)\\b[^.!?\\n]{0,80}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\b(?:here(?:'s| is)|attached is|download)\\b[^.!?\\n]{0,60}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\b(?:created|generated|made|rendered|edited|uploaded|attached|exported|saved)\\b[^.!?\\n]{0,60}?\\b${ARTIFACT}\\b`, 'i'),
  new RegExp(`\\b${ARTIFACT}\\b[^.!?\\n]{0,50}?\\b(?:is|are)\\s+(?:done|ready|attached|available for download)\\b`, 'i'),
];

export function claimsArtifactCompletion(text: string): boolean {
  return claimsCompletedAction(text) && ARTIFACT_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

/** A real artifact receipt must identify output, not merely report that some
 * unrelated tool ran. Kept structural so future provider-gated media tools can
 * satisfy it without teaching this guard vendor names. */
export function hasArtifactReceipt(actions: Array<{ tool: string; result: unknown }>): boolean {
  return actions.some(({ result }) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const row = result as Record<string, unknown>;
    if (typeof row.artifact_id === 'string' || typeof row.attachment_id === 'string') return true;
    if (Array.isArray(row.artifacts) && row.artifacts.length > 0) return true;
    if (Array.isArray(row.attachments) && row.attachments.length > 0) return true;
    const artifact = row.artifact;
    return !!artifact && typeof artifact === 'object' && !Array.isArray(artifact)
      && (typeof (artifact as Record<string, unknown>).id === 'string'
        || typeof (artifact as Record<string, unknown>).url === 'string');
  });
}

/** The corrective re-prompt, worded so the model's two honest exits are both
 * explicit. Sent once, as the turn's own plumbing — never shown to the user. */
export const CLAIM_GUARD_REPROMPT =
  '[system integrity check] Your previous reply claimed a completed action, but no tool ran this turn, ' +
  'so nothing was actually scheduled, sent, or created. Either call the appropriate tool NOW to really ' +
  'do it, or rewrite your reply to say honestly that it has not been done. Never state an action ' +
  'happened unless a tool call in this conversation actually performed it.';

/** What the person sees when the model doubles down: the fabrication is
 * replaced, not decorated. */
export const CLAIM_GUARD_FALLBACK =
  'I need to correct myself: I described an action as done, but I did not actually perform it — ' +
  'nothing was scheduled, sent, or created. Ask me again and I will do it for real, or tell me ' +
  'if you want something else.';

export const ARTIFACT_CLAIM_GUARD_REPROMPT =
  '[system integrity check] Your previous reply claimed an artifact was created, attached, or ready, ' +
  'but this turn has no artifact receipt or attachment. Rewrite the reply truthfully. Do not say done, ' +
  'ready, attached, or offer a download unless a tool result identifies the real artifact.';

export const ARTIFACT_CLAIM_GUARD_FALLBACK =
  'I need to correct myself: I claimed an artifact was ready, but no artifact or attachment was created.';
