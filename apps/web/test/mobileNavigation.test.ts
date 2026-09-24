import { describe, expect, it } from 'vitest';
import { PHONE_MORE_LABELS, PHONE_PRIMARY_LABELS, routeMatches } from '../src/components/layout/mobileNavigation.js';

describe('phone member navigation', () => {
  it('keeps exactly the requested five destinations in the bottom bar', () => {
    expect([...PHONE_PRIMARY_LABELS, 'More']).toEqual(['Home', 'Talk', 'Calendar', 'Contacts', 'More']);
  });

  it('keeps every remaining member destination in More in the requested order', () => {
    expect(PHONE_MORE_LABELS).toEqual([
      'Tasks',
      'Approvals',
      'Conversations',
      'Email / Templates',
      'Connections',
      'Local Workspace',
      'Workflows',
      'Vault',
      'Usage',
      'Personalization',
      'Channels',
      'Settings',
      'Apps',
      'Family',
    ]);
  });

  it('marks both a More destination and its nested routes current', () => {
    expect(routeMatches('/app/channels', '/app/channels')).toBe(true);
    expect(routeMatches('/app/channels/telegram', '/app/channels')).toBe(true);
    expect(routeMatches('/app/calendar', '/app/channels')).toBe(false);
  });
});
