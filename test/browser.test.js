// End-to-end tests in Chromium via Playwright (pre-installed or devDependency).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { /* skipped below */ }

const ROOT = path.join(__dirname, '..');
const SRC = {
  '/src/color.js': fs.readFileSync(path.join(ROOT, 'src/color.js'), 'utf8'),
  '/src/engine.js': fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8'),
};
const SCRIPTS = '<script src="/src/color.js"></script><script src="/src/engine.js"></script>';

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

/** Opens `html` at https://site.test/ with extra routes {path: [type, body]}. */
async function open(html, routes = {}, opts = {}) {
  const page = await browser.newPage({ colorScheme: 'dark', viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.route('https://**/*', (route) => {
    const u = new URL(route.request().url());
    if (SRC[u.pathname]) return route.fulfill({ contentType: 'text/javascript', body: SRC[u.pathname] });
    const r = routes[u.host + u.pathname] || (u.host === 'site.test' && u.pathname === '/' && ['text/html', html]);
    if (r) return route.fulfill({ contentType: r[0], body: r[1], headers: r[2] || {} });
    return route.fulfill({ status: 404, body: '' });
  });
  if (opts.file) await page.goto('file://' + opts.file);
  else await page.goto('https://site.test/');
  page.errors = errors;
  return page;
}

const settle = (page) => page.waitForTimeout(400);

const helpers = `
  window.L = (s) => { const c = AdaptiveDark.color.parseColor(s); return AdaptiveDark.color.srgbToOklab(c).L; };
  window.cs = (sel) => getComputedStyle(document.querySelector(sel));
`;

const skip = !chromium && 'playwright not installed';

test('demo page: transforms a light page following the article', { skip }, async () => {
  const page = await open(null, {}, { file: path.join(ROOT, 'demo/index.html') });
  await settle(page);
  await page.addScriptTag({ content: helpers });
  const r = await page.evaluate(() => ({
    decision: adm.lastAnalysis.decision,
    bodyL: L(cs('body').backgroundColor),
    brandAuthored: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    keepBg: cs('#keep').backgroundColor,
    ownBg: cs('#own').backgroundColor,
    blend: cs('.blend').mixBlendMode,
    iconL: L(getComputedStyle(document.querySelector('#icon path')).fill),
    colorful: getComputedStyle(document.querySelector('#colorful circle')).fill,
    logo: document.querySelector('#logo').classList.contains('adm-invert'),
    photo: document.querySelector('#photo').classList.contains('adm-invert'),
    canvasPixel: Array.from(document.querySelector('#cv').getContext('2d').getImageData(2, 2, 1, 1).data),
    // Every text element must meet 4.5:1 (3:1 large) against its background.
    failures: (() => {
      const C = AdaptiveDark.color, out = [];
      for (const el of document.querySelectorAll('main *, header *')) {
        if (el.closest('[data-adm-optout]') || el.closest('svg')) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none') continue;
        const bg = adm.effectiveBackground(el).color;
        const ratio = C.contrast(C.blend(C.parseColor(s.color), bg), bg);
        const large = parseFloat(s.fontSize) >= 24 || (parseInt(s.fontWeight) >= 700 && parseFloat(s.fontSize) >= 18.66);
        if (ratio < (large ? 3 : 4.5) - 0.01) out.push(`${el.tagName}.${el.className}: ${ratio.toFixed(2)}`);
      }
      return out;
    })(),
  }));
  assert.strictEqual(r.decision, 'transform');
  assert.ok(r.bodyL < 0.3, 'page background is dark');
  assert.strictEqual(r.brandAuthored, '#0a66c2', 'authored custom property untouched');
  assert.strictEqual(r.keepBg, 'rgb(255, 251, 230)', 'light only element stays light');
  assert.strictEqual(r.ownBg, 'rgb(16, 32, 48)', 'light dark element uses its own dark styles');
  assert.strictEqual(r.blend, 'normal', 'mix-blend-mode disabled');
  assert.ok(r.iconL > 0.6, 'monochrome svg icon recolored');
  assert.strictEqual(r.colorful, 'rgb(255, 149, 0)', 'colorful svg untouched');
  assert.strictEqual(r.logo, true, 'black-on-transparent logo inverted');
  assert.strictEqual(r.photo, false, 'photo untouched');
  assert.deepStrictEqual(r.canvasPixel, [255, 255, 255, 255], 'canvas untouched');
  assert.deepStrictEqual(r.failures, []);
  assert.deepStrictEqual(page.errors, []);

  // Hover states keep working because selectors are mirrored, not resolved.
  const before = await page.evaluate(() => cs('.btn').backgroundColor);
  await page.hover('.btn');
  const after = await page.evaluate(() => cs('.btn').backgroundColor);
  assert.notStrictEqual(before, after);
  await page.close();
});

test('pages that support dark mode are left alone', { skip }, async () => {
  for (const head of [
    '<meta name="color-scheme" content="light dark">',
    '<style>:root{color-scheme: light dark}</style>',
  ]) {
    const page = await open(`<!doctype html>${head}<body style="background:#fff">x${SCRIPTS}`);
    const r = await page.evaluate(() => { const e = AdaptiveDark.create(document); const a = e.enable(); return [a.decision, document.adoptedStyleSheets.length]; });
    assert.deepStrictEqual(r, ['supports-dark', 0], head);
    await page.close();
  }
});

test('color-scheme: light only opts the page out', { skip }, async () => {
  for (const head of [
    '<meta name="color-scheme" content="light only">',
    '<style>:root{color-scheme: light only}</style>',
  ]) {
    const page = await open(`<!doctype html>${head}<body>x${SCRIPTS}`);
    const r = await page.evaluate(() => AdaptiveDark.create(document).enable().decision);
    assert.strictEqual(r, 'opt-out', head);
    await page.close();
  }
});

test('already-dark pages are left alone', { skip }, async () => {
  const page = await open(`<!doctype html><body style="background:#111;color:#eee"><p>dark</p>${SCRIPTS}`);
  const r = await page.evaluate(() => AdaptiveDark.create(document).enable().decision);
  assert.strictEqual(r, 'already-dark');
  await page.close();
});

test('dynamic content, inserted stylesheets and CSSOM insertRule', { skip }, async () => {
  const page = await open(`<!doctype html><style id=s>.a{background:#fff;color:#222}</style><body><div class=a>a</div>${SCRIPTS}`);
  await page.addScriptTag({ content: helpers });
  await page.evaluate(() => { window.e = AdaptiveDark.create(document); e.enable(); });
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'late'; d.style.background = '#fafafa'; d.style.color = 'black'; d.textContent = 'late';
    document.body.append(d);
    const st = document.createElement('style'); st.textContent = '.b{background:lightyellow}';
    document.head.append(st);
    const b = document.createElement('div'); b.className = 'b'; b.textContent = 'b'; document.body.append(b);
    document.getElementById('s').sheet.insertRule('.c{background:white}');
    const c = document.createElement('div'); c.className = 'c'; c.textContent = 'c'; document.body.append(c);
  });
  await page.waitForTimeout(1800); // covers the CSSOM poll
  const r = await page.evaluate(() => ({ late: L(cs('#late').backgroundColor), lateText: L(cs('#late').color), b: L(cs('.b').backgroundColor), c: L(cs('.c').backgroundColor) }));
  assert.ok(r.late < 0.35 && r.lateText > 0.8, JSON.stringify(r));
  assert.ok(r.b < 0.4, 'inserted <style> handled');
  assert.ok(r.c < 0.35, 'insertRule handled');
  await page.close();
});

