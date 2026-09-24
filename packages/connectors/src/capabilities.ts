// What a connected account is allowed to do.
//
// The phase plan names the risk this file exists to answer: "deny-only policy
// inverted by accident". So the rule is written once, as an expression rather
// than a branch, and the truth table asserting it is in the tests.
//
// THREE FACTS, DELIBERATELY SEPARATE
//
//   provider  — what Google or Microsoft actually granted. Read from the token
//               response, never from what we asked for.
//   user      — what the account's owner switched on. Their consent.
//   admin     — a ceiling that can only deny.
//
// Collapsing any two of them is how a connector ends up doing more than anyone
// agreed to. A connection that HAS write scope still does not write until its
// owner enables it; an owner who enables it still does not write if the admin
// forbade it; and neither of them can conjure a scope the provider withheld.

export type Provider = 'google' | 'microsoft' | 'dropbox' | 'box' | 'nextcloud';

/** OAuth2 providers, in the Google/Microsoft shape: an application the
 * installation registers, a code exchange, a refresh token. Nextcloud is
 * excluded on purpose — it has no central application to register and no
 * OAuth handshake, only WebDAV plus an app password. Anything that assumes an
 * `oauth_clients` row or an authorize URL exists should iterate this list,
 * never `Provider` itself. */
export const OAUTH_PROVIDERS = ['google', 'microsoft', 'dropbox', 'box'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(provider: Provider): provider is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(provider);
}

/** One switch on the Connections page. */
export interface CapabilitySpec {
  key: string;
  provider: Provider;
  label: string;
  /** Everything this needs the provider to have granted. */
  scopes: string[];
  /** Reading is the starting point; writing is the thing that needs a second
   * trip through consent (M32). */
  kind: 'read' | 'write';
  /** Write capabilities name what they can do to someone else's day, because
   * the consent screen should say it plainly. */
  consequence?: string;
  /** Marks the storage/file capability for each provider.
   *
   * Historically this excluded a capability from the default connect bundle
   * (storage was requested only by name, on a second handshake). Item 16b
   * (2026-09-03) removed that exclusion: connecting now asks for every READ
   * scope up front, storage included, so choosing a folder never needs a
   * second trip through the provider. The field stays as a label for "this
   * is a storage capability" — nothing currently branches on it, but it
   * documents which capabilities exist so a folder can be mapped from them at
   * all, and a future capability family with the same shape has a name to
   * reach for instead of re-deriving it from the key string. */
  connectOptIn?: boolean;
}

