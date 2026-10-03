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
// the local server. Saves are serialized; the newest requested design wins.
export async function createDesignStore({ fetchImpl = (...args) => globalThis.fetch(...args), EventSourceClass = globalThis.EventSource, watch = true } = {}) {
  let state = { design: defaultDesign(), images: {}, revision: '' }, available = false, warning = '';
  let desired = null, flushing = null, latestRevision = '', saves = 0;
  // Revisions this page wrote: their change events need no reload.
  const ownRevisions = new Set();
  const listeners = new Set();

  async function load({ force = false } = {}) {
    const savesBefore = saves;
    const response = await fetchImpl('/api/design/current', { cache: 'no-store' });
    if (!response.ok) throw new Error(await failureMessage(response, '見た目を読み込めません。'));
    const value = await response.json();
    // A save that finished (or started) meanwhile is newer than this response.
    if (!force && (saves !== savesBefore || flushing)) return;
    state = { design: normalizeDesign(value.design, value.images), images: value.images, revision: value.revision };
    warning = value.warning || '';
    available = true;
  }
  try { await load(); }
  catch (error) { warning = `${error.message} 標準の見た目を表示しています。ローカルサーバーから開いているか確認してください。`; }

  const emit = detail => { for (const listener of listeners) listener(detail); };
  async function reloadExternal(force = false) {
    const before = state.revision;
    try { await load({ force }); } catch { return; /* The next change event retries. */ }
    if (state.revision !== before) emit({ external: true });
  }

  async function put(design) {
    const response = await fetchImpl('/api/design/current', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.revision || 'default' }, body: JSON.stringify(design),
    });
    if (response.status === 409) {
      desired = null;
      // The server already holds a newer design; show it instead of this save.
      await reloadExternal(true);
      throw new Error('別の画面で見た目が変更されたため、最新の内容に切り替えました。もう一度操作してください。');
    }
    if (!response.ok) throw new Error(await failureMessage(response, '見た目を保存できません。'));
    const value = await response.json();
    state = { design: normalizeDesign(value.design, value.images), images: value.images, revision: value.revision };
    saves++;
    ownRevisions.add(value.revision);
    if (ownRevisions.size > 50) ownRevisions.delete(ownRevisions.values().next().value);
  }
  async function flush() {
    try { while (desired) { const next = desired; desired = null; await put(next); } }
    finally {
      flushing = null;
      // A change announced while saving may come from another page.
      if (latestRevision && !ownRevisions.has(latestRevision) && latestRevision !== state.revision) reloadExternal();
    }
  }

  const store = {
    get design() { return state.design; },
    get images() { return state.images; },
    get revision() { return state.revision; },
    get available() { return available; },
    get warning() { return warning; },
    // Resolves once this design, or a newer one requested meanwhile, is stored.
    save(design) {
      if (!available) return Promise.reject(new Error('見た目を保存できません。ローカルサーバーから開いているか確認してください。'));
      const normalized = normalizeDesign(design, state.images);
      state = { ...state, design: normalized };
      desired = normalized;
      if (!flushing) flushing = flush();
      return flushing;
    },
    async uploadImage(file) {
      if (!available) throw new Error('画像を保存できません。ローカルサーバーから開いているか確認してください。');
      const response = await fetchImpl('/api/design/images', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!response.ok) throw new Error(await failureMessage(response, '画像を保存できません。'));
      const { ref, ...info } = await response.json();
      state = { ...state, images: { ...state.images, [ref]: info } };
      return { ref, ...info };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };

  if (watch && typeof EventSourceClass === 'function') {
    const events = new EventSourceClass('/api/design/events');
    events.addEventListener('change', event => {
      try { latestRevision = JSON.parse(event.data).revision; } catch { return; }
      if (!flushing && !ownRevisions.has(latestRevision) && latestRevision !== state.revision) reloadExternal();
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
