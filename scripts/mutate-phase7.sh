#!/usr/bin/env bash
# Phase 7 mutation testing.
#
# Every dangerous control this phase adds, broken one at a time. The suite must
# go red; a mutation that leaves it green is a missing test and is reported as
# one.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/connectors/src/capabilities.ts
  packages/connectors/src/connections.ts
  packages/connectors/src/oauthState.ts
  packages/connectors/src/providers.ts
  packages/connectors/src/oauthClients.ts
  apps/api/src/http/connectorRoutes.ts
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  # Rebuild too, so a mutated dist never outlives its source.
  npx tsc -b >/dev/null 2>&1 || true
}
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

# Rebuild before running.
#
# A consumer that imports `@josi-ce/persona` resolves to the package's BUILT
# dist, not its source. Without this, a mutation to persona/src is invisible to
# every test in another package — which is exactly what happened: seven
# mutations were measured against stale compiled output and recorded as
# "survived" when they had never been applied to the code under test.
run() {
  npx tsc -b >/dev/null 2>&1
  npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1
}

# Chunking. Backgrounded runs on this machine get killed part-way, which is how
# two harnesses ended up racing on the same files and producing meaningless
# results. So the harness runs in the FOREGROUND in segments:
#
#   M_FROM=1 M_TO=6 bash scripts/mutate-phase7.sh
#
# Each segment restores everything it touched, so segments are independent and
# a killed one leaves no mutation behind.
M_FROM="${M_FROM:-1}"
M_TO="${M_TO:-99}"
MUTATION_N=0
should_run() {
  MUTATION_N=$((MUTATION_N + 1))
  [[ $MUTATION_N -ge $M_FROM && $MUTATION_N -le $M_TO ]]
}

