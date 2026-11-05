// Zips a directory with the system `zip` tool (present on CI runners), for
// the Chrome Web Store upload. Usage: node scripts/zip-dir.js <dir> <out.zip>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: zip-dir.js <dir> <out.zip>');
const dest = path.resolve(out);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { force: true });
execFileSync('zip', ['-r', '-X', '-q', dest, '.'], { cwd: dir, stdio: 'inherit' });
console.log(`wrote ${out}`);
