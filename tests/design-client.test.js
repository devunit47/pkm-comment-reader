import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesignStore, createPresetClient, checkImageFile } from '../src/browser/design-client.js';
import { defaultDesign, defaultActorImage, withTalk, RATIOS, MAX_IMAGE_BYTES } from '../src/shared/design-model.js';

// A fake server that records requests and can be told to reject a revision.
function fakeServer({ revision = 'r0', conflictOnce = false, failLoad = false } = {}) {
  const requests = [];
  let current = { design: defaultDesign(), images: {}, revision }, conflict = conflictOnce, count = 0;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (url === '/api/design/current' && (!options.method || options.method === 'GET')) return failLoad ? reply(503, { error: '使えません。' }) : reply(200, current);
    if (url === '/api/design/current' && options.method === 'PUT') {
      if (current.readOnly) return reply(422, { error: current.warning, readOnly: true });
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

test('version 2 client loading performs no write and a later save sends version 3 with every ratio', async () => {
  const server = fakeServer();
  server.current.design = { ...defaultDesign(), version: 2,
    theme: '.pokome-workspace .actor-figure { transform: scale(1.1); }',
    ratios: { '16:9': { layout: null, overlays: { version: 1, items: [], assets: {} }, actorImage: { mode: 'custom', scale: 200 } }, '9:16': null, '4:3': null } };
  const original = structuredClone(server.current.design);
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  assert.deepEqual(server.requests.map(request => request.method), ['GET']);
  assert.deepEqual(server.current.design, original);
  assert.equal(store.design.version, 3);
  assert.deepEqual(store.design.ratios['16:9'].actorImage, defaultActorImage(), 'surplus version 2 settings are ignored');
  let draft = store.design;
  for (const [index, ratio] of RATIOS.entries()) draft = withTalk(draft, ratio, { actorImage: {
    ...defaultActorImage(), mode: index === 1 ? 'theme' : 'custom', scale: 110 + index * 10, offsetX: index + 0.125, offsetY: -8.5,
  } });
  await store.save(draft);
  const put = server.requests.find(request => request.method === 'PUT');
  assert.equal(JSON.parse(put.body).version, 3);
  assert.deepEqual(server.current.design, draft);
  assert.deepEqual(store.design, draft);
});

test('unreadable originals keep the server available but refuse every current write', async () => {
  const server = fakeServer();
  Object.assign(server.current, { readOnly: true, warning: '原本を退避してください。' });
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const presets = createPresetClient(store, { fetchImpl: server.fetchImpl });
  assert.equal(store.available, true);
  assert.equal(store.writable, false);
  for (const operation of [() => store.save(defaultDesign()), () => store.reset(),
    () => store.applyPreset({ id: 'saved', revision: 'preset-r0' }, store.revision),
    () => store.uploadImage({ type: 'image/png' }), () => presets.create('保存しない'),
    () => presets.overwrite({ id: 'saved', revision: 'preset-r0' })]) {
    await assert.rejects(operation(), /退避/);
  }
  assert.deepEqual(server.requests.map(request => request.method), ['GET']);
  assert.deepEqual(store.design, defaultDesign());
});

test('a protection response refreshes the reason when the original breaks after page load', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  Object.assign(server.current, { revision: 'broken', readOnly: true, warning: '原本を退避してください。' });
  await assert.rejects(store.save({ ...defaultDesign(), name: '保存しない' }), /退避/);
  assert.equal(store.writable, false);
  assert.equal(store.revision, 'broken');
  assert.match(store.warning, /退避/);
  assert.deepEqual(store.design, defaultDesign());
  await assert.rejects(store.reset(), /退避/);
  assert.equal(server.requests.filter(request => request.method === 'PUT').length, 1);
});

test('reloading a repaired original clears protection and restores saving', async () => {
  const server = fakeServer();
  Object.assign(server.current, { readOnly: true, warning: '原本を退避してください。' });
  let source;
  class Events {
    constructor() { source = this; this.listeners = {}; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, EventSourceClass: Events });
  delete server.current.readOnly; delete server.current.warning; server.current.revision = 'repaired';
  source.listeners.change({ data: JSON.stringify({ revision: 'repaired' }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.writable, true);
  assert.equal(store.warning, '');
  await store.save({ ...defaultDesign(), name: '修復後' });
  assert.equal(store.design.name, '修復後');
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

// --- Review findings on PR #9: each reproduced a lost or stale design. ---

// A server whose revisions are content hashes (like design-storage.js), with
// hooks to fail or hold individual requests.
function contentServer() {
  const requests = [];
  const revisionOf = design => `h:${JSON.stringify(design)}`;
  let current = { design: defaultDesign(), images: {}, revision: 'default' };
  const hooks = { put: [], get: [] };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method });
    if (url !== '/api/design/current') return reply(404, {});
    if (method === 'GET') {
      const snapshot = structuredClone(current);
      const hook = hooks.get.shift();
      if (hook) await hook;
      return reply(200, snapshot);
    }
    const hook = hooks.put.shift();
    if (hook) { const outcome = await hook; if (outcome === 'fail') return reply(503, { error: '書き込めません。' }); }
    if (options.headers['If-Match'] !== current.revision) return reply(409, { error: 'stale' });
    const design = JSON.parse(options.body);
    current = { design, images: current.images, revision: revisionOf(design) };
    return reply(200, current);
  };
  // Another page saves directly on the server.
  const external = design => { current = { design, images: current.images, revision: revisionOf(design) }; return current.revision; };
  return { fetchImpl, requests, hooks, external, get current() { return current; } };
}
class FakeEvents {
  static last;
  constructor() { FakeEvents.last = this; this.listeners = {}; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  emit(type, data) { for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(data) }); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const withStudio = (design, studio) => ({ ...design, studio: { ...design.studio, ...studio } });

test('a failed save is discarded instead of riding along with the next save', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const events = [];
  store.subscribe(detail => events.push(detail));
  server.hooks.put.push(Promise.resolve('fail'));
  await assert.rejects(store.save({ ...store.design, name: 'cancelled draft' }), /書き込めません/);
  assert.equal(store.design.name, '', 'the page goes back to the saved design');
  assert.deepEqual(events, [{ reverted: true }]);
  await store.save(withStudio(store.design, { theme: 'rose' }));
  assert.equal(server.current.design.name, '');
  assert.equal(server.current.design.studio.theme, 'rose');
});

test('an older save response keeps the newer edits waiting to be saved', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const first = gate(), second = gate();
  server.hooks.put.push(first.promise, second.promise);
  store.save({ ...store.design, theme: '.pokome-workspace{}' });
  await tick();
  store.save({ ...store.design, outputSize: '1920x1080' });
  first.release(); await tick(); await tick();
  assert.equal(store.design.outputSize, '1920x1080', 'the size change stays while its save is pending');
  const last = store.save(withStudio(store.design, { theme: 'violet' }));
  second.release();
  await last;
  assert.equal(server.current.design.outputSize, '1920x1080');
  assert.equal(server.current.design.studio.theme, 'violet');
  assert.equal(server.current.design.theme, '.pokome-workspace{}');
});

test('reloads answered out of order never go back to an older external design', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, EventSourceClass: FakeEvents });
  const slow = gate();
  server.hooks.get.push(slow.promise);
  FakeEvents.last.emit('change', { revision: server.external(withStudio(defaultDesign(), { theme: 'rose' })) });
  await tick();
  FakeEvents.last.emit('change', { revision: server.external(withStudio(defaultDesign(), { theme: 'violet' })) });
  await tick(); await tick();
  assert.equal(store.design.studio.theme, 'violet');
  slow.release(); await tick(); await tick();
  assert.equal(store.design.studio.theme, 'violet', 'the late answer for rose is ignored');
});

test('an external change back to content this page saved earlier is still applied', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, EventSourceClass: FakeEvents });
  const rose = withStudio(defaultDesign(), { theme: 'rose' });
  await store.save(rose);
  FakeEvents.last.emit('change', { revision: server.current.revision });
  await store.save(withStudio(defaultDesign(), { theme: 'violet' }));
  FakeEvents.last.emit('change', { revision: server.current.revision });
  await tick();
  FakeEvents.last.emit('change', { revision: server.external(rose) });
  await tick(); await tick();
  assert.equal(store.design.studio.theme, 'rose');
});
