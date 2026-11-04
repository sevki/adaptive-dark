/*
 * Adaptive Dark Mode: DOM engine.
 *
 * Darkens light pages that don't support dark mode themselves:
 *
 *   1. Detection. Pages that declare dark support (color-scheme containing
 *      "dark") or opt out ("light only") are left alone. Otherwise the page's
 *      visible backgrounds are sampled; already-dark pages are left alone.
 *   2. Stylesheets. Every readable rule is mirrored into one adopted
 *      stylesheet with its color declarations rewritten: lightness inverted,
 *      hue preserved, per role (background / text / border / shadow).
 *      Gradients are rewritten too. Hover/focus states keep working because
 *      selectors are copied, not resolved. Color custom properties get
 *      per-role mirrors (--adm-bg-x, --adm-fg-x, …) so the authored value is
 *      never touched.
 *   3. Elements. Inline styles are mirrored with per-element rules. Text is
 *      then checked against its actual (transformed) background and nudged
 *      to WCAG 4.5:1 (3:1 for large text). Monochrome inline SVG icons that
 *      would vanish are recolored. Simple black-and-white bitmap logos are
 *      detected from their pixel histogram and inverted. Other images,
 *      video and <canvas> are left as authored. mix-blend-mode is disabled
 *      on transformed rules.
 *   4. Elements (or the whole page) with `color-scheme: light only` are left
 *      in their original light colors. Elements with their own
 *      `color-scheme: light dark` are left to their own dark styles.
 *
 * Exposes globalThis.AdaptiveDark (classic script) or module.exports.
 */
