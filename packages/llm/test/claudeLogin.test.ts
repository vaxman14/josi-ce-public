// Reading what Anthropic's CLI prints, and refusing to guess.
//
// Every fixture here is a byte-for-byte capture from `@anthropic-ai/claude-code`
// 2.1.258 — the version the Dockerfile pins — taken by running the real binary
// with an isolated CLAUDE_CONFIG_DIR. When the pin moves, this file is what
// fails, which is the entire reason the pin is exact.
import { describe, expect, it } from 'vitest';
import {
  claudeAuthStatus, isAwaitingCode, parseAuthorizeUrl, stripTerminalDecoration,
} from '../src/providers/claudeLogin.js';

const ESC = '\x1b';
const BEL = '\x07';

/** Exactly what `claude auth login --claudeai` writes to a pipe.
 *
 * The URL appears TWICE and the two copies touch, because the CLI wraps it in
 * an OSC-8 hyperlink: the escape carries the target, then the same text is
 * printed for terminals that cannot follow one. */
const LOGIN_OUTPUT =
  'Opening browser to sign in…\n'
  + 'If the browser didn\'t open, visit: '
  + `${ESC}]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abc${BEL}`
  + 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abc'
  + `${ESC}]8;;${BEL}\n`
  + 'Paste code here if prompted > ';

describe('reading the sign-in link', () => {
  it('returns ONE url from an OSC-8 hyperlink, not two joined together', () => {
    // The failure this exists for: a naive /https:\/\/[^\s]*/ against the raw
    // output matches across both copies, because nothing separates them. The
    // operator is then shown a link that 404s and there is nothing on screen
    // to suggest why.
    const challenge = parseAuthorizeUrl(LOGIN_OUTPUT);
    expect(challenge).not.toBeNull();
    expect(challenge!.verificationUrl).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abc',
    );
    expect(challenge!.verificationUrl).not.toContain('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abchttps://');
  });

  it('strips the hyperlink target and leaves readable text', () => {
    const clean = stripTerminalDecoration(LOGIN_OUTPUT);
    expect(clean).not.toContain(ESC);
    expect(clean).not.toContain(BEL);
    expect(clean).toContain('Paste code here if prompted');
  });

  it('returns null until the url has actually arrived', () => {
    // stdout arrives in chunks. Half a challenge shown to an operator is worse
    // than a spinner.
    expect(parseAuthorizeUrl('Opening browser to sign in…\n')).toBeNull();
    expect(parseAuthorizeUrl('')).toBeNull();
  });

  it('does not accept a link to somewhere that is not Anthropic', () => {
    // A CLI that printed an attacker-supplied URL must not have it rendered as
    // the official sign-in link.
    expect(parseAuthorizeUrl('visit: https://claude.com.evil.test/cai/oauth/authorize')).toBeNull();
    expect(parseAuthorizeUrl('visit: https://example.test/cai/oauth/authorize')).toBeNull();
  });

  it('recognises the prompt that means it is blocked on stdin', () => {
    expect(isAwaitingCode(LOGIN_OUTPUT)).toBe(true);
    expect(isAwaitingCode('Opening browser to sign in…')).toBe(false);
  });
});

describe('reading the auth status', () => {
  const run = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: '', spawnError: false });

  it('reports signed out from the PAYLOAD, not from the exit code', async () => {
    // Captured from the real CLI with an empty config directory. Note the
    // exit code: zero. Trusting it would report every signed-out installation
    // as connected, and the first thing the operator would see is the model
    // test failing for no stated reason.
    const status = await claudeAuthStatus({}, run(JSON.stringify({
      loggedIn: false, authMethod: 'none', apiProvider: 'firstParty',
    })));
    expect(status.installed).toBe(true);
    expect(status.signedIn).toBe(false);
  });

  it('distinguishes a subscription from a Console account', async () => {
    // These bill differently. Showing "connected" for both would let somebody
    // think their monthly plan was being used while an API account was.
    const sub = await claudeAuthStatus({}, run(JSON.stringify({ loggedIn: true, authMethod: 'claudeai' })));
    expect(sub.signedIn).toBe(true);
    expect(sub.authMethod).toBe('claudeai');
    expect(sub.detail).toMatch(/subscription/i);

    const console = await claudeAuthStatus({}, run(JSON.stringify({ loggedIn: true, authMethod: 'console' })));
    expect(console.signedIn).toBe(true);
    expect(console.detail).toMatch(/bills API usage/i);
  });

  it('says the CLI is absent rather than signed out when it cannot run', async () => {
    // Two different problems with two different fixes, and an operator told
    // the wrong one will try the wrong thing.
    const status = await claudeAuthStatus({}, async () => ({
      code: null, stdout: '', stderr: '', spawnError: true,
    }));
    expect(status.installed).toBe(false);
    expect(status.signedIn).toBe(false);
    expect(status.detail).toMatch(/not present/i);
  });

  it('refuses to guess when the output is not the JSON it expected', async () => {
    const status = await claudeAuthStatus({}, run('some new human-readable format'));
    expect(status.installed).toBe(true);
    expect(status.signedIn).toBe(false);
    expect(status.detail).toMatch(/in a form Josi could read/i);
  });
});
