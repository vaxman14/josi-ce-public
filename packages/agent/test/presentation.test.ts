import { describe, expect, it } from 'vitest';
import { presentToolBackedReply } from '../src/presentation.js';

const receipt = '018f47a2-7b1c-4f2a-9d31-2c7f0e9c14a1';
const connectionId = 'conn_private_42';

const actions = [{
  tool: 'get_provider_status',
  result: {
    ok: true,
    receipt,
    observed_at: '2026-09-17T22:58:04.123Z',
    connections: [{
      id: connectionId,
      provider: 'google',
      account: 'private@example.test',
      status: 'connected',
      last_check_at: '2026-09-17T22:57:00.000Z',
    }],
  },
}];

describe('tool-backed reply presentation boundary', () => {
  it('keeps useful prose and source attribution while removing grounding metadata', () => {
    const visible = presentToolBackedReply(
      `Google Drive is connected and has 3 indexed files.\nSource: Google Drive\nReceipt ID: ${receipt}\nObserved at: 2026-09-17T22:58:04.123Z\nAccount: private@example.test\nConnection ID: ${connectionId}`,
      actions,
    );

    expect(visible).toBe('Google Drive is connected and has 3 indexed files.\nSource: Google Drive');
  });

  it('removes internal values echoed inline or under future metadata keys', () => {
    const visible = presentToolBackedReply(
      `Checked ${receipt} for private@example.test using ${connectionId}. Provider: google.`,
      actions,
    );
    expect(visible).not.toMatch(/018f47|private@example|conn_private/);
    expect(visible).toContain('Provider: google');
  });

  it('handles multiple success and error receipts without mutating them', () => {
    const multi = [
      { tool: 'first', result: { ok: true, receipt: 'first-secret-receipt', task_id: 'task-secret-id' } },
      { tool: 'second', result: { ok: false, approval_id: 'approval-secret-id', message: 'Try again.' } },
    ];
    const before = structuredClone(multi);
    const visible = presentToolBackedReply(
      'First receipt: first-secret-receipt. Task ID: task-secret-id. Approval ID: approval-secret-id. Try again.',
      multi,
    );
    expect(visible).not.toMatch(/secret|receipt:/i);
    expect(visible).toContain('Try again.');
    expect(multi).toEqual(before);
  });

  it('recognizes future camelCase metadata fields without a tool allowlist update', () => {
    const visible = presentToolBackedReply('Done with approval-private and mapping-private.', [{
      tool: 'future_tool', result: { ok: true, approvalId: 'approval-private', mappingId: 'mapping-private' },
    }]);
    expect(visible).not.toContain('approval-private');
    expect(visible).not.toContain('mapping-private');
  });

  it('does not alter ordinary non-tool replies', () => {
    const reply = `The identifier ${receipt} was part of your message.`;
    expect(presentToolBackedReply(reply, [])).toBe(reply);
  });

  it('returns an honest generic sentence if a reply contains metadata only', () => {
    expect(presentToolBackedReply(`Receipt: ${receipt}`, actions)).toBe('I completed that request.');
    expect(presentToolBackedReply('Approval ID: approval-secret-id', [
      { tool: 'write', result: { ok: false, approval_id: 'approval-secret-id' } },
    ])).toBe('I could not complete that request.');
  });
});
