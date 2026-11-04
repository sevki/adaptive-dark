// Builds the browser-specific extensions into dist/<target>/.
//
//   node scripts/build-extension.js            # all targets
//   node scripts/build-extension.js firefox    # one target
//
// extension/ holds the shared sources and a base manifest; each target adds
// what only it understands (Firefox: background scripts + gecko settings;
// Chrome: a background service worker). The engine is copied from src/.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const TARGETS = {
  firefox(manifest) {
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'adaptive-dark@sevki.io',
        // 140 (ESR) / 142 (Android) are the first versions supporting the
        // data_collection_permissions declaration addons.mozilla.org requires.
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
    return manifest;
  },
  chrome(manifest) {
    manifest.background = { service_worker: 'background.js' };
    manifest.minimum_chrome_version = '111';
    return manifest;
  },
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else if (entry.name !== 'manifest.json') fs.copyFileSync(a, b);
  }
}

function build(target) {
  const out = path.join(root, 'dist', target);
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(path.join(root, 'extension'), out);
  fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
  for (const f of ['color.js', 'engine.js']) {
    fs.copyFileSync(path.join(root, 'src', f), path.join(out, 'lib', f));
  }
  const base = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  if (base.version !== pkg.version) {
    throw new Error(`extension/manifest.json version ${base.version} != package.json version ${pkg.version}`);
  }
  const manifest = TARGETS[target](base);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`built dist/${target}`);
}

const wanted = process.argv.slice(2);
for (const t of wanted.length ? wanted : Object.keys(TARGETS)) {
  if (!TARGETS[t]) throw new Error(`unknown target ${t}; expected one of ${Object.keys(TARGETS).join(', ')}`);
  build(t);
}
