#!/usr/bin/env bash
# Refuse to let commercial material or credentials into the public-facing CE repo.
#
# This exists because CE is derived from a private commercial codebase that
# contains real customer phone numbers, production endpoints and live API keys.
# A .gitignore stops files; this stops *strings* that get pasted, templated or
# copied into a file that is otherwise perfectly innocent.
#
#   scripts/scan-secrets.sh            scan tracked + staged files
#   scripts/scan-secrets.sh <path...>  scan specific paths (used by tests)
#
# Exit 0 = clean. Exit 1 = something was found; the commit must not proceed.
set -uo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- what we ban
# SoCal business lines. These are real numbers that real customers call; they
# are hard-blocked in the commercial engine and must never appear here at all.
FORBIDDEN_LITERAL=(
  '+19514776060' '+19513958776' '+19514254567' '+19517177772'
  '9514776060' '9513958776' '9514254567' '9517177772'
  # Production endpoints and hosts belonging to the hosted product.
  'socalreceptionist.com'
  '10.10.1.3'
  '10.10.1.5'
  '/Volumes/josi/Projects/'
  '143.110.236.218'
  # Supabase project ref for the live SoCal database.
  'xcngpfeuvvcsxgwyukch'
  # Zammad's internal binding — support infrastructure, not CE's business.
  '127.0.0.1:8111'
)

# Credential shapes. Deliberately broad: a false positive costs a conversation,
# a false negative costs a rotation.
FORBIDDEN_REGEX=(
  'sk-[A-Za-z0-9_-]{20,}'                       # OpenAI-style keys
  'sk-ant-[A-Za-z0-9_-]{20,}'                   # Anthropic keys
  'xai-[A-Za-z0-9_-]{20,}'                      # xAI keys
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'AIza[0-9A-Za-z_-]{35}'                       # Google API key
  'ghp_[A-Za-z0-9]{36}'                         # GitHub PAT
  'github_pat_[A-Za-z0-9_]{50,}'
  'BEGIN [A-Z ]*PRIVATE KEY'                    # PEM
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}' # JWT (cloudflared tokens etc.)
  # A DSN carrying an inline password. The username part is restricted to plain
  # identifier characters so that shell interpolation — postgresql://${PGUSER:-josi}@db,
  # whose ":-" default syntax looks like a user:password pair — is not a match.
  # A real credential still is: postgresql://user:hunter2@host.
  'postgres(ql)?://[A-Za-z0-9._%+-]+:[^@/ "'"'"'`]{3,}@'
  '[0-9a-f]{32}-us[0-9]{1,2}'                   # Mailchimp-style
)

# CTF Designs must never be presented as the creator of Josi (canonical map).
# The name may legitimately appear in prose that names the *other* company, so
# this looks for creator/author/by attributions specifically.
ATTRIBUTION_REGEX='(created|authored|developed|made|built|published)[^.\n]{0,40}(by )?CTF Designs|CTF Designs[^.\n]{0,20}(is the|as the)?[^.\n]{0,20}(creator|author|publisher|maker)'

strip_public_installer_host() {
  # Permit the exact DNS hostname only. A label prefix, suffix or adjacent
  # hostname character must remain visible to the heyjosi.com ban below.
  sed -E 's#(^|[^[:alnum:].-])get\.heyjosi\.com([^[:alnum:].-]|$)#\1\2#g'
}

# Keep the exception narrower than its comment on both BSD and GNU sed.
[[ "$(printf '%s\n' 'https://get.heyjosi.com/install.sh' | strip_public_installer_host)" == 'https:///install.sh' ]] || {
  echo 'secret scan internal error: exact public installer hostname was not recognized' >&2
  exit 1
}
for public_host_variant in notget.heyjosi.com get.heyjosi.com.evil.example ce.get.heyjosi.com; do
  [[ "$(printf '%s\n' "https://$public_host_variant/payload" | strip_public_installer_host)" == "https://$public_host_variant/payload" ]] || {
    echo "secret scan internal error: hostname exception accepted $public_host_variant" >&2
    exit 1
  }
done

# Files we never scan: the scanner's own ban-list, lockfiles, binaries.
is_skippable() {
  case "$1" in
    scripts/scan-secrets.sh) return 0 ;;
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.pdf|*.zip|*.woff|*.woff2|*.ttf) return 0 ;;
    package-lock.json|*/package-lock.json) return 0 ;;
    *) return 1 ;;
  esac
}

# Portable file collection. macOS ships bash 3.2, which has no `mapfile`, and
# this hook has to run on Roman's Mac as well as in a Linux CI container.
FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT

