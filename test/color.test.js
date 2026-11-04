const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');

const close = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const rgb = (s) => C.parseColor(s);

test('parses common color syntaxes', () => {
  assert.deepStrictEqual(rgb('#fff'), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepStrictEqual(rgb('#00000080').a, 128 / 255);
  assert.deepStrictEqual(rgb('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepStrictEqual(rgb('rgb(255 0 0 / 50%)'), { r: 1, g: 0, b: 0, a: 0.5 });
  assert.deepStrictEqual(rgb('rgba(0,0,255,.25)'), { r: 0, g: 0, b: 1, a: 0.25 });
  const h = rgb('hsl(120 100% 25%)');
  assert.ok(close(h.r, 0) && close(h.g, 0.5) && close(h.b, 0));
  assert.deepStrictEqual(rgb('RebeccaPurple'), rgb('#663399'));
  assert.strictEqual(rgb('transparent').a, 0);
  const ok = rgb('oklch(62.8% 0.2577 29.23)');
  assert.ok(close(ok.r, 1, 0.02) && close(ok.g, 0, 0.02) && close(ok.b, 0, 0.02));
  for (const bad of ['currentcolor', 'var(--x)', 'rgb(var(--x))', 'canvastext', 'light-dark(#fff, #000)', '#ggg', 'nope']) {
    assert.strictEqual(rgb(bad), null, bad);
  }
});

test('OKLCH round trip', () => {
  for (const s of ['#0a66c2', '#ffe58f', '#123456', '#ff0000', '#777']) {
    const c = rgb(s);
    const back = C.fromOklch(C.toOklch(c));
    assert.ok(close(c.r, back.r, 0.002) && close(c.g, back.g, 0.002) && close(c.b, back.b, 0.002), s);
  }
});

test('WCAG contrast', () => {
  assert.ok(close(C.contrast(rgb('#000'), rgb('#fff')), 21, 0.01));
  assert.ok(close(C.contrast(rgb('#777'), rgb('#fff')), 4.48, 0.01));
});

test('backgrounds become dark, text becomes light', () => {
  const bg = C.transformColor(rgb('#fff'), 'bg');
  const fg = C.transformColor(rgb('#000'), 'fg');
  assert.ok(C.srgbToOklab(bg).L < 0.25);
  assert.ok(C.srgbToOklab(fg).L > 0.9);
  assert.ok(C.contrast(fg, bg) >= 12);
});

test('hue is preserved', () => {
  for (const s of ['#0a66c2', '#b00020', '#2e7d32', '#ffe58f', '#e8f4ff']) {
    for (const role of ['bg', 'fg', 'border']) {
      const a = C.toOklch(rgb(s)), b = C.toOklch(C.transformColor(rgb(s), role));
      if (a.C < 0.02 || b.C < 0.02) continue;
      const d = Math.abs(((a.h - b.h + 540) % 360) - 180);
      assert.ok(d < 6, `${s} ${role}: ${a.h} → ${b.h}`);
    }
  }
});

test('lightness order of light surfaces is kept and they stay distinguishable', () => {
  const page = C.srgbToOklab(C.transformColor(rgb('#ffffff'), 'bg')).L;
  const panel = C.srgbToOklab(C.transformColor(rgb('#f4f6f8'), 'bg')).L;
  const hover = C.srgbToOklab(C.transformColor(rgb('#e5e5ea'), 'bg')).L;
  assert.ok(page < panel && panel < hover);
  assert.ok(panel - page > 0.03);
});

test('semantic (saturated) backgrounds keep identity and stay dark enough for white text', () => {
  const btn = C.transformColor(rgb('#0a66c2'), 'bg');
  const white = C.transformColor(rgb('#fff'), 'fg');
  assert.ok(C.toOklch(btn).C > 0.08);
  assert.ok(C.contrast(btn, rgb('#fff')) >= 4.5);
  assert.ok(white); // white text maps to dark; contrast pass fixes per element
});

test('alpha is preserved, transparent stays transparent, shadows stay dark', () => {
  assert.strictEqual(C.transformColor(rgb('rgba(255,255,255,.5)'), 'bg').a, 0.5);
  assert.strictEqual(C.transformColor(rgb('transparent'), 'bg').a, 0);
  const sh = C.transformColor(rgb('rgba(0,0,0,.1)'), 'shadow');
  assert.ok(C.srgbToOklab(sh).L < 0.1 && sh.a > 0.1);
});

test('ensureContrast reaches the target with minimal change', () => {
  const bg = rgb('#1a1a1a');
  const fixed = C.ensureContrast(rgb('#444'), bg, 4.5);
  const c = C.contrast(fixed, bg);
  assert.ok(c >= 4.5 && c < 4.7, String(c));
  const blue = C.ensureContrast(rgb('#0000ee'), bg, 4.5);
  assert.ok(C.contrast(blue, bg) >= 4.5);
  assert.ok(Math.abs(C.toOklch(blue).h - C.toOklch(rgb('#0000ee')).h) < 8);
});

test('rewriteValue handles gradients, shadows, var() and url()', () => {
  const ctx = {
    transform: (c, role) => C.transformColor(c, role),
    colorVars: new Set(['--brand']),
    baseURL: 'https://example.com/css/site.css',
  };
  const g = C.rewriteValue('linear-gradient(to right, #fff 0%, white 50%, rgba(0, 0, 0, .5))', 'bg', ctx);
  assert.ok(g.changed);
  assert.match(g.text, /^linear-gradient\(to right, rgb\(\d+, \d+, \d+\) 0%, rgb\(\d+, \d+, \d+\) 50%, rgba\(/);
  assert.ok(!/#fff|white/.test(g.text));

  const v = C.rewriteValue('var(--brand)', 'fg', ctx);
  assert.strictEqual(v.text, 'var(--adm-fg-brand, var(--brand))');
  const notColor = C.rewriteValue('var(--size, 10px)', 'fg', ctx);
  assert.strictEqual(notColor.changed, false);
  const fb = C.rewriteValue('var(--other, #000)', 'fg', ctx);
  assert.ok(fb.changed && /^var\(--other, rgb\(/.test(fb.text));

  const u = C.rewriteValue('url(../img/a.png) #fff', 'bg', ctx);
  assert.match(u.text, /^url\("https:\/\/example.com\/img\/a.png"\) rgb\(/);

  const untouched = C.rewriteValue('10px solid currentcolor', 'border', ctx);
  assert.strictEqual(untouched.changed, false);
  assert.strictEqual(untouched.text, '10px solid currentcolor');
  // Identifiers that merely contain color names are left alone.
  assert.strictEqual(C.rewriteValue('to bottom-left', 'bg', ctx).changed, false);
  assert.strictEqual(C.rewriteValue('var(--red)', 'bg', ctx).text, 'var(--red)');
});
