import { describe, expect, it } from 'vitest';
import { isMutatingTool, MUTATING_TOOLS } from '../src/durableEffects.js';

describe('durable effect catalogue', () => {
  it('fences only the mutating workspace status shape', () => {
    expect(MUTATING_TOOLS.has('workspace_code_status')).toBe(false);
    expect(isMutatingTool('workspace_code_status',{run_id:'run-1'})).toBe(false);
    expect(isMutatingTool('workspace_code_status',{run_id:'run-1',cancel:false})).toBe(false);
    expect(isMutatingTool('workspace_code_status',{run_id:'run-1',cancel:true})).toBe(true);
  });

  it('keeps fixed mutating tools fenced', () => {
    expect(isMutatingTool('schedule_reminder',{})).toBe(true);
    expect(isMutatingTool('workspace_read',{})).toBe(false);
  });
});
