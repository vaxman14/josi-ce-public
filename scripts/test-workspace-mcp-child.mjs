#!/usr/bin/env node
// Real subscription-harness boundary: an actual Josi MCP stdio child, a real
// PostgreSQL database, and a real read-only bind mounted at exact /workspace.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectFromEnv } from '../packages/core/dist/index.js';
import { createUser } from '../packages/auth/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'josi-mcp-workspace-'));
const workspace = join(scratch, 'workspace');
const contextDir = join(scratch, 'context');
const network = `josi-mcp-test-${randomUUID().slice(0, 8)}`;
const postgresName = `${network}-db`;
const dependencies = `${network}-node-modules`;
const sentinel = `subscription child sentinel ${randomUUID()}`;
let connection;

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = spawnSync('docker', ['exec', postgresName, 'pg_isready', '-U', 'postgres', '-d', 'josi'], { stdio: 'ignore' });
    if (ready.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('disposable PostgreSQL did not become ready');
}

class McpChild {
  constructor(context, label) {
    this.name = `${network}-${label}`;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    const contextPath = join(contextDir, `${label}.json`);
    const callsPath = join(contextDir, `${label}.calls.jsonl`);
    writeFileSync(callsPath, '', { mode: 0o600 });
    writeFileSync(contextPath, JSON.stringify({ ...context, callsPath: `/context/${label}.calls.jsonl` }), { mode: 0o600 });
    const uid = String(process.getuid?.() ?? 1000);
    const gid = String(process.getgid?.() ?? 1000);
    this.child = spawn('docker', [
      'run', '--rm', '-i', '--name', this.name, '--network', network,
      '--user', `${uid}:${gid}`, '--read-only',
      '--mount', `type=bind,src=${root},dst=/app,readonly`,
      '--mount', `type=volume,src=${dependencies},dst=/app/node_modules`,
      '--mount', `type=bind,src=${workspace},dst=/workspace,readonly`,
      '--mount', `type=bind,src=${contextDir},dst=/context`,
      '--env', `JOSI_MCP_CONTEXT=/context/${label}.json`,
      '--workdir', '/app', 'node:22-bookworm-slim',
      'node', '/app/packages/agent/dist/mcp/server.js',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.stdout.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); pending.resolve(message); }
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${this.stderr}`));
      }, 20_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveCall(value); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    const initialized = await this.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'workspace-regression', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'josi-tools');
    const mounts = JSON.parse(command('docker', ['inspect', this.name, '--format', '{{json .Mounts}}']));
    assert.ok(mounts.some((mount) => mount.Type === 'bind' && mount.Destination === '/workspace' && mount.RW === false), 'exact read-only /workspace bind missing');
  }

  async tool(name, args) {
    const response = await this.call('tools/call', { name, arguments: args });
    assert.ok(response.result?.content?.[0]?.text, JSON.stringify(response));
    return { result: JSON.parse(response.result.content[0].text), isError: response.result.isError === true };
  }

  async close() {
    this.child.stdin.end();
    const code = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); reject(new Error(`MCP child would not exit: ${this.stderr}`)); }, 20_000);
      this.child.once('close', (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
    });
    assert.equal(code, 0, this.stderr);
  }
}

try {
  command('docker', ['info']);
  command('docker', ['network', 'create', network]);
  command('docker', ['volume', 'create', dependencies]);
  command('docker', [
    'run', '--rm', '--mount', `type=bind,src=${root},dst=/app,readonly`,
    '--mount', `type=volume,src=${dependencies},dst=/app/node_modules`,
    '--workdir', '/app', 'node:22-bookworm-slim', 'npm', 'ci', '--ignore-scripts',
  ]);
  command('docker', [
    'run', '-d', '--name', postgresName, '--network', network,
    '-e', 'POSTGRES_PASSWORD=josi-test', '-e', 'POSTGRES_DB=josi',
    '-p', '127.0.0.1::5432', 'postgres:16-alpine',
  ]);
  await waitForPostgres();
  const portLine = command('docker', ['port', postgresName, '5432/tcp']);
  const port = portLine.slice(portLine.lastIndexOf(':') + 1);
  // Assemble the synthetic credential separately so repository secret scans
  // do not have to exempt password-bearing DSN literals, even in tests.
  const syntheticDatabaseAuth = 'postgres:josi-test';
  const hostDatabaseUrl = `postgresql://${syntheticDatabaseAuth}@127.0.0.1:${port}/josi`;
  let migrated = false;
  for (let attempt = 0; attempt < 20 && !migrated; attempt++) {
    const result = spawnSync(process.execPath, ['packages/db/migrate.mjs'], {
      cwd: root, env: { ...process.env, DATABASE_URL: hostDatabaseUrl }, encoding: 'utf8',
    });
    if (result.status === 0) migrated = true;
    else {
      if (!/starting up|connection refused|ECONNREFUSED/i.test(`${result.stderr}${result.stdout}`)) {
        throw new Error(`database migration failed: ${result.stderr || result.stdout}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  assert.equal(migrated, true, 'disposable database never became migration-ready');

  connection = await connectFromEnv({ DATABASE_URL: hostDatabaseUrl }, { max: 2 });
  const user = await createUser(connection.db, { email: 'mcp-workspace@test.invalid', username: 'mcp-workspace', role: 'super_admin' });
  await connection.db.query('insert into storage_capabilities(user_id,may_map_local) values($1,true)', [user.id]);
  const [storageRoot] = await connection.db.query("insert into storage_roots(label,container_path,purpose,writable,enabled) values('Workspace','/workspace','MCP child regression',false,true) returning id");
  const [mapping] = await connection.db.query("insert into folder_mappings(owner_user_id,provider,root_id,relative_path,display_path,recursive) values($1,'local',$2,'','/workspace',true) returning id", [user.id, storageRoot.id]);

  command('mkdir', ['-p', workspace, contextDir]);
  chmodSync(contextDir, 0o700);
  writeFileSync(join(workspace, 'SENTINEL.txt'), `${sentinel}\n`, { mode: 0o600 });
  const baseContext = {
    databaseUrl: `postgresql://${syntheticDatabaseAuth}@${postgresName}:5432/josi`, passwordFile: null, masterKeyPath: null,
    userId: user.id, sessionKey: 'mcp-workspace-test', threadId: null,
    durableTurnId: null, durableLeaseToken: null, latestUserText: 'Read SENTINEL.txt', effectiveNow: null,
    tools: ['list_workspace_mappings', 'workspace_read'],
  };

  const enabled = new McpChild({ ...baseContext, workspaceEnabled: true, workspaceMode: 'ro' }, 'enabled');
  await enabled.initialize();
  const listed = await enabled.tool('list_workspace_mappings', {});
  assert.equal(listed.isError, false);
  assert.equal(listed.result.mappings[0].mapping_id, mapping.id);
  const read = await enabled.tool('workspace_read', { mapping_id: mapping.id, path: 'SENTINEL.txt' });
  assert.equal(read.isError, false);
  assert.equal(read.result.text, `${sentinel}\n`);
  assert.equal(read.result.mapping_id, mapping.id);
  await enabled.close();

  for (const [label, state] of [['disabled', { workspaceEnabled: false, workspaceMode: 'ro' }], ['absent', {}]]) {
    const child = new McpChild({ ...baseContext, ...state }, label);
    await child.initialize();
    const refusal = await child.tool('workspace_read', { mapping_id: mapping.id, path: 'SENTINEL.txt' });
    assert.equal(refusal.isError, true);
    assert.match(refusal.result.message, /Workspace unavailable or permission revoked/);
    await child.close();
  }

  const events = await connection.db.query("select kind,subject_id from events where actor_user_id=$1 and kind='workspace.file_read'", [user.id]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'workspace.file_read');
  assert.equal(events[0].subject_id, mapping.id);
  const calls = readFileSync(join(contextDir, 'enabled.calls.jsonl'), 'utf8');
  assert.match(calls, /"name":"workspace_read"/);
  assert.match(calls, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  console.log(JSON.stringify({ ok: true, mapping_id: mapping.id, event: 'workspace.file_read', sentinel, disabledRefused: true, absentRefused: true }));
} finally {
  if (connection) await connection.close().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', postgresName], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', dependencies], { stdio: 'ignore' });
  rmSync(scratch, { recursive: true, force: true });
}