test('cross-origin stylesheets go through the fetchText hook', { skip }, async () => {
  const page = await open(
    `<!doctype html><link rel=stylesheet href="https://cdn.test/site.css"><body><div class=x>x</div>${SCRIPTS}`,
    { 'cdn.test/site.css': ['text/css', 'body{background:#fff} .x{background:#f0f0f0;color:#000}'] },
  );
  await page.addScriptTag({ content: helpers });
  // cssRules of the cross-origin sheet throws; the hook (the extension's
  // background worker in practice) supplies the text instead.
  await page.evaluate(() => {
    window.e = AdaptiveDark.create(document, {
      fetchText: () => Promise.resolve('body{background:#fff} .x{background:#f0f0f0;color:#000}'),
    });
    e.enable({ force: true });
  });
  await settle(page);
  const r = await page.evaluate(() => ({ body: L(cs('body').backgroundColor), x: L(cs('.x').color) }));
  assert.ok(r.body < 0.3 && r.x > 0.8, JSON.stringify(r));
  await page.close();
});

test('disable() restores the page', { skip }, async () => {
  const page = await open(`<!doctype html><body style="background:#fff"><p style="color:#333">t</p>${SCRIPTS}`);
  const r = await page.evaluate(() => {
    const e = AdaptiveDark.create(document); e.enable();
    const on = getComputedStyle(document.body).backgroundColor;
    e.disable();
    return [on, getComputedStyle(document.body).backgroundColor, document.querySelectorAll('[data-adm-id]').length, document.adoptedStyleSheets.length];
  });
  assert.notStrictEqual(r[0], 'rgb(255, 255, 255)');
  assert.deepStrictEqual(r.slice(1), ['rgb(255, 255, 255)', 0, 0]);
  await page.close();
});