(function (root, factory) {
  const color = (typeof module === 'object' && module.exports)
    ? require('./color.js')
    : root.AdaptiveDarkColor;
  const api = factory(color);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptiveDark = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  const ATTR = 'data-adm-id';
  const OPTOUT_ATTR = 'data-adm-optout';
  const ROLES = ['bg', 'fg', 'border', 'shadow'];

  const PROPERTY_ROLES = {
    'color': 'fg',
    '-webkit-text-fill-color': 'fg',
    '-webkit-text-stroke-color': 'fg',
    'caret-color': 'fg',
    'text-decoration-color': 'fg',
    'text-emphasis-color': 'fg',
    'background-color': 'bg',
    'background-image': 'bg',
    'accent-color': 'bg',
    'border-top-color': 'border',
    'border-right-color': 'border',
    'border-bottom-color': 'border',
    'border-left-color': 'border',
    'border-block-start-color': 'border',
    'border-block-end-color': 'border',
    'border-inline-start-color': 'border',
    'border-inline-end-color': 'border',
    'outline-color': 'border',
    'column-rule-color': 'border',
    'scrollbar-color': 'border',
    'box-shadow': 'shadow',
    'text-shadow': 'shadow',
  };

  // Shorthands only need rewriting when they contain var(): then the
  // longhands are "pending substitution" and read back as empty strings.
  const SHORTHAND_ROLES = {
    'background': 'bg',
    'border': 'border', 'border-color': 'border',
    'border-top': 'border', 'border-right': 'border', 'border-bottom': 'border', 'border-left': 'border',
    'border-block': 'border', 'border-inline': 'border',
    'border-block-start': 'border', 'border-block-end': 'border',
    'border-inline-start': 'border', 'border-inline-end': 'border',
    'outline': 'border', 'column-rule': 'border', 'text-decoration': 'fg',
  };

  const SHAPES = 'path,rect,circle,ellipse,line,polyline,polygon,text,tspan,use';
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED']);

  const idle = (typeof requestIdleCallback === 'function')
    ? (fn) => requestIdleCallback(fn, { timeout: 200 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 1);

  function parseComputed(v) {
    return C.parseColor(v);
  }

  function schemeOf(cs) {
    return (cs.colorScheme || cs.getPropertyValue('color-scheme') || 'normal').toLowerCase();
  }

  /** "light only" (or "only light") without dark. */
  const isLightOnly = (scheme) => /\bonly\b/.test(scheme) && !/\bdark\b/.test(scheme);
  const supportsDark = (scheme) => /\bdark\b/.test(scheme);

  // ---------------------------------------------------------------------------
  class Engine {
    constructor(doc, options) {
      this.doc = doc || document;
      this.win = this.doc.defaultView;
      this.options = Object.assign({
        // Async (url) → string|null, used for cross-origin stylesheets.
        fetchText: null,
        // Async (url) → data: URL|null, used for cross-origin images.
        fetchImage: null,
        // Average OKLab L above which the page counts as light.
        lightThreshold: 0.62,
        // Upper bound of elements examined per contrast pass.
        maxElements: 20000,
        observe: true,
        // Force the <style> element output instead of adoptedStyleSheets.
        styleElement: false,
      }, options || {});
      if (this.options.styleElement) this.adoptOK = false;
      this.colorOptions = Object.assign({}, C.DEFAULT_OPTIONS, this.options.color || {});
      this.enabled = false;
      this.sheet = null;
      this.cache = new Map();
      this.fetched = new Map();          // href → CSSStyleSheet | null (null = in flight / failed)
      this.ids = new WeakMap();
      this.nextId = 1;
      this.inlineRules = new Map();      // id → css
      this.optoutRules = new Map();
      this.svgRules = new Map();
      this.imageRules = new Map();
      this.contrastRules = new Map();
      this.touched = new Set();          // elements we put attributes on
      this.colorVars = new Set();
      this.sheetCSS = '';
      this.hasOptOut = false;
      this.imageVerdicts = new Map();    // src → boolean (invert?)
      this.pendingRender = false;
      this.contrastQueue = [];
      this.contrastScheduled = false;
      this.transformFn = (c, role) => this.transform(c, role);
    }

    // -------------------------------------------------------------------------
    // Detection
    // -------------------------------------------------------------------------

    /**
     * Decides whether the page should be transformed.
     * Returns {decision, lightness} where decision is one of
     *   'transform' | 'supports-dark' | 'opt-out' | 'already-dark'.
     */
    analyze() {
      const doc = this.doc, win = this.win;
      const meta = doc.querySelector('meta[name="color-scheme" i]');
      const metaScheme = meta ? (meta.getAttribute('content') || '').toLowerCase() : '';
      if (isLightOnly(metaScheme)) return { decision: 'opt-out', lightness: null };
      if (supportsDark(metaScheme)) return { decision: 'supports-dark', lightness: null };
      for (const el of [doc.documentElement, doc.body]) {
        if (!el) continue;
        const scheme = schemeOf(win.getComputedStyle(el));
        if (isLightOnly(scheme)) return { decision: 'opt-out', lightness: null };
        if (supportsDark(scheme)) return { decision: 'supports-dark', lightness: null };
      }
      const lightness = this.estimateLightness();
      return { decision: lightness >= this.options.lightThreshold ? 'transform' : 'already-dark', lightness };
    }

    /** Mean OKLab lightness of the backgrounds visible across the viewport. */
    estimateLightness() {
      const doc = this.doc, win = this.win;
      const canvas = this.canvasColor();
      const w = win.innerWidth || doc.documentElement.clientWidth || 1024;
      const h = win.innerHeight || doc.documentElement.clientHeight || 768;
      let sum = 0, n = 0;
      const N = 7;
      for (let yi = 0; yi < N; yi++) {
        for (let xi = 0; xi < N; xi++) {
          const x = ((xi + 0.5) / N) * w, y = ((yi + 0.5) / N) * h;
          const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
          const bg = el ? this.effectiveBackground(el, canvas).color : canvas;
          sum += C.srgbToOklab(bg).L; n++;
        }
      }
      return n ? sum / n : C.srgbToOklab(canvas).L;
    }

    /** The color behind the root: html bg, else body bg, else white. */
    canvasColor() {
      const win = this.win, doc = this.doc;
      for (const el of [doc.documentElement, doc.body]) {
        if (!el) continue;
        const c = parseComputed(win.getComputedStyle(el).backgroundColor);
        if (c && c.a > 0) return C.blend(c, { r: 1, g: 1, b: 1, a: 1 });
      }
      return this.enabled && this.canvasOverride ? this.canvasOverride : { r: 1, g: 1, b: 1, a: 1 };
    }

    /**
     * Walks up from `el` compositing background colors until opaque.
     * Returns {color, overImage} where overImage means a url() background
     * image sits behind the element (so the color is only a guess).
     */
    effectiveBackground(el, canvas) {
      const win = this.win;
      const layers = [];
      let overImage = false;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const cs = win.getComputedStyle(node);
        const img = cs.backgroundImage;
        if (img && img !== 'none') {
          if (/url\(/.test(img)) { overImage = true; }
          const stops = C.extractColors(img).filter((c) => c.a > 0);
          if (stops.length) {
            const avg = stops.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b, a: acc.a + c.a }), { r: 0, g: 0, b: 0, a: 0 });
            const k = stops.length;
            layers.push({ r: avg.r / k, g: avg.g / k, b: avg.b / k, a: avg.a / k });
            if (avg.a / k >= 0.99) break;
          }
        }
        const c = parseComputed(cs.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.99) break;
        }
      }
      let result = canvas || this.canvasColor();
      for (let i = layers.length - 1; i >= 0; i--) result = C.blend(layers[i], result);
      return { color: result, overImage };
    }

    // -------------------------------------------------------------------------
    // Enable / disable
    // -------------------------------------------------------------------------

    /**
     * Applies the transformation if analyze() says so (or `force`).
     * Returns the analysis result.
     */
    enable(opts) {
      opts = opts || {};
      if (this.enabled) return this.lastAnalysis;
      const analysis = this.analyze();
      this.lastAnalysis = analysis;
      if (analysis.decision !== 'transform' && !opts.force) return analysis;

      this.enabled = true;
      this.markOptOuts();
      this.rebuildSheets();
      this.scanSubtree(this.doc.documentElement);
      this.render();
      this.queueContrast(this.doc.documentElement);
      if (this.options.observe) this.observe();
      return analysis;
    }

    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      if (this.observer) this.observer.disconnect();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.observer = null; this.pollTimer = null;
      const doc = this.doc;
      if (this.sheet) {
        try { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== this.sheet); } catch (e) { /* ignore */ }
      }
      if (this.styleEl) this.styleEl.remove();
      this.styleEl = null;
      for (const el of this.touched) { el.removeAttribute(ATTR); el.removeAttribute(OPTOUT_ATTR); }
      this.touched.clear();
      for (const m of [this.inlineRules, this.optoutRules, this.svgRules, this.imageRules, this.contrastRules]) m.clear();
      this.ids = new WeakMap();
      this.sheet = null;
      this.contrastQueue = [];
    }

    // -------------------------------------------------------------------------
    // Color transform
    // -------------------------------------------------------------------------
    transform(c, role) {
      const key = role + ':' + c.r + ',' + c.g + ',' + c.b + ',' + c.a;
      let out = this.cache.get(key);
      if (!out) {
        out = C.transformColor(c, role, this.colorOptions);
        this.cache.set(key, out);
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // Per-element ids
    // -------------------------------------------------------------------------
    idFor(el) {
      let id = this.ids.get(el);
      if (!id) {
        id = String(this.nextId++);
        this.ids.set(el, id);
        el.setAttribute(ATTR, id);
        this.touched.add(el);
      }
      return id;
    }

    // -------------------------------------------------------------------------
    // Opt-outs
    // -------------------------------------------------------------------------
    /**
     * Finds elements whose own color-scheme differs from their parent's and
     * is "light only" (keep original light colors) or contains "dark" (the
     * site styles that part itself). Must run before styles are applied.
     */
    markOptOuts() {
      const win = this.win;
      const walker = this.doc.createTreeWalker(this.doc.body || this.doc.documentElement, 1);
      const canvas = this.canvasColor();
      let node = walker.currentNode, count = 0;
      const found = [];
      while (node && count++ < this.options.maxElements) {
        const parent = node.parentElement;
        if (parent) {
          const s = schemeOf(win.getComputedStyle(node));
          if (s !== schemeOf(win.getComputedStyle(parent)) && (isLightOnly(s) || supportsDark(s))) {
            found.push({ el: node, lightOnly: isLightOnly(s) });
          }
        }
        node = walker.nextNode();
      }
      for (const { el, lightOnly } of found) {
        if (lightOnly) {
          // Remember the colors it has now, in light mode.
          const cs = win.getComputedStyle(el);
          const bg = this.effectiveBackground(el, canvas).color;
          const id = this.idFor(el);
          this.optoutRules.set(id,
            `[${ATTR}="${id}"]{color:${cs.color} !important;background-color:${C.formatColor(bg)} !important;color-scheme:light !important}`);
        }
        el.setAttribute(OPTOUT_ATTR, lightOnly ? 'light' : 'own');
        this.touched.add(el);
      }
      this.hasOptOut = found.length > 0;
    }

    inOptOut(el) {
      return !!(el.closest && el.closest(`[${OPTOUT_ATTR}]`));
    }

    withOptOutGuard(selectorText) {
      if (!this.hasOptOut) return selectorText;
      const guard = `:not([${OPTOUT_ATTR}],[${OPTOUT_ATTR}] *)`;
      return splitSelectorList(selectorText).map((sel) => {
        const m = /(::?(?:before|after|first-line|first-letter|placeholder|marker|selection|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?)\s*$/i.exec(sel);
        if (m && (m[1].startsWith('::') || /^:(before|after|first-line|first-letter)$/i.test(m[1]))) {
          return sel.slice(0, m.index) + guard + m[1];
        }
        return sel + guard;
      }).join(',');
    }

    // -------------------------------------------------------------------------
    // Stylesheets
    // -------------------------------------------------------------------------
    collectSheets() {
      const doc = this.doc;
      const list = [];
      const own = this.styleEl && this.styleEl.sheet;
      for (const s of Array.from(doc.styleSheets)) if (s !== own) list.push(s);
      // Read by index: from a Firefox 140 content script the Xray-wrapped
      // array isn't iterable.
      try {
        const adopted = doc.adoptedStyleSheets;
        for (let i = 0; adopted && i < adopted.length; i++) if (adopted[i] !== this.sheet) list.push(adopted[i]);
      } catch (e) { /* ignore */ }
      return list;
    }

    sheetRules(sheet) {
      try {
        return sheet.cssRules;
      } catch (e) {
        // Cross-origin: try the fetch hook, then rebuild when it arrives.
        const href = sheet.href;
        if (!href || !this.options.fetchText) return null;
        if (this.fetched.has(href)) {
          const s = this.fetched.get(href);
          return s ? s.cssRules : null;
        }
        this.fetched.set(href, null);
        Promise.resolve(this.options.fetchText(href)).then((text) => {
          if (!text || !this.enabled) return;
          const cs = new this.win.CSSStyleSheet();
          cs.replaceSync(text);
          this.fetched.set(href, cs);
          this.scheduleRebuild();
        }).catch(() => {});
        return null;
      }
    }

    /** First pass: which custom properties hold colors. */
    findColorVars(sheets) {
      const vars = new Map();
      const visitStyle = (style) => {
        for (let i = 0; i < style.length; i++) {
          const p = style.item(i);
          if (p.startsWith('--')) {
            const v = style.getPropertyValue(p).trim();
            if (v) (vars.get(p) || vars.set(p, []).get(p)).push(v);
          }
        }
      };
      const visitRules = (rules, depth) => {
        if (!rules || depth > 16) return;
        for (const rule of Array.from(rules)) {
          if (rule.style) visitStyle(rule.style);
          if (rule.styleSheet) visitRules(this.sheetRules(rule.styleSheet), depth + 1);
          if (rule.cssRules) visitRules(rule.cssRules, depth + 1);
        }
      };
      for (const s of sheets) if (!s.disabled) visitRules(this.sheetRules(s), 0);
      for (const el of this.doc.querySelectorAll('[style*="--"]')) visitStyle(el.style);

      const colorVars = new Set();
      for (const [name, values] of vars) if (values.some((v) => C.parseColor(v))) colorVars.add(name);
      // Variables that alias color variables: --a: var(--b)
      let grew = true;
      while (grew) {
        grew = false;
        for (const [name, values] of vars) {
          if (colorVars.has(name)) continue;
          if (values.some((v) => { const m = /^var\(\s*(--[\w-]+)\s*[,)]/.exec(v); return m && colorVars.has(m[1]); })) {
            colorVars.add(name); grew = true;
          }
        }
      }
      return colorVars;
    }

    /** Rewrites one declaration block. Returns css text (may be empty). */
    rewriteStyle(style, baseURL, forceImportant) {
      const ctx = { transform: this.transformFn, colorVars: this.colorVars, baseURL };
      const out = [];
      const imp = (p) => (forceImportant || style.getPropertyPriority(p) === 'important' ? ' !important' : '');
      for (let i = 0; i < style.length; i++) {
        const p = style.item(i);
        if (p.startsWith('--')) {
          if (!this.colorVars.has(p)) continue;
          const v = style.getPropertyValue(p);
          for (const role of ROLES) {
            out.push(`${C.mirrorName(p, role)}:${C.rewriteValue(v, role, ctx).text}${imp(p)}`);
          }
          continue;
        }
        const role = PROPERTY_ROLES[p];
        if (role) {
          const v = style.getPropertyValue(p);
          if (!v) continue;
          const r = C.rewriteValue(v, role, ctx);
          if (r.changed) out.push(`${p}:${r.text}${imp(p)}`);
        } else if (p === 'mix-blend-mode') {
          const v = style.getPropertyValue(p);
          if (v && v !== 'normal') out.push(`mix-blend-mode:normal${imp(p)}`);
        }
      }
      for (const sh in SHORTHAND_ROLES) {
        const v = style.getPropertyValue(sh);
        if (v && v.includes('var(')) {
          const r = C.rewriteValue(v, SHORTHAND_ROLES[sh], ctx);
          if (r.changed) out.push(`${sh}:${r.text}${imp(sh)}`);
        }
      }
      return out.join(';');
    }

    rewriteRules(rules, baseURL, nested, depth) {
      if (!rules || depth > 16) return '';
      let out = '';
      for (const rule of Array.from(rules)) {
        try {
          out += this.rewriteRule(rule, baseURL, nested, depth);
        } catch (e) { /* skip odd rules */ }
      }
      return out;
    }

    rewriteRule(rule, baseURL, nested, depth) {
      const W = this.win;
      if (rule.selectorText !== undefined && rule.style) {
        const decls = this.rewriteStyle(rule.style, baseURL, false);
        const children = rule.cssRules && rule.cssRules.length ? this.rewriteRules(rule.cssRules, baseURL, true, depth + 1) : '';
        if (!decls && !children) return '';
        const sel = nested ? rule.selectorText : this.withOptOutGuard(rule.selectorText);
        return `${sel}{${decls}${decls && children ? ';' : ''}${children}}`;
      }
      if (W.CSSImportRule && rule instanceof W.CSSImportRule) {
        if (!rule.styleSheet) return '';
        const inner = this.rewriteRules(this.sheetRules(rule.styleSheet), rule.styleSheet.href || baseURL, false, depth + 1);
        if (!inner) return '';
        let wrapped = inner;
        if (rule.layerName) wrapped = `@layer ${rule.layerName}{${wrapped}}`;
        const media = rule.media && rule.media.mediaText;
        if (media && media !== 'all') wrapped = `@media ${media}{${wrapped}}`;
        return wrapped;
      }
      if (W.CSSKeyframesRule && rule instanceof W.CSSKeyframesRule) {
        let any = false, body = '';
        for (const kf of Array.from(rule.cssRules)) {
          const rewritten = this.rewriteStyle(kf.style, baseURL, false);
          if (rewritten) any = true;
          // A same-named @keyframes replaces the original entirely, so copy
          // every declaration and override the color ones.
          body += `${kf.keyText}{${kf.style.cssText}${rewritten ? ';' + rewritten : ''}}`;
        }
        return any ? `@keyframes ${rule.name}{${body}}` : '';
      }
      if (rule.cssRules) {
        const inner = this.rewriteRules(rule.cssRules, baseURL, nested, depth + 1);
        if (!inner) return '';
        let prelude;
        if (W.CSSMediaRule && rule instanceof W.CSSMediaRule) prelude = `@media ${rule.media.mediaText}`;
        else if (W.CSSSupportsRule && rule instanceof W.CSSSupportsRule) prelude = `@supports ${rule.conditionText}`;
        else if (W.CSSLayerBlockRule && rule instanceof W.CSSLayerBlockRule) {
          if (!rule.name) return inner; // anonymous layer: can't be re-entered
          prelude = `@layer ${rule.name}`;
        } else {
          const text = rule.cssText;
          prelude = text.slice(0, text.indexOf('{')).trim();
          if (!prelude.startsWith('@')) return '';
        }
        return `${prelude}{${inner}}`;
      }
      return '';
    }

    rebuildSheets() {
      const sheets = this.collectSheets();
      this.colorVars = this.findColorVars(sheets);
      let css = '';
      for (const s of sheets) {
        if (s.disabled) continue;
        const base = s.href || this.doc.baseURI;
        const inner = this.rewriteRules(this.sheetRules(s), base, false, 0);
        if (!inner) continue;
        const media = s.media && s.media.mediaText;
        css += media && media !== 'all' ? `@media ${media}{${inner}}` : inner;
      }
      this.sheetCSS = css;
      this.sheetSignature = this.signature();
      // Inline styles may reference color vars that were just discovered.
      this.inlineRules.clear();
      for (const el of this.doc.querySelectorAll('[style]')) this.processInline(el);
    }

    baseCSS() {
      const doc = this.doc, win = this.win;
      const white = { r: 1, g: 1, b: 1, a: 1 }, black = { r: 0, g: 0, b: 0, a: 1 };
      const bg = C.formatColor(this.transform(white, 'bg'));
      const fg = C.formatColor(this.transform(black, 'fg'));
      this.canvasOverride = this.transform(white, 'bg');
      // Only paint the root if the author didn't give html/body a background,
      // otherwise body backgrounds couldn't propagate to the canvas.
      let paintRoot = this.rootPainted;
      if (paintRoot === undefined) {
        paintRoot = true;
        for (const el of [doc.documentElement, doc.body]) {
          if (!el) continue;
          const cs = win.getComputedStyle(el);
          const c = parseComputed(cs.backgroundColor);
          if ((c && c.a > 0) || cs.backgroundImage !== 'none') paintRoot = false;
        }
        this.rootPainted = paintRoot;
      }
      return `:where(html){color-scheme:dark !important;color:${fg};${paintRoot ? `background-color:${bg};` : ''}}`
        + `:where(img[${ATTR}].adm-invert){filter:invert(0.86) hue-rotate(180deg)}`;
    }

    render() {
      if (!this.enabled) return;
      const parts = [this.baseCSS(), this.sheetCSS];
      for (const m of [this.inlineRules, this.svgRules, this.imageRules, this.optoutRules, this.contrastRules]) {
        for (const css of m.values()) parts.push(css);
      }
      this.output(parts.join('\n'));
    }

    /**
     * Writes the generated CSS. Prefers one adopted stylesheet (invisible in
     * document.styleSheets, always last in the cascade). Falls back to a
     * <style> element kept at the end of the document where adopting fails,
     * e.g. from a Firefox content script, whose sandboxed arrays and
     * constructed sheets can't be assigned to the page's adoptedStyleSheets.
     */
    output(css) {
      const doc = this.doc;
      if (!this.styleEl && this.adoptOK !== false) {
        try {
          if (!this.sheet) this.sheet = new this.win.CSSStyleSheet();
          this.sheet.replaceSync(css);
          if (!doc.adoptedStyleSheets.includes(this.sheet)) {
            doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, this.sheet];
          }
          if (doc.adoptedStyleSheets.includes(this.sheet)) { this.adoptOK = true; return; }
        } catch (e) { /* fall through */ }
        this.adoptOK = false;
        this.sheet = null;
      }
      if (!this.styleEl) {
        this.styleEl = doc.createElement('style');
        this.styleEl.setAttribute('data-adaptive-dark', '');
      }
      if (this.styleEl.textContent !== css) this.styleEl.textContent = css;
      this.keepStyleLast();
    }

    keepStyleLast() {
      const el = this.styleEl;
      if (!el) return;
      const parent = this.doc.body || this.doc.documentElement;
      if (el.parentNode !== parent || el.nextElementSibling) parent.appendChild(el);
    }

    scheduleRender() {
      if (this.pendingRender) return;
      this.pendingRender = true;
      const done = () => { this.pendingRender = false; this.render(); };
      // Call it as a method: Firefox content scripts see `window` through an
      // Xray wrapper, and an unbound requestAnimationFrame throws there.
      if (typeof this.win.requestAnimationFrame === 'function') this.win.requestAnimationFrame(done);
      else setTimeout(done, 16);
    }

    scheduleRebuild() {
      if (this.rebuildTimer) return;
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        if (!this.enabled) return;
        this.rebuildSheets();
        this.contrastRules.clear();
        this.render();
        this.queueContrast(this.doc.documentElement);
      }, 50);
    }

    signature() {
      let sig = '';
      for (const s of this.collectSheets()) {
        let n = -1;
        try { n = s.cssRules.length; } catch (e) { n = this.fetched.get(s.href) ? -2 : -1; }
        sig += (s.href || 'inline') + ':' + n + (s.disabled ? 'd' : '') + '|';
      }
      return sig;
    }

    // -------------------------------------------------------------------------
    // Elements
    // -------------------------------------------------------------------------
    processInline(el) {
      if (!el.style || !el.style.length) {
        const id = this.ids.get(el);
        if (id && this.inlineRules.delete(id)) this.scheduleRender();
        return;
      }
      if (this.inOptOut(el)) return;
      const css = this.rewriteStyle(el.style, this.doc.baseURI, true);
      const id = css ? this.idFor(el) : this.ids.get(el);
      if (!id) return;
      if (css) this.inlineRules.set(id, `[${ATTR}="${id}"]{${css}}`);
      else this.inlineRules.delete(id);
    }

    scanSubtree(rootEl) {
      if (!rootEl || rootEl.nodeType !== 1) return;
      const els = [rootEl, ...rootEl.querySelectorAll('*')];
      for (const el of els) {
        if (el.hasAttribute('style')) this.processInline(el);
      }
      // SVG/image passes need transformed styles; run after render.
      Promise.resolve().then(() => {
        if (!this.enabled) return;
        // One odd element must not stop the rest of the pass.
        const each = (list, fn) => { for (const el of list) { try { fn.call(this, el); } catch (e) { /* skip */ } } };
        each(rootEl.tagName === 'svg' ? [rootEl] : rootEl.querySelectorAll('svg'), this.processSVG);
        each(rootEl.tagName === 'IMG' ? [rootEl] : rootEl.querySelectorAll('img'), this.processImage);
      });
    }

    /**
     * Inline SVG: if no opaque fill/stroke reaches 3:1 against what is behind
     * the icon, it would disappear on the dark page; recolor it.
     */
    processSVG(svg) {
      if (svg.ownerSVGElement || this.inOptOut(svg)) return;
      const win = this.win;
      const bg = this.effectiveBackground(svg).color;
      const shapes = Array.from(svg.querySelectorAll(SHAPES));
      if (!shapes.length) return;
      let best = 0;
      const paints = [];
      for (const s of shapes) {
        const cs = win.getComputedStyle(s);
        for (const prop of ['fill', 'stroke']) {
          const c = parseComputed(cs[prop]);
          if (!c || c.a === 0) continue;
          paints.push({ el: s, prop, c });
          if (c.a >= 0.5) best = Math.max(best, C.contrast(C.blend(c, bg), bg));
        }
      }
      if (!paints.length || best >= 3) return;
      const byEl = new Map();
      for (const p of paints) {
        const decl = `${p.prop}:${C.formatColor(this.transform(p.c, 'fg'))} !important`;
        (byEl.get(p.el) || byEl.set(p.el, []).get(p.el)).push(decl);
      }
      for (const [el, decls] of byEl) {
        const id = this.idFor(el);
        this.svgRules.set(id, `[${ATTR}="${id}"]{${decls.join(';')}}`);
      }
      this.scheduleRender();
    }

    processImage(img) {
      if (this.inOptOut(img)) return;
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener('load', () => this.enabled && this.processImage(img), { once: true });
        return;
      }
      const src = img.currentSrc || img.src;
      if (!src) return;
      const apply = (invert) => {
        if (!this.enabled) return;
        if (invert) {
          this.idFor(img);
          img.classList.add('adm-invert');
        }
      };
      if (this.imageVerdicts.has(src)) return apply(this.imageVerdicts.get(src));
      const verdict = this.classifyImage(img);
      if (verdict !== null) {
        this.imageVerdicts.set(src, verdict);
        return apply(verdict);
      }
      // Pixels unreadable: a cross-origin image, or any image when running as
      // a Firefox content script (the page's <img> taints the script's
      // canvas). Re-decode the bytes in our own scope: data: URLs directly,
      // anything else through the fetch hook.
      this.imageVerdicts.set(src, false);
      const decode = (dataURL) => {
        if (!dataURL) return;
        const Img = typeof Image === 'function' ? Image : this.win.Image;
        const probe = new Img();
        probe.onload = () => {
          const v = !!this.classifyImage(probe, img.naturalWidth, img.naturalHeight);
          this.imageVerdicts.set(src, v);
          apply(v);
        };
        probe.src = dataURL;
      };
      if (/^data:/.test(src)) return decode(src);
      if (!this.options.fetchImage) return;
      Promise.resolve(this.options.fetchImage(src)).then(decode).catch(() => {});
    }

    /**
     * Pixel-histogram test for simple black-and-white logos:
     *  - nearly all opaque pixels are neutral (no hue) and near black/white,
     *  - and dark ink dominates (on transparent) or it's dark ink on white.
     * Returns true (invert), false (leave), or null (pixels unreadable).
     */
    classifyImage(img, w0, h0) {
      const w = w0 || img.naturalWidth, h = h0 || img.naturalHeight;
      if (!w || !h) return false;
      // Photos and big illustrations are left alone.
      if (w * h > 1200 * 1200) return false;
      const S = 48;
      const cw = Math.max(1, Math.round(w >= h ? S : (S * w) / h));
      const ch = Math.max(1, Math.round(h >= w ? S : (S * h) / w));
      const canvas = this.doc.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return false;
      let data;
      try {
        g.drawImage(img, 0, 0, cw, ch);
        data = g.getImageData(0, 0, cw, ch).data;
      } catch (e) { return null; }
      let transparent = 0, opaque = 0, neutral = 0, dark = 0, light = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 32) { transparent++; continue; }
        opaque++;
        const r = data[i], gg = data[i + 1], b = data[i + 2];
        const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
        if (max - min > 28) continue;
        neutral++;
        const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        if (y < 90) dark++; else if (y > 215) light++;
      }
      const total = transparent + opaque;
      if (!opaque) return false;
      if (neutral / opaque < 0.96) return false;          // has color
      if ((dark + light) / opaque < 0.85) return false;   // has lots of grays (photo-ish)
      if (transparent / total > 0.15) return dark / opaque > 0.6;  // dark ink on transparent
      return light / opaque > 0.5 && dark / opaque > 0.02;          // dark ink on white
    }

    // -------------------------------------------------------------------------
    // Contrast pass
    // -------------------------------------------------------------------------
    queueContrast(el) {
      if (!el) return;
      this.contrastQueue.push(el);
      if (this.contrastScheduled) return;
      this.contrastScheduled = true;
      idle((deadline) => this.runContrast(deadline));
    }

    runContrast(deadline) {
      this.contrastScheduled = false;
      if (!this.enabled) return;
      const canvas = this.canvasColor();
      let changed = false, budget = this.options.maxElements;
      const start = Date.now();
      while (this.contrastQueue.length && budget > 0) {
        const rootEl = this.contrastQueue.shift();
        if (!rootEl.isConnected) continue;
        const walker = this.doc.createTreeWalker(rootEl, 1, {
          acceptNode: (n) => (SKIP_TEXT_TAGS.has(n.tagName) || n.hasAttribute(OPTOUT_ATTR)) ? 2 /* REJECT */ : 1,
        });
        for (let n = walker.currentNode; n && budget > 0; n = walker.nextNode()) {
          budget--;
          if (this.fixContrast(n, canvas)) changed = true;
        }
        if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 1 && Date.now() - start > 30) break;
      }
      if (changed) this.render();
      if (this.contrastQueue.length) {
        this.contrastScheduled = true;
        idle((d) => this.runContrast(d));
      }
    }

    hasOwnText(el) {
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return true;
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 && /\S/.test(c.data)) return true;
      }
      return false;
    }

    fixContrast(el, canvas) {
      if (!this.hasOwnText(el) || (el.closest && el.closest(`[${OPTOUT_ATTR}]`))) return false;
      const cs = this.win.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      const fg = parseComputed(cs.color);
      if (!fg || fg.a === 0) return false;
      const { color: bg, overImage } = this.effectiveBackground(el, canvas);
      if (overImage) return false;
      const size = parseFloat(cs.fontSize) || 16;
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const target = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const shown = C.blend(fg, bg);
      if (C.contrast(shown, bg) >= target) return false;
      // Small margin so rounding to 8-bit channels can't drop below target.
      const fixed = C.ensureContrast({ ...fg, a: 1 }, bg, target + 0.08);
      const id = this.idFor(el);
      this.contrastRules.set(id, `[${ATTR}="${id}"]{color:${C.formatColor(fixed)} !important}`);
      return true;
    }

    // -------------------------------------------------------------------------
    // Dynamic pages
    // -------------------------------------------------------------------------
    observe() {
      const doc = this.doc;
      this.observer = new this.win.MutationObserver((records) => {
        if (!this.enabled) return;
        let rebuild = false, render = false;
        const added = new Set();
        for (const r of records) {
          if (r.type === 'attributes') {
            const el = r.target;
            if (r.attributeName === 'style') { this.processInline(el); render = true; added.add(el); }
            else if (r.attributeName === 'class') added.add(el);
            else if (r.attributeName === 'src' && el.tagName === 'IMG') { el.classList.remove('adm-invert'); this.processImage(el); }
            else if (r.attributeName === 'media' || r.attributeName === 'disabled' || r.attributeName === 'href') rebuild = true;
            continue;
          }
          const isSheetNode = (n) => n.nodeType === 1 && (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /stylesheet/i.test(n.rel)));
          if (r.target === this.styleEl) continue;
          if (r.target.nodeType === 1 && r.target.tagName === 'STYLE') rebuild = true;
          for (const n of r.addedNodes) {
            if (n === this.styleEl) continue;
            if (isSheetNode(n)) {
              rebuild = true;
              if (n.tagName === 'LINK') n.addEventListener('load', () => this.scheduleRebuild(), { once: true });
            } else if (n.nodeType === 1) {
              if (n.querySelector && n.querySelector('style,link[rel~="stylesheet" i]')) rebuild = true;
              this.scanSubtree(n); render = true; added.add(n);
            } else if (n.nodeType === 3 && n.parentElement) added.add(n.parentElement);
          }
          for (const n of r.removedNodes) if (n !== this.styleEl && isSheetNode(n)) rebuild = true;
        }
        if (this.styleEl && (!this.styleEl.isConnected || this.styleEl.nextElementSibling)) this.keepStyleLast();
        if (rebuild) this.scheduleRebuild();
        else if (render) this.scheduleRender();
        for (const el of added) this.queueContrast(el);
      });
      this.observer.observe(doc.documentElement, {
        subtree: true, childList: true, characterData: false, attributes: true,
        attributeFilter: ['style', 'class', 'src', 'media', 'disabled', 'href'],
      });
      // CSS-in-JS libraries insert rules via CSSOM, which mutation observers
      // can't see. Poll a cheap signature instead.
      this.pollTimer = setInterval(() => {
        if (this.enabled && this.signature() !== this.sheetSignature) this.scheduleRebuild();
      }, 1500);
    }
  }

  /** Splits a selector list on top-level commas. */
  function splitSelectorList(text) {
    const out = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }

  /** Creates an engine for `doc`. */
  function create(doc, options) {
    return new Engine(doc, options);
  }

  /**
   * Convenience: enable when the user prefers dark, follow changes.
   * Returns the engine.
   */
  function auto(doc, options) {
    doc = doc || document;
    const engine = new Engine(doc, options);
    const mq = doc.defaultView.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => (mq.matches ? engine.enable() : engine.disable());
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync, { once: true });
    else sync();
    mq.addEventListener('change', sync);
    return engine;
  }

  return { Engine, create, auto, splitSelectorList, color: C };
});
