export const PHONE_PRIMARY_LABELS = ['Home', 'Talk', 'Calendar', 'Contacts'] as const;

export const PHONE_MORE_LABELS = [
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
] as const;

export function routeMatches(pathname: string, destination: string) {
  return pathname === destination || pathname.startsWith(`${destination}/`);
}
