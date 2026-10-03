import { normalizeDesign, defaultDesign, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, IMAGE_TYPES } from './design-model.js';

// Until per-ratio layouts arrive (P1-B2), every screen uses the 16:9 entry.
export const ACTIVE_RATIO = '16:9';

async function failureMessage(response, fallback) {
  try { return (await response.json()).error || fallback; } catch { return fallback; }
}

// Checks a chosen file before uploading: type, size, and a real browser decode.
export async function checkImageFile(file, { Image: ImageClass = globalThis.Image, urls = globalThis.URL } = {}) {
  if (!file || !Object.values(IMAGE_TYPES).includes(file.type) || !(file.size > 0) || file.size > MAX_IMAGE_BYTES) {
    throw new Error('PNG・JPEG・WebP・GIFの20MB以下の画像を選んでください。');
  }
  const url = urls.createObjectURL(file);
  try {
    const probe = new ImageClass(); probe.src = url;
    try { await probe.decode(); } catch { throw new Error('画像が壊れているか、対応しない画像形式です。'); }
    if (probe.naturalWidth * probe.naturalHeight > MAX_IMAGE_PIXELS) throw new Error('画像は1600万画素以内にしてください。');
  } finally { urls.revokeObjectURL(url); }
}

// The applied design, read from and written to customization/current through
// the local server. `confirmed` is what the server last acknowledged; `shown`
// is what this page displays: confirmed plus edits that are still being saved.
// Saves are serialized and the newest requested design wins.
export async function createDesignStore({ fetchImpl = (...args) => globalThis.fetch(...args), EventSourceClass = globalThis.EventSource, watch = true } = {}) {
  let confirmed = { design: defaultDesign(), images: {}, revision: '' }, shown = confirmed.design;
  let available = false, warning = '';
  // `latest` is the newest design passed to save(); `desired` is the next one to send.
  let desired = null, latest = null, flushing = null, announced = '';
  // Every request that can replace `confirmed` takes a ticket. An answer to a
  // request issued before the last applied one is stale and is ignored.
  let issued = 0, applied = 0;
  // Images uploaded here stay usable even if a save answer lists an older catalog.
  let uploaded = {};
  const listeners = new Set();
  const emit = detail => { for (const listener of listeners) listener(detail); };
  const images = () => ({ ...confirmed.images, ...uploaded });

  function accept(value, ticket) {
    if (ticket <= applied) return false;
    applied = ticket;
    confirmed = { design: normalizeDesign(value.design, { ...value.images, ...uploaded }), images: value.images, revision: value.revision };
    return true;
  }

  async function load({ force = false } = {}) {
    const ticket = ++issued;
    const response = await fetchImpl('/api/design/current', { cache: 'no-store' });
    if (!response.ok) throw new Error(await failureMessage(response, '見た目を読み込めません。'));
    const value = await response.json();
    // While edits are being saved, their own answer will be newer than this one.
    if (!force && flushing) return false;
    if (!accept(value, ticket)) return false;
    shown = confirmed.design;
    warning = value.warning || '';
    available = true;
    return true;
  }
  try { await load(); }
  catch (error) { warning = `${error.message} 標準の見た目を表示しています。ローカルサーバーから開いているか確認してください。`; }

  async function reloadExternal(force = false) {
    const before = confirmed.revision;
    let changed;
    try { changed = await load({ force }); } catch { return; /* The next change event retries. */ }
    if (changed && confirmed.revision !== before) emit({ external: true });
  }

  async function put(design) {
    const ticket = ++issued;
    const response = await fetchImpl('/api/design/current', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': confirmed.revision || 'default' }, body: JSON.stringify(design),
    });
    if (response.status === 409) {
      desired = null; latest = null;
      // The server already holds a newer design; show it instead of this save.
      await reloadExternal(true);
      shown = confirmed.design;
      throw Object.assign(new Error('別の画面で見た目が変更されたため、最新の内容に切り替えました。もう一度操作してください。'), { conflict: true });
    }
    if (!response.ok) throw new Error(await failureMessage(response, '見た目を保存できません。'));
    accept(await response.json(), ticket);
    // Newer edits still waiting stay on screen; otherwise show what was stored.
    if (design === latest) { shown = confirmed.design; latest = null; }
  }
  async function flush() {
    try { while (desired) { const next = desired; desired = null; await put(next); } }
    catch (error) {
      // Unsaved edits are dropped, so a cancelled draft cannot ride along with
      // a later save. Pages rerender from the saved design.
      if (!error.conflict) { desired = null; latest = null; shown = confirmed.design; emit({ reverted: true }); }
      throw error;
    }
    finally {
      flushing = null;
      // A change announced while saving may come from another page.
      if (announced && announced !== confirmed.revision) reloadExternal();
    }
  }

  const store = {
    get design() { return shown; },
    get images() { return images(); },
    get revision() { return confirmed.revision; },
    get available() { return available; },
    get warning() { return warning; },
    // Resolves once this design, or a newer one requested meanwhile, is stored.
    save(design) {
      if (!available) return Promise.reject(new Error('見た目を保存できません。ローカルサーバーから開いているか確認してください。'));
      const normalized = normalizeDesign(design, images());
      shown = normalized; desired = normalized; latest = normalized;
      if (!flushing) flushing = flush();
      return flushing;
    },
    async uploadImage(file) {
      if (!available) throw new Error('画像を保存できません。ローカルサーバーから開いているか確認してください。');
      const response = await fetchImpl('/api/design/images', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!response.ok) throw new Error(await failureMessage(response, '画像を保存できません。'));
      const { ref, ...info } = await response.json();
      uploaded = { ...uploaded, [ref]: info };
      return { ref, ...info };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };

  if (watch && typeof EventSourceClass === 'function') {
    const events = new EventSourceClass('/api/design/events');
    events.addEventListener('change', event => {
      try { announced = JSON.parse(event.data).revision; } catch { return; }
      // Revisions are content hashes, so only the current one can be skipped:
      // another page may return to content this page saved earlier.
      if (!flushing && announced !== confirmed.revision) reloadExternal();
    });
    // A server restart may have missed events; reread when the stream returns.
    let opened = false;
    events.addEventListener('open', () => {
      if (opened && available && !flushing) reloadExternal();
      opened = true;
    });
  }
  return store;
}
