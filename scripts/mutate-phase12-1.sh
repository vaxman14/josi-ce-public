#!/usr/bin/env bash
# Phase 12.1 mutation testing: the live integration.
#
#   M_FROM=1 M_TO=8 bash scripts/mutate-phase12-1.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/agent/src/assistantAgent.ts
  packages/persona/src/extract.ts
  packages/persona/src/assemble.ts
  packages/persona/src/memory.ts
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

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-999}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  local changed=0
  for f in "${FILES[@]}"; do cmp -s "$BACKUP/$f" "$f" || changed=1; done
  if [[ $changed -eq 0 ]]; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

mut() { echo; echo "=== M$N: $1 ==="; }

# --------------------------------------------------------------------------
# The live wiring.
# --------------------------------------------------------------------------
if should_run; then mut "personalization never reaches the model"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("    system = assembleSystemContext({","    if (false) system = assembleSystemContext({",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the core is dropped once a profile exists"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("      core,\n      adminPolicy: layers.agents_admin,","      core: '',\n      adminPolicy: layers.agents_admin,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "another person's layers are loaded"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("    const layers = await loadAll(db, userId);","    const layers = await loadAll(db, args.threadId);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the user's preferences are used unnarrowed"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("    const { effective } = narrowPolicy(layers.agents_admin, layers.agents_user, CAUTION_ORDER);","    const effective = layers.agents_user;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "memories are fetched for the wrong person"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("const memories = await relevantMemories(db, { ownerUserId: userId, request: args.inbound });","const memories = await relevantMemories(db, { ownerUserId: args.threadId, request: args.inbound });",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the request is duplicated into the system context"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("    }).text;","    }).text + '\\n\\n--- The current request ---\\n' + args.inbound;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the authority note is omitted from the live context"
python3 - <<'MUT'
p='packages/persona/src/assemble.ts'; s=open(p).read()
before = """  parts.push(CORE_AUTHORITY_NOTE);
  sections.push('authority_note');

  const add = (key: Layer | 'memory', body: string): void => {
    if (!body.trim()) return;
    parts.push(`--- ${LABELS[key]} ---\\n${body}\\n--- end ---`);
    sections.push(key);
  };

  add('agents_admin', renderValues(input.adminPolicy));
  add('agents_user', renderValues(input.userPolicy));
  add('soul', renderValues(input.soul));
  add('user', renderValues(input.user));

  if (input.memories.length) {
    add('memory', input.memories.map((m) => `- ${m.content}  (${m.provenance})`).join('\\n'));
  }

  return { text: parts.join('\\n\\n'), sections };
}"""
after = """  const add = (key: Layer | 'memory', body: string): void => {
    if (!body.trim()) return;
    parts.push(`--- ${LABELS[key]} ---\\n${body}\\n--- end ---`);
    sections.push(key);
  };

  add('agents_admin', renderValues(input.adminPolicy));
  add('agents_user', renderValues(input.userPolicy));
  add('soul', renderValues(input.soul));
  add('user', renderValues(input.user));

  if (input.memories.length) {
    add('memory', input.memories.map((m) => `- ${m.content}  (${m.provenance})`).join('\\n'));
  }

  return { text: parts.join('\\n\\n'), sections };
}"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Learning.
# --------------------------------------------------------------------------
if should_run; then mut "the model's reply is learned from, not the person's message"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("      const learned = await learnFromTurn(db, { userId, inbound: args.inbound });","      const learned = await learnFromTurn(db, { userId, inbound: res.text });",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# The early return for 'off' is defence in depth — suggestMemory refuses too —
# so removing it changes nothing observable. The real control in this function
# is what happens when a person has NO settings row at all.
if should_run; then mut "a person with no settings defaults to automatic"
python3 - <<'MUT'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("  const mode = settings?.memory_mode ?? 'manual';","  const mode = settings?.memory_mode ?? 'automatic';",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a question is treated as a durable fact"
python3 - <<'MUT'
p='packages/persona/src/extract.ts'; s=open(p).read()
s=s.replace("    if (TRANSIENT.some((re) => re.test(sentence))) continue;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "sensitive categories are kept"
python3 - <<'MUT'
p='packages/persona/src/extract.ts'; s=open(p).read()
s=s.replace("    if (SENSITIVE.some((re) => re.test(sentence))) continue;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a credential in conversation is kept"
python3 - <<'MUT'
p='packages/persona/src/extract.ts'; s=open(p).read()
s=s.replace("    if (refuseSecret(sentence)) continue;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a password stated in prose is not recognised"
python3 - <<'MUT'
p='packages/persona/src/memory.ts'; s=open(p).read()
s=s.replace("  { name: 'a password', re: /\\b(pass(word|wd)|passphrase|api key|secret key|access key)\\b[\\s:=]+\\S{6,}/i },","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "there is no cap on what one turn may learn"
python3 - <<'MUT'
p='packages/persona/src/extract.ts'; s=open(p).read()
s=s.replace("    if (out.length >= MAX_CANDIDATES_PER_TURN) break;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "extraction accepts third-person claims, not only self-statements"
python3 - <<'MUT'
p='packages/persona/src/extract.ts'; s=open(p).read()
s=s.replace("  { re: /\\bi (?:prefer|always want|would rather) ([^.!?\\n]{3,120})/i, kind: 'preference', confidence: 0.7 },","  { re: /\\b(?:i|they|he|she|the user) (?:prefer|prefers|always want|would rather) ([^.!?\\n]{3,120})/i, kind: 'preference', confidence: 0.7 },",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Relevance.
# --------------------------------------------------------------------------
if should_run; then mut "memory retrieval requires every word of the request"
python3 - <<'MUT'
p='packages/persona/src/memory.ts'; s=open(p).read()
s=s.replace("  const anyOf = terms.join(' or ');","  const anyOf = terms.join(' ');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the whole memory store is returned regardless of the request"
python3 - <<'MUT'
p='packages/persona/src/memory.ts'; s=open(p).read()
s=s.replace("       and to_tsvector('english', content) @@ websearch_to_tsquery('english', $2)","       and ($2 is not null)",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 999 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
