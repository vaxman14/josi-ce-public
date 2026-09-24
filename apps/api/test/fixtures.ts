// Shared test fixtures, so test files import from one place rather than
// reaching across the workspace into package internals.
import { completeSetup, ensureWorkspace as ensureWorkspaceRow, type Db } from '../../../packages/core/src/workspace.js';

export { createUser } from '../../../packages/auth/src/users.js';

/** A workspace on an installation that has finished setup.
 *
 * Phase 3 added a gate: while `setup_state.completed = false`, every route
 * except the wizard is refused, because an unconfigured installation has no
 * accounts and therefore no authorization model to enforce. Suites that
 * exercise the running product — authorization, readiness — are testing a
 * CONFIGURED installation, so the fixture marks setup complete alongside
 * creating the workspace.
 *
 * This does not weaken anything: the same assertions run against the same
 * routes. It stops those suites from silently testing an installation state
 * they were never about. Tests that care about the setup boundary itself
 * (setup.test.ts) deliberately do NOT use this helper and drive the real
 * wizard instead.
 */
export async function ensureWorkspace(db: Db, args: { name?: string; timezone?: string } = {}) {
  const workspace = await ensureWorkspaceRow(db, args);
  await completeSetup(db);
  return workspace;
}
