// End-to-end tests of the built Firefox extension (dist/firefox) running in
// real Firefox, driven over WebDriver BiDi by puppeteer-core (no geckodriver).
//
// Needs a Firefox binary: set FIREFOX_BIN, or have `firefox` on PATH.
// Build first: npm run build
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'firefox');

function findFirefox() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  try { return execFileSync('sh', ['-c', 'command -v firefox'], { encoding: 'utf8' }).trim() || null; } catch (e) { return null; }
}
const FIREFOX = findFirefox();
let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch (e) { /* skipped below */ }
const skip = !FIREFOX ? 'no Firefox (set FIREFOX_BIN)'
  : !puppeteer ? 'puppeteer-core not installed'
  : !fs.existsSync(path.join(EXT, 'manifest.json')) ? 'dist/firefox missing (npm run build)'
  : false;

const PAGES = {
  '/plain.html': `<!doctype html><title>plain</title>
    <style>body{background:#fff;color:#222} .card{background:#f2f2f2;border:1px solid #ccc}</style>
    <body><h1>Plain</h1><p id=t>text</p><div class=card id=card>card</div>`,
  '/light-only.html': `<!doctype html><meta name="color-scheme" content="light only">
    <style>body{background:#fff;color:#222}</style><body><p>stay light</p>`,
  '/supports-dark.html': `<!doctype html><meta name="color-scheme" content="light dark">
    <style>body{background:#fff;color:#222}</style><body><p>own scheme</p>`,
  '/cross.html': (other) => `<!doctype html><link rel=stylesheet href="http://127.0.0.1:${other}/remote.css">
    <body><div class=x id=x>remote styles</div>`,
};

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let browser, site, cdn;

test.before(async () => {
  if (skip) return;
  cdn = await serve((req, res) => {
    // Deliberately no CORS headers: the page can't read these rules, so the
    // extension's background script must fetch them.
    if (req.url === '/remote.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body{background:#ffffff} .x{background:#eeeeee;color:#111111}');
    }
    res.writeHead(404); res.end();
  });
  site = await serve((req, res) => {
    const url = req.url.split('?')[0];
    let body = PAGES[url];
    if (typeof body === 'function') body = body(cdn.address().port);
    if (body) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(body); }
    const file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end();
  });
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: true,
    extraPrefsFirefox: {
      // Dark appearance for web content, i.e. prefers-color-scheme: dark.
      'layout.css.prefers-color-scheme.content-override': 0,
      'ui.systemUsesDarkTheme': 1,
      // Grant the MV3 host permissions without the install prompt.
      'extensions.originControls.grantByDefault': true,
    },
  });
  await browser.installExtension(EXT);
});

test.after(async () => {
  if (browser) await browser.close();
  if (site) site.close();
  if (cdn) cdn.close();
});

const url = (p) => `http://127.0.0.1:${site.address().port}${p}`;

async function visit(p) {
  const page = await browser.newPage();
  await page.goto(url(p), { waitUntil: 'load' });
  return page;
}

/** OKLab-ish lightness proxy good enough to tell dark from light. */
const lum = `(s) => { const m = s.match(/[\\d.]+/g).map(Number); return (0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2]) / 255; }`;

async function waitForDark(page, selector, prop = 'backgroundColor', timeout = 5000) {
  await page.waitForFunction(`(${lum})(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${prop}) < 0.3`, { timeout, polling: 100 });
}

test('darkens a plain light page', { skip }, async () => {
  const page = await visit('/plain.html');
  await waitForDark(page, 'body');
  const r = await page.evaluate(`(() => {
    const L = ${lum};
    return { body: L(getComputedStyle(document.body).backgroundColor), text: L(getComputedStyle(document.getElementById('t')).color),
             card: L(getComputedStyle(document.getElementById('card')).backgroundColor) };
  })()`);
  assert.ok(r.body < 0.3, JSON.stringify(r));
  assert.ok(r.text > 0.6, JSON.stringify(r));
  assert.ok(r.card > r.body, 'card stays distinguishable from the page');
  await page.close();
});

test('demo page: opt-outs, logos and contrast inside the content script', { skip }, async () => {
  const page = await visit('/demo/index.html?ext');
  await waitForDark(page, 'body');
  await new Promise((r) => setTimeout(r, 800));
  const r = await page.evaluate(`(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s));
    return { keep: cs('#keep').backgroundColor, own: cs('#own').backgroundColor,
             logo: document.querySelector('#logo').classList.contains('adm-invert'),
             blend: cs('.blend').mixBlendMode };
  })()`);
  assert.strictEqual(r.keep, 'rgb(255, 251, 230)', 'light only element stays light');
  assert.strictEqual(r.own, 'rgb(16, 32, 48)', 'light dark element keeps its own dark style');
  assert.strictEqual(r.logo, true, 'black-and-white logo inverted');
  assert.strictEqual(r.blend, 'normal');
  await page.close();
});

test('leaves light-only and dark-capable pages alone', { skip }, async () => {
  for (const p of ['/light-only.html', '/supports-dark.html']) {
    const page = await visit(p);
    await new Promise((r) => setTimeout(r, 1000));
    const bg = await page.evaluate('getComputedStyle(document.body).backgroundColor');
    assert.strictEqual(bg, 'rgb(255, 255, 255)', p);
    await page.close();
  }
});

test('cross-origin stylesheets are fetched by the background script', { skip }, async () => {
  const page = await visit('/cross.html');
  await waitForDark(page, '#x');
  const color = await page.evaluate(`(${lum})(getComputedStyle(document.getElementById('x')).color)`);
  assert.ok(color > 0.6, String(color));
  await page.close();
});
