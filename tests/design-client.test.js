import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesignStore, checkImageFile } from '../design-client.js';
import { defaultDesign, MAX_IMAGE_BYTES } from '../design-model.js';

// A fake server that records requests and can be told to reject a revision.
function fakeServer({ revision = 'r0', conflictOnce = false, failLoad = false } = {}) {
  const requests = [];
  let current = { design: defaultDesign(), images: {}, revision }, conflict = conflictOnce, count = 0;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (url === '/api/design/current' && (!options.method || options.method === 'GET')) return failLoad ? reply(503, { error: '使えません。' }) : reply(200, current);
    if (url === '/api/design/current' && options.method === 'PUT') {
      if (conflict) { conflict = false; current = { ...current, revision: 'other' }; return reply(409, { error: 'conflict', revision: 'other' }); }
      if (options.headers['If-Match'] !== current.revision) return reply(409, { error: 'stale' });
      current = { design: JSON.parse(options.body), images: current.images, revision: `r${++count}` };
      return reply(200, current);
    }
    if (url === '/api/design/images') {
      const ref = `images/${'a'.repeat(64)}.png`, info = { type: 'image/png', bytes: 10, width: 1, height: 1 };
      current = { ...current, images: { ...current.images, [ref]: info } };
      return reply(200, { ref, ...info });
    }
    return reply(404, {});
  };
  return { fetchImpl, requests, get current() { return current; } };
}

test('saves are serialized, chained by revision, and only the newest pending design is sent', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  assert.equal(store.available, true);
  const first = store.save({ ...defaultDesign(), name: 'one' });
  store.save({ ...defaultDesign(), name: 'two' });
  const last = store.save({ ...defaultDesign(), name: 'three' });
  assert.equal(store.design.name, 'three', 'the page shows the newest design at once');
  await Promise.all([first, last]);
  const puts = server.requests.filter(request => request.method === 'PUT');
  assert.deepEqual(puts.map(request => JSON.parse(request.body).name), ['one', 'three']);
  assert.deepEqual(puts.map(request => request.headers['If-Match']), ['r0', 'r1']);
  assert.equal(store.revision, 'r2');
  assert.equal(server.current.design.name, 'three');
});

test('a conflict reloads the latest design, notifies listeners and rejects the save', async () => {
  const server = fakeServer({ conflictOnce: true });
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const events = [];
  store.subscribe(detail => events.push(detail));
  await assert.rejects(store.save({ ...defaultDesign(), name: 'mine' }), /別の画面/);
  assert.equal(store.revision, 'other');
  assert.equal(store.design.name, '');
  assert.deepEqual(events, [{ external: true }]);
});

test('an unreachable server leaves the default design and refuses to save', async () => {
  const store = await createDesignStore({ fetchImpl: fakeServer({ failLoad: true }).fetchImpl, watch: false });
  assert.equal(store.available, false);
  assert.deepEqual(store.design, defaultDesign());
  assert.match(store.warning, /使えません/);
  await assert.rejects(store.save(defaultDesign()), /ローカルサーバー/);
  await assert.rejects(store.uploadImage({ type: 'image/png' }), /ローカルサーバー/);
});

test('uploaded images join the catalog so their references survive normalization', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const { ref } = await store.uploadImage({ type: 'image/png' });
  await store.save({ ...defaultDesign(), studio: { ...defaultDesign().studio, image: ref } });
  assert.equal(store.design.studio.image, ref);
  assert.equal(server.current.design.studio.image, ref);
});

test('change events from other pages reload the design once it differs', async () => {
  const server = fakeServer();
  let source;
  class FakeEventSource {
    constructor(url) { assert.equal(url, '/api/design/events'); source = this; this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    emit(type, data) { for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(data) }); }
  }
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, EventSourceClass: FakeEventSource });
  const events = [];
  store.subscribe(detail => events.push(detail));
  source.emit('open', {});
  source.emit('change', { revision: 'r0' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(events.length, 0, 'the first open and an unchanged revision do nothing');
  await server.fetchImpl('/api/design/current', { method: 'PUT', headers: { 'If-Match': 'r0' }, body: JSON.stringify({ ...defaultDesign(), name: 'other tab' }) });
  source.emit('change', { revision: 'r1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.design.name, 'other tab');
  assert.deepEqual(events, [{ external: true }]);
});

test('image files are checked for type, 20MB, decoding and pixels before uploading', async () => {
  const environment = ({ width = 10, height = 10, decode = true } = {}) => ({
    Image: class { naturalWidth = width; naturalHeight = height; async decode() { if (!decode) throw new Error('bad'); } },
    urls: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  });
  const file = (type = 'image/png', size = 100) => ({ type, size });
  await checkImageFile(file(), environment());
  await checkImageFile(file('image/png', MAX_IMAGE_BYTES), environment());
  await assert.rejects(checkImageFile(file('image/png', MAX_IMAGE_BYTES + 1), environment()), /20MB/);
  await assert.rejects(checkImageFile(file('image/svg+xml'), environment()), /20MB/);
  await assert.rejects(checkImageFile(file('image/png', 0), environment()));
  await assert.rejects(checkImageFile(file(), environment({ decode: false })), /壊れて/);
  await assert.rejects(checkImageFile(file(), environment({ width: 4001, height: 4000 })), /1600万/);
});

// Regression: a reload answered after a newer save must not restore the older
// revision, or the next save is rejected as if another page had changed it.
test('a slow reload never overwrites a newer save, so later saves are not refused', async () => {
  const server = fakeServer();
  let gate, source;
  const slowFetch = async (url, options = {}) => {
    if (url === '/api/design/current' && !options.method && gate) {
      const snapshot = structuredClone(server.current);
      await gate.promise;
      return { ok: true, status: 200, json: async () => snapshot };
    }
    return server.fetchImpl(url, options);
  };
  class FakeEventSource {
    constructor() { source = this; this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    emit(type, data) { for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(data) }); }
  }
  const store = await createDesignStore({ fetchImpl: slowFetch, EventSourceClass: FakeEventSource });
  await store.save({ ...defaultDesign(), name: 'first' });
  let release; gate = { promise: new Promise(resolve => { release = resolve; }) };
  source.emit('change', { revision: 'from-another-page' });
  await new Promise(resolve => setTimeout(resolve, 0));
  gate = null;
  await store.save({ ...defaultDesign(), name: 'second' });
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.design.name, 'second');
  assert.equal(store.revision, server.current.revision);
  await store.save({ ...defaultDesign(), name: 'third' });
  assert.equal(server.current.design.name, 'third');
});
