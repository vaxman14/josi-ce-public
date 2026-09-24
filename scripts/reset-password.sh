#!/usr/bin/env bash
# Offline owner recovery for a self-hosted Josi installation.
set -euo pipefail

usage() {
  printf 'Usage: %s <username-or-email>\n' "${0##*/}" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
identifier="$1"
[[ -f docker-compose.yml ]] || { printf 'error: run this from the Josi installation directory\n' >&2; exit 66; }
docker compose ps --status running web db >/dev/null 2>&1 \
  || { printf 'error: Josi web and database services must be running\n' >&2; exit 69; }

if [[ -t 0 ]]; then
  read -r -s -p 'New Josi password: ' password
  printf '\n'
  read -r -s -p 'Repeat new password: ' confirmation
  printf '\n'
else
  IFS= read -r password
  IFS= read -r confirmation
fi

[[ "$password" == "$confirmation" ]] || { unset password confirmation; printf 'error: passwords did not match\n' >&2; exit 65; }
[[ ${#password} -ge 12 ]] || { unset password confirmation; printf 'error: password must be at least 12 characters\n' >&2; exit 65; }

# Both values travel only over the web container's standard input. The password
# and its Argon2id hash never appear in a command argument, environment variable,
# shell history, database-client argument, or log line.
result="$({ printf '%s\n%s' "$identifier" "$password"; } | docker compose exec -T web node --input-type=module -e '
  import { hashPassword } from "@josi-ce/auth";
  import { connectFromEnv } from "@josi-ce/core";

  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const newline = input.indexOf("\n");
  if (newline < 1) process.exit(64);
  const identifier = input.slice(0, newline);
  const password = input.slice(newline + 1);
  const passwordHash = await hashPassword(password);
  const connection = await connectFromEnv(process.env, { max: 1 });
  try {
    const changed = await connection.db.query(
      `with target as (
         select id from users
         where status = $1 and (lower(username) = lower($2) or lower(email) = lower($2))
       ), changed as (
         update users set password_hash = $3
         where id = (select id from target)
         returning id
       ), revoked_sessions as (
         update sessions set revoked_at = now()
         where user_id = (select id from changed) and revoked_at is null
       ), used_tokens as (
         update auth_tokens set used_at = now()
         where user_id = (select id from changed) and used_at is null
       )
       select id from changed`,
      ["active", identifier, passwordHash],
    );
    process.stdout.write(String(changed.length));
  } finally {
    await connection.close();
  }
')"
unset password confirmation identifier

[[ "$result" == "1" ]] || { printf 'error: no active account matched that username or email\n' >&2; exit 67; }
printf 'Password replaced. Existing sessions and unused reset links were invalidated.\n'
