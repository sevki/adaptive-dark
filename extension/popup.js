const api = globalThis.chrome; // callback-style API; Firefox supports it too
const $ = (id) => document.getElementById(id);

const MESSAGES = {
  active: 'Active: this page has been darkened.',
  'supports-dark': 'This page supports dark mode itself.',
  'opt-out': 'This page asked to stay light (color-scheme: light only).',
  'already-dark': 'This page is already dark.',
  'light-appearance': 'Your appearance is set to light. Adaptive Dark Mode runs when it is dark.',
  'site-off': 'Turned off for this site.',
  disabled: 'Turned off everywhere.',
  waiting: 'Waiting for the page to load…',
};

async function main() {
  const [tab] = await new Promise((r) => api.tabs.query({ active: true, currentWindow: true }, r));
  const settings = await new Promise((r) => api.storage.sync.get({ enabled: true, sites: {} }, r));
  $('enabled').checked = settings.enabled;

  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) {}
  $('host').textContent = host || 'this site';
  $('mode').value = settings.sites[host] || 'auto';
  $('mode').disabled = !host;

  const refresh = () => api.tabs.sendMessage(tab.id, { type: 'adm:status' }, (s) => {
    void api.runtime.lastError;
    $('status').textContent = s ? (MESSAGES[s.state] || s.state) : 'Not available on this page.';
  });
  refresh();

  $('enabled').addEventListener('change', () => {
    api.storage.sync.set({ enabled: $('enabled').checked }, () => setTimeout(refresh, 100));
  });
  $('mode').addEventListener('change', () => {
    const sites = Object.assign({}, settings.sites);
    if ($('mode').value === 'auto') delete sites[host]; else sites[host] = $('mode').value;
    settings.sites = sites;
    api.storage.sync.set({ sites }, () => setTimeout(refresh, 100));
  });
}
main();