if [[ $# -gt 0 ]]; then
  printf '%s\n' "$@" > "$FILE_LIST"
else
  # Tracked plus staged, deduplicated. Untracked-and-unstaged files are not
  # going into the commit, so they are not this hook's problem.
  { git ls-files; git diff --cached --name-only --diff-filter=ACM; } 2>/dev/null \
    | sort -u > "$FILE_LIST"
fi

scanned=0
findings=0
report() {
  printf '  %s\n' "$1"
  findings=$((findings + 1))
}

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  scanned=$((scanned + 1))
  [[ -f "$file" ]] || continue
  is_skippable "$file" && continue
  # Skip anything that is not text.
  if ! grep -Iq . "$file" 2>/dev/null; then continue; fi

  # The public business feedback mailbox is intentionally published in CE.
  # Remove only that exact address for literal-domain checks; URLs, hosts and
  # every other occurrence of the production domain remain forbidden.
  literal_source="$file"
  literal_tmp=""
  if grep -Fq 'roman@socalreceptionist.com' "$file"; then
    literal_tmp="$(mktemp)"
    sed 's/roman@socalreceptionist\.com//g' "$file" > "$literal_tmp"
    literal_source="$literal_tmp"
  fi
  # get.heyjosi.com is the intentionally public, static CE installer origin,
  # not a hosted-product endpoint. Permit only that exact hostname and only in
  # the reviewed installer implementation, its tests/docs, and release wiring.
  # ce.heyjosi.com and every other production-domain occurrence remain blocked.
  public_installer_file=0
  case "$file" in
    .github/workflows/release.yml|docs/CLI.md|docs/HELP.md|docs-site/body.html|docs-site/index.html|docs-site/public/index.html|docs-site/netlify/functions/help-index.json|docs-site/offline/index.html|apps/web/public/help/index.html|get.heyjosi.com/install.sh|scripts/test-cli-installer.sh|scripts/test-cli-installer-debian.sh)
      public_installer_file=1
      if grep -Fq 'get.heyjosi.com' "$literal_source"; then
        [[ -n "$literal_tmp" ]] || literal_tmp="$(mktemp)"
        strip_public_installer_host < "$literal_source" > "$literal_tmp.next"
        mv "$literal_tmp.next" "$literal_tmp"
        literal_source="$literal_tmp"
      fi
      ;;
  esac

  for needle in "${FORBIDDEN_LITERAL[@]}"; do
    if grep -Fn -- "$needle" "$literal_source" >/dev/null 2>&1; then
      while IFS= read -r hit; do
        report "$file:${hit%%:*}  forbidden string: $needle"
      done < <(grep -Fn -- "$needle" "$literal_source")
    fi
  done
  [[ -z "$literal_tmp" ]] || rm -f "$literal_tmp"

  # The public CE Help hostname and the exact installer host in reviewed files
  # are approved; all other production hosts are not.
  if grep -Fn -- 'heyjosi.com' "$file" >/dev/null 2>&1; then
    while IFS= read -r hit; do
      rest="$hit"
      while [[ "$rest" == *heyjosi.com* ]]; do
        before="${rest%%heyjosi.com*}"
        after="${rest#*heyjosi.com}"
        allowed=0
        if [[ "$before" == *help. ]] || { [[ "$public_installer_file" -eq 1 ]] && [[ "$before" == *get. ]]; }; then
          if [[ "$before" == *help. ]]; then prefix="${before%help.}"; else prefix="${before%get.}"; fi
          if { [[ -z "$prefix" ]] || [[ ! "${prefix: -1}" =~ [[:alnum:].-] ]]; } \
             && { [[ -z "$after" ]] || [[ ! "${after:0:1}" =~ [[:alnum:].-] ]]; }; then
            allowed=1
          fi
        fi
        [[ "$allowed" -eq 1 ]] || report "$file:${hit%%:*}  forbidden production hostname"
        rest="$after"
      done
    done < <(grep -Fn -- 'heyjosi.com' "$file")
  fi

  for pattern in "${FORBIDDEN_REGEX[@]}"; do
    if grep -En -- "$pattern" "$file" >/dev/null 2>&1; then
      while IFS= read -r hit; do
        report "$file:${hit%%:*}  looks like a credential (/$pattern/)"
      done < <(grep -En -- "$pattern" "$file")
    fi
  done

  if grep -Eni -- "$ATTRIBUTION_REGEX" "$file" >/dev/null 2>&1; then
    report "$file  attributes Josi to CTF Designs; the creator is SOCAL RECEPTIONIST LLC"
  fi
done < "$FILE_LIST"

if [[ $findings -gt 0 ]]; then
  echo
  echo "secret scan FAILED: $findings finding(s) above."
  echo "Nothing from the commercial engine's production surface may enter this repo."
  exit 1
fi

echo "secret scan clean ($scanned files)"
exit 0
