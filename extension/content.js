// Content script: decides whether to run Adaptive Dark Mode on this page.
//
// Like Safari, it only acts while the system/browser appearance is dark, and
// only on pages that are light and don't support dark mode themselves.
(() => {
  const api = globalThis.chrome; // callback-style API; Firefox supports it too
  const ask = (type, url) => new Promise((resolve) => {
    try { api.runtime.sendMessage({ type, url }, (r) => resolve(r || null)); } catch (e) { resolve(null); }
  });

  const host = location.hostname;
  const engine = AdaptiveDark.create(document, {
    fetchText: (url) => ask('adm:fetch-css', url),
    fetchImage: (url) => ask('adm:fetch-image', url),
  });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  let settings = null; // loaded from storage
  let status = { state: 'waiting' };

  function siteMode() {
    return settings.sites[host] || 'auto'; // 'auto' | 'on' | 'off'
  }

  function sync() {
    if (!settings || document.readyState === 'loading') return;
    const mode = siteMode();
    const want = settings.enabled && mq.matches && mode !== 'off';
    if (!want) {
      engine.disable();
      status = { state: !settings.enabled ? 'disabled' : !mq.matches ? 'light-appearance' : 'site-off' };
      return;
    }
    if (engine.enabled) return;
    const analysis = engine.enable({ force: mode === 'on' });
    status = { state: engine.enabled ? 'active' : analysis.decision, lightness: analysis.lightness };
  }

  api.storage.sync.get({ enabled: true, sites: {} }, (s) => {
    settings = s;
    sync();
  });
  api.storage.onChanged.addListener((changes) => {
    if (!settings) return;
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
    if (changes.sites) settings.sites = changes.sites.newValue || {};
    engine.disable();
    sync();
  });
  mq.addEventListener('change', sync);
  document.addEventListener('DOMContentLoaded', sync, { once: true });

  if (window === window.top) {
    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'adm:status') {
        sendResponse({ host, mode: settings ? siteMode() : 'auto', ...status });
      }
    });
  }
})();
