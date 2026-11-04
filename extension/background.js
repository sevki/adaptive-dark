// Fetches cross-origin stylesheets and images on behalf of content scripts.
// Pages can't read these themselves (CORS), but the extension's host
// permissions allow it, so the engine can still rewrite their colors and
// run the logo histogram.
const api = globalThis.chrome; // callback-style API; Firefox supports it too

const MAX_BYTES = 4 * 1024 * 1024;

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > MAX_BYTES ? null : text;
}

async function fetchImage(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size > MAX_BYTES || !/^image\//.test(blob.type)) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !/^https?:/.test(msg.url || '')) return false;
  const job = msg.type === 'adm:fetch-css' ? fetchText(msg.url)
    : msg.type === 'adm:fetch-image' ? fetchImage(msg.url) : null;
  if (!job) return false;
  job.then(sendResponse, () => sendResponse(null));
  return true; // async response
});
