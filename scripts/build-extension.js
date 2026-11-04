// Copies the engine into extension/lib so the unpacked extension is
// self-contained. Run: npm run build
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const lib = path.join(root, 'extension', 'lib');
fs.mkdirSync(lib, { recursive: true });
for (const f of ['color.js', 'engine.js']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(lib, f));
}
console.log('extension/lib updated');
