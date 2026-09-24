// LB2.3 — the device-login flow, parsed against what the CLI really prints.
//
// The fixture below is a byte-for-byte capture of `codex login --device-auth`
// from @openai/codex 0.152.0, ANSI colour codes and all, with only the one-time
// code replaced by one of identical shape. That code is a pairing code rather
// than a credential — it is designed to be read aloud, it grants nothing
// without somebody completing the flow with their own ChatGPT account, and it
// expires in fifteen minutes — but a fixture is no place for a real one.
//
// Capturing the real output rather than writing what it probably looks like is
// the point. When the pinned version moves and the wording changes, this is
// what fails, rather than an operator staring at a spinner.
import { describe, expect, it } from 'vitest';
import { parseDeviceChallenge, parseExpiry, stripAnsi } from '../src/index.js';

/** `codex login --device-auth`, @openai/codex 0.152.0, verbatim. */
const REAL_OUTPUT = [
  '',
  'Welcome to Codex [v[90m0.152.0[0m]',
  '[90mOpenAI’s command-line coding agent[0m',
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   [94mhttps://auth.openai.com/codex/device[0m',
  '',
  '2. Enter this one-time code [90m(expires in 15 minutes)[0m',
  '   [94mABCD-EFGH1[0m',
  '',
  '[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m',
  '',
].join('\n');

describe('reading what the CLI printed', () => {
  it('finds the link and the code in the real output', () => {
    const challenge = parseDeviceChallenge(REAL_OUTPUT);
    expect(challenge).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH1',
    });
  });

  it('reads how long the code lasts', () => {
    expect(parseExpiry(REAL_OUTPUT)).toBe(15 * 60);
    expect(parseExpiry('expires in 2 hours')).toBe(7200);
    expect(parseExpiry('expires in 90 seconds')).toBe(90);
    expect(parseExpiry('no expiry mentioned')).toBeNull();
  });

  it('strips the colour codes the CLI writes even into a pipe', () => {
    expect(stripAnsi('[94mhttps://example.test[0m')).toBe('https://example.test');
    expect(stripAnsi(REAL_OUTPUT)).not.toContain('');
  });

  it('shows nothing until BOTH halves have arrived', () => {
    // Output comes in chunks. Half a challenge on screen is worse than a
    // spinner: an operator opens the link and has no code to type.
    const upToTheUrl = REAL_OUTPUT.slice(0, REAL_OUTPUT.indexOf('2. Enter this'));
    expect(upToTheUrl).toContain('auth.openai.com');
    expect(parseDeviceChallenge(upToTheUrl)).toBeNull();

    expect(parseDeviceChallenge('')).toBeNull();
    expect(parseDeviceChallenge('Welcome to Codex')).toBeNull();
  });

  it('is not fooled by hyphenated prose', () => {
    // The real output contains "one-time", "command-line" and "sign-in". None
    // of them is a code, and with the code line removed there is nothing to
    // find — which is the assertion, because a parser that matched any of them
    // would show an operator a word to type.
    const noCode = REAL_OUTPUT.split('\n').filter((l) => !l.includes('ABCD')).join('\n');
    expect(noCode).toContain('one-time');
    expect(noCode).toContain('command-line');
    expect(parseDeviceChallenge(noCode)).toBeNull();
  });

  it('accepts a differently-grouped code, because grouping is not ours to fix', () => {
    const reshaped = REAL_OUTPUT.replace('ABCD-EFGH1', 'WXYZ-1234-5678');
    expect(parseDeviceChallenge(reshaped)?.userCode).toBe('WXYZ-1234-5678');
  });

  it('takes no URL that is not OpenAI’s', () => {
    // If a future CLI printed a link somewhere else, showing it would be
    // sending an operator to sign in wherever the output said.
    const hijacked = REAL_OUTPUT.replace('https://auth.openai.com/codex/device', 'https://evil.example/login');
    expect(parseDeviceChallenge(hijacked)).toBeNull();
  });
});
