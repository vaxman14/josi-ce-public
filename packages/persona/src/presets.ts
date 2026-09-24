// Starting points.
//
// The plan asks for "useful presets and a live response preview, but allow a
// fully custom personality". Presets are a convenience, not a menu of the only
// permitted personalities — every one of these is just a SOUL.md a person could
// have typed, and they can edit it afterwards or ignore them entirely.
//
// They set only fields the schema already has. A preset cannot introduce a
// field, which is the same rule everything else in this package follows: there
// is no path by which a shipped default becomes a capability.
import { renderProfile } from './parse.js';

export interface Preset {
  key: string;
  name: string;
  /** What somebody choosing it should expect. */
  describes: string;
  values: Record<string, string | string[]>;
}

export const SOUL_PRESETS: readonly Preset[] = [
  {
    key: 'default',
    name: 'Brief and direct',
    describes: 'Answers first, no preamble, no filler. This is how Josi behaves with no profile at all.',
    values: {
      tone: 'brief',
      relationship: 'professional',
      humour: 'none',
      verbosity: 'terse',
    },
  },
  {
    key: 'warm',
    name: 'Warm and personal',
    describes: 'Still direct, but reads like a person who knows you rather than a form.',
    values: {
      tone: 'plain',
      relationship: 'warm',
      humour: 'light',
      verbosity: 'balanced',
      custom_personality:
        'Talk to me like a colleague I get on with. Say the useful thing first, '
        + 'then any context I would actually want.',
    },
  },
  {
    key: 'thorough',
    name: 'Thorough',
    describes: 'Explains its reasoning and flags what it is unsure about. Longer answers.',
    values: {
      tone: 'detailed',
      relationship: 'professional',
      humour: 'none',
      verbosity: 'thorough',
      custom_personality:
        'Show your working. When something is uncertain, say so and say why, '
        + 'rather than picking the confident-sounding answer.',
    },
  },
  {
    key: 'dry',
    name: 'Dry',
    describes: 'Brief, with a sense of humour that stays out of the way.',
    values: {
      tone: 'brief',
      relationship: 'candid',
      humour: 'dry',
      verbosity: 'terse',
      custom_personality: 'Be straight with me. A little dryness is welcome; jokes are not.',
    },
  },
  {
    key: 'formal',
    name: 'Formal',
    describes: 'Measured and careful. Suited to work that other people will read.',
    values: {
      tone: 'formal',
      relationship: 'professional',
      humour: 'none',
      verbosity: 'balanced',
      custom_personality: 'Write as though what you produce may be forwarded without editing.',
    },
  },
];

/** The Markdown a preset would put in somebody's file, so choosing one and
 * typing the same thing by hand are the same act. */
export function presetContent(key: string): string | null {
  const preset = SOUL_PRESETS.find((p) => p.key === key);
  if (!preset) return null;
  return renderProfile('soul', preset.values);
}

/** The default personality, stated once.
 *
 * The plan requires that "defaults preserve the current brief/direct
 * personality and the assistant works before any profile is created" — so this
 * is what a person gets by writing nothing at all, and skipping first-run is a
 * real choice rather than a deferred obligation. */
export const DEFAULT_PRESET = 'default';
