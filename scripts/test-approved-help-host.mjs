import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const directory = fs.mkdtempSync(path.join(fileURLToPath(root), 'docs-site/.scan-host-test-'));
const fixture = path.join(directory, 'sample.txt');
function scan(text) {
  fs.writeFileSync(fixture, text);
  return spawnSync('bash', ['scripts/scan-secrets.sh', fixture], { cwd: root, encoding: 'utf8' }).status;
}
try {
  assert.equal(scan('https://help.heyjosi.com/install/'), 0, 'The approved CE Help hostname should be allowed');
  assert.notEqual(scan('https://' + ['ce', 'heyjosi', 'com'].join('.')), 0);
  assert.notEqual(scan('https://' + ['heyjosi', 'com'].join('.')), 0);
  assert.notEqual(scan('https://help.heyjosi.com' + '.evil/'), 0);
  assert.notEqual(scan('https://' + ['socalreceptionist', 'com'].join('.')), 0);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('approved_help_host_scan=pass');