/** Scope notes worth keeping.
 *
 * Google's `calendar.events` can write events but CANNOT run a freeBusy query —
 * it returns 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT. Availability needs the full
 * `calendar` scope. The engine learned that against a live account; do not trim
 * it back to look tidier. */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    key: 'google.calendar.read',
    provider: 'google',
    label: 'Read your Google Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    kind: 'read',
  },
  {
    key: 'google.calendar.write',
    provider: 'google',
    label: 'Create and change Google Calendar events',
    // The full scope, for the freeBusy reason above.
    scopes: ['https://www.googleapis.com/auth/calendar'],
    kind: 'write',
    consequence: 'Josi can put events in your calendar and change ones that are already there.',
  },
  {
    key: 'google.mail.read',
    provider: 'google',
    label: 'Read your Gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    kind: 'read',
  },
  {
    key: 'google.mail.send',
    provider: 'google',
    label: 'Send email from your Gmail account',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    kind: 'write',
    consequence: 'Josi can send email that appears to come from you. Every send is still approved by you first.',
  },
  {
    key: 'google.contacts.read',
    provider: 'google',
    label: 'Read your Google contacts',
    // People API. `contacts.readonly` covers the user's own contacts; it does
    // NOT cover the directory, and it is not widened to `contacts` just because
    // reading and writing share an endpoint.
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    kind: 'read',
  },
  {
    key: 'google.contacts.write',
    provider: 'google',
    label: 'Create and change your Google contacts',
    scopes: ['https://www.googleapis.com/auth/contacts'],
    kind: 'write',
    consequence:
      'Josi can add contacts to your Google account and change ones already there. Two-way sync '
      + 'needs this; importing does not.',
  },
  {
    key: 'google.drive.read',
    provider: 'google',
    label: 'Read files in Google Drive folders you choose',
    // The readonly scope. There is deliberately no `drive` (write) capability
    // in this list: this round is read-only ingestion, and a scope that could
    // write would be a scope somebody eventually uses.
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    kind: 'read',
    connectOptIn: true,
  },
  {
    key: 'microsoft.calendar.read',
    provider: 'microsoft',
    label: 'Read your Outlook calendar',
    scopes: ['Calendars.Read'],
    kind: 'read',
  },
  {
    key: 'microsoft.calendar.write',
    provider: 'microsoft',
    label: 'Create and change Outlook calendar events',
    scopes: ['Calendars.ReadWrite'],
    kind: 'write',
    consequence: 'Josi can put events in your calendar and change ones that are already there.',
  },
  {
    key: 'microsoft.mail.read',
    provider: 'microsoft',
    label: 'Read your Outlook mail',
    scopes: ['Mail.Read'],
    kind: 'read',
  },
  {
    key: 'microsoft.mail.send',
    provider: 'microsoft',
    label: 'Send email from your Outlook account',
    scopes: ['Mail.Send'],
    kind: 'write',
    consequence: 'Josi can send email that appears to come from you. Every send is still approved by you first.',
  },
  {
    key: 'microsoft.contacts.read',
    provider: 'microsoft',
    label: 'Read your Outlook contacts',
    scopes: ['Contacts.Read'],
    kind: 'read',
  },
  {
    key: 'microsoft.contacts.write',
    provider: 'microsoft',
    label: 'Create and change your Outlook contacts',
    scopes: ['Contacts.ReadWrite'],
    kind: 'write',
    consequence:
      'Josi can add contacts to your Outlook account and change ones already there. Two-way sync '
      + 'needs this; importing does not.',
  },
  {
    key: 'microsoft.files.read',
    provider: 'microsoft',
    label: 'Read files in OneDrive folders you choose',
    // Files.Read covers the signed-in person's own drive, read-only.
    // Files.Read.All (shared content) is deliberately not asked for.
    scopes: ['Files.Read'],
    kind: 'read',
    connectOptIn: true,
  },
  {
    key: 'dropbox.files.read',
    provider: 'dropbox',
    label: 'Read files in Dropbox folders you choose',
    // Dropbox scopes are its own vocabulary, not a URL. `files.metadata.read`
    // lists; `files.content.read` downloads. Both are read-only — there is no
    // `files.content.write` anywhere in this list, for the same reason Drive
    // and OneDrive have none: this round is read-only ingestion.
    scopes: ['files.metadata.read', 'files.content.read'],
    kind: 'read',
    connectOptIn: true,
  },
  {
    key: 'box.files.read',
    provider: 'box',
    label: 'Read files in Box folders you choose',
    // Box grants whatever the application's configured scopes are and does not
    // echo a per-request scope list the way Google and Microsoft do — there is
    // no narrower "read only" scope to ask for than the application itself
    // carries. `root_readonly` names the intent so a future write capability
    // has a different key to arrive under, the same shape as the other three
    // providers' read/write pairs.
    scopes: ['root_readonly'],
    kind: 'read',
    connectOptIn: true,
  },
  {
    key: 'nextcloud.files.read',
    provider: 'nextcloud',
    label: 'Read files in Nextcloud folders you choose',
    // Not a provider scope in the OAuth sense — Nextcloud grants nothing
    // through this list, because the app password the person generates is
    // already a single all-or-nothing WebDAV credential. The entry exists so
    // the Connections page still has a switch to show and the same on/off
    // consent rule (M32: connecting is not consent to act) applies. `scopes`
    // is empty rather than a placeholder string, and `grantedCapabilities`
    // treats an empty scope list as satisfied by construction — see
    // `connectNextcloud`, which grants this row directly at connect time
    // instead of deriving it from a token response that does not exist.
    scopes: [],
    kind: 'read',
    connectOptIn: true,
  },
] as const;

/** The capability cloud file ingestion needs, per OAuth provider. Same shape
 * and reason as CONTACT_CAPABILITY: expressed here so the sync layer cannot
 * decide for itself that it has enough.
 *
 * Nextcloud is deliberately absent from this map's TYPE (it is not an OAuth
 * provider — see `OAUTH_PROVIDERS`) even though it has its own capability key
 * above (`nextcloud.files.read`) and its own row in `connection_capabilities`.
 * The sync engine looks Nextcloud's capability up directly by that literal
 * key instead of through this table, because there is no `scopesFor` /
 * `grantedCapabilities` OAuth dance to route it through. */
export const STORAGE_CAPABILITY: Record<OAuthProvider, string> = {
  google: 'google.drive.read',
  microsoft: 'microsoft.files.read',
  dropbox: 'dropbox.files.read',
  box: 'box.files.read',
};

/** Nextcloud's storage capability, named the same way `STORAGE_CAPABILITY`
 * names the OAuth providers' — kept separate because the map above is typed
 * over `OAuthProvider` and Nextcloud is deliberately not one. */
export const NEXTCLOUD_STORAGE_CAPABILITY = 'nextcloud.files.read';

/** The capability a sync mode needs, per provider.
 *
 * M32 and LB8.10: importing needs read, and two-way needs write — which is a
 * SECOND trip through consent, not a checkbox on a connection that already
 * exists. Expressed here so the sync layer cannot decide for itself that it
 * has enough.
 *
 * Contacts only ever meant Google and Microsoft — Dropbox, Box and Nextcloud
 * are storage providers with no address book, so this stays narrower than
 * `Provider` rather than growing three keys nothing will ever read. */
export const CONTACT_CAPABILITY: Record<'google' | 'microsoft', { read: string; write: string }> = {
  google: { read: 'google.contacts.read', write: 'google.contacts.write' },
  microsoft: { read: 'microsoft.contacts.read', write: 'microsoft.contacts.write' },
};

