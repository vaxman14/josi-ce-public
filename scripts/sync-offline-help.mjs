import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/build-offline-docs.mjs'], { cwd: root, stdio: 'inherit' });
const source = path.join(root, 'docs-site/offline');
const target = path.join(root, 'apps/web/public/help');
// A fixed set, not a recursive copy: adding a file to Help must be an explicit
// review of public and service-worker cache surfaces.
for (const file of ['index.html', 'install/index.html', 'legal/index.html', 'brand/josi-mark.png']) {
  const output = path.join(target, file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(path.join(source, file), output);
}
console.log('web_help=generated');
