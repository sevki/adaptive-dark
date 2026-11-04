/*
 * Adaptive Dark Mode: color math.
 *
 * Pure functions with no DOM access. Covers parsing CSS colors, converting
 * between sRGB and OKLab/OKLCH, WCAG contrast, the role-based lightness
 * inversion ("hue preserved, luminosity inverted") and rewriting color
 * tokens inside arbitrary CSS values (gradients, shadows, var() references).
 *
 * Works as a classic script (exposes globalThis.AdaptiveDarkColor) and as a
 * CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptiveDarkColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Named colors
  // ---------------------------------------------------------------------------
  const NAMED = {
    aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
    azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
    blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
    burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
    coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
    cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
    darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
    darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
    darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
    darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
    deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
    dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
    fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
    goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
    grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
    indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
    lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
    lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
    lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
    lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
    lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
    linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
    mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
    mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
    midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
    navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000,
    olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6,
    palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
    papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb,
    plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399,
    red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513,
    salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee,
    sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
    slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
    steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8,
    tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3,
    white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
  };

  const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'oklab', 'oklch']);

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  function parseHex(hex) {
    const h = hex.replace(/^#/, '');
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    let r, g, b, a = 1;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
      if (h.length === 4) a = parseInt(h[3] + h[3], 16) / 255;
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else return null;
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }

  // Splits "a b c / d" or "a, b, c, d" into component tokens + alpha token.
  function splitArgs(inner) {
    let parts, alpha;
    if (inner.includes(',')) {
      parts = inner.split(',').map((s) => s.trim());
      if (parts.length === 4) alpha = parts.pop();
    } else {
      const [main, a] = inner.split('/');
      parts = main.trim().split(/\s+/);
      if (a !== undefined) alpha = a.trim();
    }
    if (parts.length !== 3) return null;
    return { parts, alpha };
  }

  function num(tok, percentScale) {
    if (tok === 'none') return 0;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i.exec(tok);
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === '%') return percentScale === undefined ? NaN : (v / 100) * percentScale;
    return v;
  }

  function hue(tok) {
    if (tok === 'none') return 0;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(tok);
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    switch ((m[2] || 'deg').toLowerCase()) {
      case 'rad': return (v * 180) / Math.PI;
      case 'grad': return v * 0.9;
      case 'turn': return v * 360;
      default: return v;
    }
  }

  function alphaOf(tok) {
    if (tok === undefined) return 1;
    const v = num(tok, 1);
    return isNaN(v) ? NaN : clamp(v, 0, 1);
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: f(0), g: f(8), b: f(4) };
  }

  function hwbToRgb(h, w, bl) {
    if (w + bl >= 1) { const g = w / (w + bl); return { r: g, g, b: g }; }
    const c = hslToRgb(h, 1, 0.5);
    const k = 1 - w - bl;
    return { r: c.r * k + w, g: c.g * k + w, b: c.b * k + w };
  }

  /**
   * Parses a CSS color string. Returns {r,g,b,a} (sRGB, 0..1) or null for
   * anything we can't (or shouldn't) resolve statically: currentcolor,
   * system colors, var(), color-mix(), light-dark(), etc.
   */
  function parseColor(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;
    if (s[0] === '#') return parseHex(s);
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (Object.prototype.hasOwnProperty.call(NAMED, s)) {
      const n = NAMED[s];
      return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
    }
    const m = /^([a-z]+)\(([^()]*)\)$/.exec(s);
    if (!m || !COLOR_FUNCTIONS.has(m[1])) return null;
    const args = splitArgs(m[2]);
    if (!args) return null;
    const [p0, p1, p2] = args.parts;
    const a = alphaOf(args.alpha);
    let out;
    switch (m[1]) {
      case 'rgb':
      case 'rgba': {
        const ch = [p0, p1, p2].map((t) => num(t, 255) / 255);
        out = { r: ch[0], g: ch[1], b: ch[2] };
        break;
      }
      case 'hsl':
      case 'hsla': {
        const sat = num(p1, 1), lig = num(p2, 1);
        // Modern syntax allows bare numbers meaning percent.
        const fix = (v, t) => (/%$/.test(t) || t === 'none' ? v : v / 100);
        out = hslToRgb(hue(p0), clamp(fix(sat, p1), 0, 1), clamp(fix(lig, p2), 0, 1));
        break;
      }
      case 'hwb': {
        const fix = (t) => (/%$/.test(t) ? num(t, 1) : num(t) / 100);
        out = hwbToRgb(hue(p0), clamp(fix(p1), 0, 1), clamp(fix(p2), 0, 1));
        break;
      }
      case 'oklab': {
        const L = /%$/.test(p0) ? num(p0, 1) : num(p0);
        const A = num(p1, 0.4), B = num(p2, 0.4);
        out = oklabToSrgb(L, A, B);
        break;
      }
      case 'oklch': {
        const L = /%$/.test(p0) ? num(p0, 1) : num(p0);
        const C = num(p1, 0.4), H = hue(p2);
        const hr = (H * Math.PI) / 180;
        out = oklabToSrgb(L, C * Math.cos(hr), C * Math.sin(hr));
        break;
      }
    }
    if (!out || [out.r, out.g, out.b, a].some((v) => typeof v !== 'number' || isNaN(v))) return null;
    return { r: out.r, g: out.g, b: out.b, a };
  }

  // ---------------------------------------------------------------------------
  // Conversions
  // ---------------------------------------------------------------------------
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function srgbToOklab(c) {
    const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    };
  }

  function oklabToLinear(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    };
  }

  function oklabToSrgb(L, a, b) {
    const lin = oklabToLinear(L, a, b);
    return { r: toGamma(lin.r), g: toGamma(lin.g), b: toGamma(lin.b) };
  }

  function toOklch(c) {
    const { L, a, b } = srgbToOklab(c);
    const C = Math.sqrt(a * a + b * b);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h, alpha: c.a };
  }

  const EPS = 1e-4;
  const inGamut = (lin) => [lin.r, lin.g, lin.b].every((v) => v >= -EPS && v <= 1 + EPS);

  /** OKLCH → sRGB, reducing chroma (keeping L and h) until it fits sRGB. */
  function fromOklch({ L, C, h, alpha }) {
    L = clamp(L, 0, 1);
    const hr = (h * Math.PI) / 180;
    const cos = Math.cos(hr), sin = Math.sin(hr);
    let lin = oklabToLinear(L, C * cos, C * sin);
    if (!inGamut(lin)) {
      let lo = 0, hi = C;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklabToLinear(L, mid * cos, mid * sin))) lo = mid; else hi = mid;
      }
      lin = oklabToLinear(L, lo * cos, lo * sin);
    }
    return {
      r: clamp(toGamma(clamp(lin.r, 0, 1)), 0, 1),
      g: clamp(toGamma(clamp(lin.g, 0, 1)), 0, 1),
      b: clamp(toGamma(clamp(lin.b, 0, 1)), 0, 1),
      a: alpha === undefined ? 1 : alpha,
    };
  }

  function formatColor(c) {
    const r = Math.round(clamp(c.r, 0, 1) * 255);
    const g = Math.round(clamp(c.g, 0, 1) * 255);
    const b = Math.round(clamp(c.b, 0, 1) * 255);
    const a = Math.round(clamp(c.a === undefined ? 1 : c.a, 0, 1) * 1000) / 1000;
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // ---------------------------------------------------------------------------
  // WCAG contrast
  // ---------------------------------------------------------------------------
  function luminance(c) {
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  }

  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Alpha-composites `top` over `bottom` (bottom treated as opaque result). */
  function blend(top, bottom) {
    const a = top.a === undefined ? 1 : top.a;
    const ba = bottom.a === undefined ? 1 : bottom.a;
    const outA = a + ba * (1 - a);
    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, u) => (t * a + u * ba * (1 - a)) / outA;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: outA };
  }

  /**
   * Returns a color with the same hue and chroma as `fg` whose contrast with
   * the opaque color `bg` is at least `target`, changing lightness as little
   * as possible. Moves away from the background's lightness.
   */
  function ensureContrast(fg, bg, target) {
    if (contrast(fg, bg) >= target) return fg;
    const lch = toOklch(fg);
    const bgL = srgbToOklab(bg).L;
    const goLighter = bgL < 0.6;
    const extreme = fromOklch({ ...lch, L: goLighter ? 1 : 0, alpha: fg.a });
    if (contrast(extreme, bg) < target) return extreme;
    let lo = lch.L, hi = goLighter ? 1 : 0;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(fromOklch({ ...lch, L: mid, alpha: fg.a }), bg) >= target) hi = mid; else lo = mid;
    }
    return fromOklch({ ...lch, L: hi, alpha: fg.a });
  }

  // ---------------------------------------------------------------------------
  // The transform: hue preserved, lightness inverted, per role.
  // ---------------------------------------------------------------------------
  const lerp = (a, b, t) => a + (b - a) * t;

  // Output lightness ranges for each role (OKLab L). White backgrounds land
  // on a soft dark gray rather than pure black; black text lands on a soft
  // near-white.
  const ROLE_RANGES = {
    bg: [0.215, 0.86],    // L=1 → 0.215, L=0 → 0.86
    fg: [0.38, 0.95],     // L=1 → 0.38, L=0 → 0.95
    border: [0.32, 0.84],
  };

  // Exponent applied to (1 - L) before mapping. Below 1 it spreads apart the
  // many near-white surfaces of a light page (page vs. panel vs. hover row),
  // which would otherwise collapse onto almost the same dark gray.
  const ROLE_CURVES = { bg: 0.72, border: 0.8, fg: 1 };

  const DEFAULT_OPTIONS = {
    // Chroma above which a background is considered "semantic" (a brand
    // colored button, a badge, a highlight) rather than a neutral surface.
    semanticChroma: 0.075,
  };

  function transformColor(color, role, options) {
    if (!color) return color;
    if (color.a === 0) return color;
    const opts = options || DEFAULT_OPTIONS;
    const lch = toOklch(color);

    if (role === 'shadow') {
      // Shadows stay shadows: dark, a bit stronger to read on dark surfaces.
      return fromOklch({ L: Math.min(lch.L, 0.05), C: 0, h: lch.h, alpha: clamp(lch.alpha * 1.3, 0, 1) });
    }

    const range = ROLE_RANGES[role] || ROLE_RANGES.fg;
    const t = Math.pow(1 - clamp(lch.L, 0, 1), ROLE_CURVES[role] || 1);
    let L = lerp(range[0], range[1], t);
    let C = lch.C;

    if (role === 'bg' && lch.C >= opts.semanticChroma && lch.L > 0.3 && lch.L < 0.9) {
      // Semantic, saturated surfaces keep their identity: same hue, only
      // moderately darkened so light text on them still reads.
      L = clamp(lch.L * 0.72, 0.32, 0.56);
      C = lch.C * 0.92;
    } else if (role === 'bg' && lch.L >= 0.9) {
      // Pale tints (light yellow highlight, light blue panel) become dark
      // tints; keep a hint of chroma so they stay distinguishable.
      C = Math.min(lch.C * 1.6, 0.06);
      L += Math.min(lch.C, 0.15) * 0.5;
    } else if (role === 'fg' || role === 'border') {
      // Dark saturated text (links, error red) gets lighter; boost chroma a
      // touch since light colors look washed out on dark backgrounds.
      C = lch.C * 1.05;
    }
    return fromOklch({ L, C, h: lch.h, alpha: lch.alpha });
  }

  // ---------------------------------------------------------------------------
  // Rewriting colors inside CSS values
  // ---------------------------------------------------------------------------
  function findClose(str, open) {
    let depth = 0;
    for (let i = open; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"' || ch === "'") { i = skipString(str, i) - 1; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i;
    }
    return -1;
  }

  function skipString(str, i) {
    const q = str[i];
    for (let j = i + 1; j < str.length; j++) {
      if (str[j] === '\\') { j++; continue; }
      if (str[j] === q) return j + 1;
    }
    return str.length;
  }

  function splitTopLevelComma(str) {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"' || ch === "'") { i = skipString(str, i) - 1; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) return [str.slice(0, i), str.slice(i + 1)];
    }
    return [str, undefined];
  }

  function resolveURL(raw, base) {
    let u = raw.trim();
    if ((u[0] === '"' || u[0] === "'") && u[u.length - 1] === u[0]) u = u.slice(1, -1);
    if (!base || /^(data:|blob:|#)/i.test(u)) return u;
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  const IDENT = /^-?-?[a-zA-Z_][\w-]*|^--[\w-]*/;

  /**
   * Rewrites every color token in a CSS value for the given role.
   *
   * ctx: {
   *   transform(colorObj, role) → colorObj   (required)
   *   colorVars: Set<string>                 custom properties known to hold colors
   *   baseURL: string                        to absolutize url()
   * }
   * Returns {text, changed}.
   */
  function rewriteValue(value, role, ctx) {
    let out = '', changed = false, i = 0;
    const str = String(value);
    while (i < str.length) {
      const ch = str[i];
      if (ch === '"' || ch === "'") {
        const j = skipString(str, i);
        out += str.slice(i, j); i = j; continue;
      }
      if (ch === '#') {
        const m = /^#[0-9a-fA-F]+(?![\w-])/.exec(str.slice(i));
        const c = m && parseHex(m[0]);
        if (c) {
          out += formatColor(ctx.transform(c, role)); changed = true;
          i += m[0].length; continue;
        }
      }
      // Don't treat digits+unit (e.g. "10px", "1e3") as identifiers.
      if (/[\d.]/.test(ch)) {
        const m = /^[\d.]+(?:e[+-]?\d+)?[a-zA-Z%]*/.exec(str.slice(i));
        out += m[0]; i += m[0].length; continue;
      }
      const im = (ch === '-' || /[a-zA-Z_]/.test(ch)) && IDENT.exec(str.slice(i));
      if (im) {
        const name = im[0];
        const j = i + name.length;
        if (str[j] === '(') {
          const k = findClose(str, j);
          if (k < 0) { out += str.slice(i); break; }
          const fn = name.toLowerCase();
          const inner = str.slice(j + 1, k);
          if (fn === 'url') {
            const resolved = resolveURL(inner, ctx.baseURL);
            out += `url(${JSON.stringify(resolved)})`;
            if (resolved !== inner) changed = true;
          } else if (COLOR_FUNCTIONS.has(fn)) {
            const c = parseColor(str.slice(i, k + 1));
            if (c) { out += formatColor(ctx.transform(c, role)); changed = true; }
            else out += str.slice(i, k + 1); // e.g. rgb(var(--x)) – leave alone
          } else if (fn === 'var') {
            const [rawName, fallback] = splitTopLevelComma(inner);
            const vname = rawName.trim();
            const fb = fallback !== undefined ? rewriteValue(fallback, role, ctx) : null;
            if (ctx.colorVars && ctx.colorVars.has(vname)) {
              const inner2 = `var(${vname}${fb ? ',' + fb.text : ''})`;
              out += `var(${mirrorName(vname, role)}, ${inner2})`;
              changed = true;
            } else {
              out += `var(${vname}${fb ? ',' + fb.text : ''})`;
              if (fb && fb.changed) changed = true;
            }
          } else if (fn === 'light-dark' || fn === 'color-mix' || fn === 'color' || fn === 'env' || fn === 'attr') {
            out += str.slice(i, k + 1);
          } else {
            // Generic function (gradients, calc, …): recurse into arguments.
            const r = rewriteValue(inner, role, ctx);
            out += `${name}(${r.text})`;
            if (r.changed) changed = true;
          }
          i = k + 1; continue;
        }
        const lower = name.toLowerCase();
        if (lower !== 'transparent' && Object.prototype.hasOwnProperty.call(NAMED, lower)) {
          out += formatColor(ctx.transform(parseColor(lower), role)); changed = true;
        } else out += name;
        i = j; continue;
      }
      out += ch; i++;
    }
    return { text: out, changed };
  }

  /** Name of the per-role mirror of a color custom property. */
  function mirrorName(varName, role) {
    return `--adm-${role}-${varName.replace(/^--/, '')}`;
  }

  /** Every color token found in a value (used to average gradients). */
  function extractColors(value) {
    const found = [];
    rewriteValue(value, 'fg', { transform: (c) => { found.push(c); return c; } });
    return found;
  }

  return {
    NAMED, ROLE_RANGES, DEFAULT_OPTIONS,
    parseColor, formatColor, srgbToOklab, oklabToSrgb, toOklch, fromOklch,
    luminance, contrast, blend, ensureContrast,
    transformColor, rewriteValue, mirrorName, extractColors, resolveURL,
  };
});