export function contactCapabilityFor(provider: 'google' | 'microsoft', mode: 'import_only' | 'two_way'): string {
  const pair = CONTACT_CAPABILITY[provider];
  return mode === 'two_way' ? pair.write : pair.read;
}

export const CAPABILITY_KEYS: readonly string[] = CAPABILITIES.map((c) => c.key);

export function capabilitySpec(key: string): CapabilitySpec | null {
  return CAPABILITIES.find((c) => c.key === key) ?? null;
}

export function capabilitiesFor(provider: Provider): CapabilitySpec[] {
  return CAPABILITIES.filter((c) => c.provider === provider);
}

/** Scopes always requested, so the connection knows whose account it is.
 *
 * OAuth providers only — Nextcloud never reaches this function; its identity
 * is the server URL plus whatever the WebDAV `PROPFIND` on `/` reports, not a
 * scope. */
export const IDENTITY_SCOPES: Record<OAuthProvider, string[]> = {
  google: ['https://www.googleapis.com/auth/userinfo.email', 'openid'],
  // offline_access is what makes Microsoft return a refresh token at all.
  microsoft: ['openid', 'email', 'offline_access', 'User.Read'],
  // Dropbox's identity call (`users/get_current_account`) needs no separate
  // scope beyond what the app console grants by default (`account_info.read`
  // is on by default for any app); nothing to add here keeps the request
  // exactly the capabilities asked for, which is the M32 rule this function
  // exists to enforce.
  dropbox: [],
  // Box's identity call (`GET /users/me`) is covered by the base_explorer /
  // root_readonly scope already requested; nothing additional to ask for.
  box: [],
};

/** The scope string to ask for, given the capabilities being requested.
 *
 * Incremental by construction: the caller passes what it wants NOW, and the
 * provider is asked for exactly that plus identity. Asking for everything up
 * front is the behaviour M32 forbids. */
export function scopesFor(provider: OAuthProvider, capabilityKeys: readonly string[]): string {
  const wanted = new Set(IDENTITY_SCOPES[provider]);
  for (const key of capabilityKeys) {
    const spec = capabilitySpec(key);
    if (!spec || spec.provider !== provider) continue;
    for (const scope of spec.scopes) wanted.add(scope);
  }
  return [...wanted].join(' ');
}

/** Which capabilities the provider's granted scopes actually cover.
 *
 * Derived from what came back, not from what was requested — a provider that
 * silently drops a scope must not leave us believing we have it. */
export function grantedCapabilities(provider: Provider, grantedScopes: string): string[] {
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean));
  return capabilitiesFor(provider)
    .filter((spec) => spec.scopes.every((scope) => granted.has(scope)))
    .map((spec) => spec.key);
}

// --------------------------------------------------------------- the rule

export type CapabilityState =
  /** The provider never granted the scopes. Fixing it means re-consenting. */
  | 'needs_consent'
  /** An administrator has forbidden it installation-wide. */
  | 'blocked_by_admin'
  /** Available, and the owner has not switched it on. */
  | 'off'
  /** Available, allowed, and on. */
  | 'on';

/** Is this capability usable right now?
 *
 * One expression, evaluated in one order, with no parameter named `role`
 * anywhere in it — so there is nowhere for a "but an administrator can…" to be
 * added later.
 *
 * The order matters and is not arbitrary. A capability the provider never
 * granted reports `needs_consent` even when an admin has forbidden it: telling
 * someone "your administrator blocked this" when the real problem is that they
 * never finished connecting sends them to the wrong person. */
export function capabilityState(args: {
  providerGranted: boolean;
  adminAllows: boolean;
  userEnabled: boolean;
}): CapabilityState {
  if (!args.providerGranted) return 'needs_consent';
  if (!args.adminAllows) return 'blocked_by_admin';
  return args.userEnabled ? 'on' : 'off';
}

/** The boolean the rest of the product asks: may this happen?
 *
 * `effectiveCapability = min(userGrant, adminPolicy)` from the phase plan, with
 * the provider grant as the precondition it always was. Logical AND, because
 * every input is a permission and none of them is a level.
 *
 * The property that matters, asserted as a truth table in the tests: there is
 * no combination in which `adminAllows` being true makes the answer true when
 * `userEnabled` is false. An administrator can take a capability away and can
 * never hand one out. */
export function effectiveCapability(args: {
  providerGranted: boolean;
  adminAllows: boolean;
  userEnabled: boolean;
}): boolean {
  return args.providerGranted && args.adminAllows && args.userEnabled;
}

/** Sentence for a refusal, so a blocked action explains itself. */
export function refusalReason(state: CapabilityState, capability: string): string {
  const spec = capabilitySpec(capability);
  const what = spec ? spec.label.toLowerCase() : capability;
  switch (state) {
    case 'needs_consent':
      return `Your connected account has not granted permission to ${what}. Reconnect it and approve that permission.`;
    case 'blocked_by_admin':
      return `An administrator has switched off the ability to ${what} for this installation.`;
    case 'off':
      return `You have not turned on the ability to ${what}. You can enable it on the Connections page.`;
    case 'on':
      return '';
  }
}
