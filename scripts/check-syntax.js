// Parses every first-party JS file so a syntax error fails fast in CI.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [];
for (const dir of ['src', 'extension', 'scripts', 'test']) {
  for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
}
for (const f of files) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length} files`);