assert_mutated() {
  if diff -rq "$BACKUP/apps" apps >/dev/null 2>&1 && diff -rq "$BACKUP/packages" packages >/dev/null 2>&1; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"
    return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

if should_run; then
echo
echo "=== M1: an admin ALLOW grants a capability the user never enabled ==="
python3 - <<'PY'
p='packages/connectors/src/capabilities.ts'; s=open(p).read()
s=s.replace("  return args.providerGranted && args.adminAllows && args.userEnabled;","  return args.providerGranted && (args.adminAllows || args.userEnabled);")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M2: the admin ceiling stops denying ==="
python3 - <<'PY'
p='packages/connectors/src/capabilities.ts'; s=open(p).read()
s=s.replace("  if (!args.adminAllows) return 'blocked_by_admin';","")
s=s.replace("  return args.providerGranted && args.adminAllows && args.userEnabled;","  return args.providerGranted && args.userEnabled;")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M3: a capability is credited without the provider granting it ==="
python3 - <<'PY'
p='packages/connectors/src/capabilities.ts'; s=open(p).read()
s=s.replace("    .filter((spec) => spec.scopes.every((scope) => granted.has(scope)))","    .filter((spec) => spec.scopes.some((scope) => granted.has(scope)) || true)")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M4: connecting asks for write scopes up front ==="
python3 - <<'PY'
p='apps/api/src/http/connectorRoutes.ts'; s=open(p).read()
s=s.replace("        : CAPABILITIES.filter((c) => c.provider === provider && c.kind === 'read').map((c) => c.key);","        : CAPABILITIES.filter((c) => c.provider === provider).map((c) => c.key);")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M5: enabling a capability skips the provider-granted check (M32) ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("    if (!grant?.scopes_granted_at) {","    if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M6: enabling a capability ignores the admin ceiling ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("    if (policy && !policy.allowed) {","    if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M7: a new consent NARROWS the scopes already granted ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("""  const merged = new Set([
    ...(existing?.granted_scopes ?? '').split(/\\s+/).filter(Boolean),
    ...args.tokens.grantedScopes.split(/\\s+/).filter(Boolean),
  ]);""","""  const merged = new Set(args.tokens.grantedScopes.split(/\\s+/).filter(Boolean));""")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M8: a re-auth without a refresh token discards the stored one ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("  if (!refreshToken && existing?.secrets_enc) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M9: a connection is enabled the moment it is authorised ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("       values ($1, $2, false, now())","       values ($1, $2, true, now())")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M10: the handshake is replayable ==="
python3 - <<'PY'
p='packages/connectors/src/oauthState.ts'; s=open(p).read()
s=s.replace("      if (row.consumed_at) return { ok: false, reason: 'consumed' };","")
s=s.replace("`update oauth_states set consumed_at = now() where id = $1 and consumed_at is null returning id`","`update oauth_states set consumed_at = now() where id = $1 returning id`")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M11: a state can be redeemed from another session ==="
python3 - <<'PY'
p='packages/connectors/src/oauthState.ts'; s=open(p).read()
s=s.replace("      if (row.session_id && args.sessionId !== row.session_id) {","      if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M12: a google state is redeemable at the microsoft callback ==="
python3 - <<'PY'
p='packages/connectors/src/oauthState.ts'; s=open(p).read()
s=s.replace("      if (row.provider !== args.provider) return { ok: false, reason: 'wrong_provider' };","")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M13: the state never expires ==="
python3 - <<'PY'
p='packages/connectors/src/oauthState.ts'; s=open(p).read()
s=s.replace("      if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };","")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M14: the callback trusts the query string for who is connecting ==="
python3 - <<'PY'
p='apps/api/src/http/connectorRoutes.ts'; s=open(p).read()
s=s.replace("        ownerUserId: handshake.userId,","        ownerUserId: String(req.query.user ?? handshake.userId),")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M15: the return path allows an open redirect ==="
python3 - <<'PY'
p='packages/connectors/src/oauthState.ts'; s=open(p).read()
s=s.replace("  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;","  if (typeof raw !== 'string') return fallback;")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M16: a member may act on another member's connection ==="
python3 - <<'PY'
p='apps/api/src/http/connectorRoutes.ts'; s=open(p).read()
s=s.replace("""      if (!connection || connection.owner_user_id !== req.user!.id) {
        throw new RouteError(404, 'not found');
      }
      const views = await setCapability(db, {""","""      if (!connection) {
        throw new RouteError(404, 'not found');
      }
      const views = await setCapability(db, {""")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M17: the admin health view returns the account address ==="
python3 - <<'PY'
p='apps/api/src/http/connectorRoutes.ts'; s=open(p).read()
s=s.replace("        `select c.id, c.owner_user_id, u.username, c.provider, c.status,","        `select c.account_email, c.granted_scopes, c.id, c.owner_user_id, u.username, c.provider, c.status,")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M18: the client secret is stored in the clear ==="
python3 - <<'PY'
p='packages/connectors/src/oauthClients.ts'; s=open(p).read()
s=s.replace("[args.provider, args.clientId, seal(key, { clientSecret: args.clientSecret }), args.redirectUri, args.actorUserId],","[args.provider, args.clientId, args.clientSecret, args.redirectUri, args.actorUserId],")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M19: the client secret is returned to the admin ==="
python3 - <<'PY'
p='packages/connectors/src/oauthClients.ts'; s=open(p).read()
s=s.replace("`select provider, client_id, redirect_uri, updated_at from oauth_clients`","`select provider, client_id, client_secret_enc, redirect_uri, updated_at from oauth_clients`")
s=s.replace("      clientId: row?.client_id ?? null,","      clientId: row?.client_id ?? null,\n      secret: (row as unknown as { client_secret_enc?: string })?.client_secret_enc ?? null,")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M20: tokens are stored unsealed ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("  const sealed = seal(key, { accessToken: args.tokens.accessToken, refreshToken } satisfies SealedTokens);","  const sealed = JSON.stringify({ accessToken: args.tokens.accessToken, refreshToken });")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M21: the provider's error body is repeated to the caller ==="
python3 - <<'PY'
p='packages/connectors/src/providers.ts'; s=open(p).read()
s=s.replace("      throw new ConnectorError(`the provider refused the request (${category})`, {","      throw new ConnectorError(`the provider refused: ${JSON.stringify(payload)}`, {")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M22: a rate limit demands a reconnect ==="
python3 - <<'PY'
p='packages/connectors/src/connections.ts'; s=open(p).read()
s=s.replace("  const needsReconnect = category === 'revoked' || category === 'insufficient_scope';","  const needsReconnect = true;")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M23: a dead grant is treated as retryable ==="
python3 - <<'PY'
p='packages/connectors/src/providers.ts'; s=open(p).read()
s=s.replace("  if (error === 'invalid_grant') return { category: 'revoked', revoked: true };","")
open(p,'w').write(s)
PY
assert_mutated && run; restore
fi

if should_run; then
echo
echo "=== M24: disconnecting leaves the capability grants behind ==="
python3 - <<'PY'
p='packages/db/migrations/0005_connectors.sql'; s=open(p).read()
s=s.replace("  connection_id uuid not null references connections(id) on delete cascade,","  connection_id uuid not null references connections(id),")
open(p,'w').write(s)
PY
# The migration is not in FILES; restore it by hand after this one.
cp packages/db/migrations/0005_connectors.sql /tmp/0005.mutated
run
python3 - <<'PY'
p='packages/db/migrations/0005_connectors.sql'; s=open(p).read()
s=s.replace("  connection_id uuid not null references connections(id),","  connection_id uuid not null references connections(id) on delete cascade,")
open(p,'w').write(s)
PY

fi

if [[ "$M_TO" -ge 99 ]]; then
  echo
  echo "=== RESTORED — full suite must be green ==="
  run
fi
