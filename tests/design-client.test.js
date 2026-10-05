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

test('an unreachable server leaves the default design and refuses to save', async () => {
  const store = await createDesignStore({ fetchImpl: fakeServer({ failLoad: true }).fetchImpl, watch: false });
  assert.equal(store.available, false);
  assert.deepEqual(store.design, defaultDesign());
  assert.match(store.warning, /使えません/);
  await assert.rejects(store.applyDraft(defaultDesign(), store.revision), /ローカルサーバー/);
  await assert.rejects(store.uploadImage({ type: 'image/png' }), /ローカルサーバー/);
});

test('uploaded images join the catalog so their references survive normalization', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const { ref } = await store.uploadImage({ type: 'image/png' });
  await store.applyDraft({ ...defaultDesign(), studio: { ...defaultDesign().studio, image: ref } }, store.revision);
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
  await store.applyDraft(draft, store.revision);
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
  for (const operation of [() => store.applyDraft(defaultDesign(), store.revision), () => store.reset(),
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
  await assert.rejects(store.applyDraft({ ...defaultDesign(), name: '保存しない' }, store.revision), /退避/);
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
  await store.applyDraft({ ...defaultDesign(), name: '修復後' }, store.revision);
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

// A late reload must not restore an older revision and reject the next draft.
test('a slow reload never overwrites a newer apply, so later drafts are not refused', async () => {
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
  await store.applyDraft({ ...defaultDesign(), name: 'first' }, store.revision);
  let release; gate = { promise: new Promise(resolve => { release = resolve; }) };
  source.emit('change', { revision: 'from-another-page' });
  await new Promise(resolve => setTimeout(resolve, 0));
  gate = null;
  await store.applyDraft({ ...defaultDesign(), name: 'second' }, store.revision);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.design.name, 'second');
  assert.equal(store.revision, server.current.revision);
  await store.applyDraft({ ...defaultDesign(), name: 'third' }, store.revision);
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

test('a failed draft write never changes the design used for the next apply', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const events = [];
  store.subscribe(detail => events.push(detail));
  server.hooks.put.push(Promise.resolve('fail'));
  await assert.rejects(store.applyDraft({ ...store.design, name: 'cancelled draft' }, store.revision), /書き込めません/);
  assert.equal(store.design.name, '', 'the page goes back to the saved design');
  assert.deepEqual(events, [], 'a failed draft write never changes the applied design');
  await store.applyDraft(withStudio(store.design, { theme: 'rose' }), store.revision);
  assert.equal(server.current.design.name, '');
  assert.equal(server.current.design.studio.theme, 'rose');
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
  await store.applyDraft(rose, store.revision);
  FakeEvents.last.emit('change', { revision: server.current.revision });
  await store.applyDraft(withStudio(defaultDesign(), { theme: 'violet' }), store.revision);
  FakeEvents.last.emit('change', { revision: server.current.revision });
  await tick();
  FakeEvents.last.emit('change', { revision: server.external(rose) });
  await tick(); await tick();
  assert.equal(store.design.studio.theme, 'rose');
});

test('applyDraft stores the whole draft in one write conditioned on its opening revision', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const events = [];
  store.subscribe(detail => events.push(detail));
  const opened = store.revision;
  let draft = withTalk({ ...defaultDesign(), theme: '.pokome-workspace{}', outputSize: '1080x1920' }, '9:16', { actorImage: { ...defaultActorImage(), mode: 'custom', scale: 120 } });
  draft = { ...draft, studio: { ...draft.studio, title: '下書き' } };
  await store.applyDraft(draft, opened);
  const puts = server.requests.filter(request => request.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].headers['If-Match'], opened);
  assert.equal(server.current.design.studio.title, '下書き');
  assert.equal(server.current.design.ratios['9:16'].actorImage.scale, 120);
  assert.equal(store.design.outputSize, '1080x1920');
  assert.deepEqual(events, [{ applied: true }], 'the own apply is not reported as an external change');
});

test('applyDraft refuses a draft opened before a newer save, without writing', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const opened = store.revision;
  await store.applyDraft({ ...defaultDesign(), name: 'elsewhere' }, store.revision);
  await assert.rejects(store.applyDraft({ ...defaultDesign(), name: 'draft' }, opened), error => error.conflict === true && /最新のデザインから/.test(error.message));
  assert.equal(server.requests.filter(request => request.method === 'PUT').length, 1);
  assert.equal(server.current.design.name, 'elsewhere');
});

test('a conflict answered by the server marks the draft stale and keeps the other design', async () => {
  const server = fakeServer({ conflictOnce: true });
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const events = [];
  store.subscribe(detail => events.push(detail));
  await assert.rejects(store.applyDraft({ ...defaultDesign(), name: 'draft' }, store.revision), error => error.conflict === true && /最新のデザインから/.test(error.message));
  assert.equal(store.revision, 'other');
  assert.equal(server.current.design.name, '');
  assert.deepEqual(events, [{ external: true }]);
});

test('applyDraft stops when an image the draft uses is not in the catalog', async () => {
  const server = fakeServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const missing = `images/${'b'.repeat(64)}.png`;
  await assert.rejects(store.applyDraft({ ...defaultDesign(), studio: { ...defaultDesign().studio, source: 'image', image: missing } }, store.revision), /画像を選び直して/);
  assert.equal(server.requests.filter(request => request.method === 'PUT').length, 0);
  const { ref } = await store.uploadImage({ type: 'image/png' });
  await store.applyDraft({ ...defaultDesign(), studio: { ...defaultDesign().studio, source: 'image', image: ref } }, store.revision);
  assert.equal(server.current.design.studio.image, ref);
});

test('a pending draft rejects concurrent draft, preset and reset writes without changing the applied design', async () => {
  const server = contentServer();
  const store = await createDesignStore({ fetchImpl: server.fetchImpl, watch: false });
  const hold = gate(); server.hooks.put.push(hold.promise);
  const applying = store.applyDraft({ ...store.design, name: 'first draft' }, store.revision);
  const before = structuredClone(store.design);
  await assert.rejects(store.applyDraft({ ...store.design, name: 'second draft' }, store.revision), /適用中/);
  await assert.rejects(store.applyPreset({ id: 'saved', revision: 'p0' }, store.revision), /別の画面/);
  await assert.rejects(store.reset(), /適用中/);
  assert.equal(server.requests.filter(request => request.method === 'PUT').length, 1);
  assert.deepEqual(store.design, before);
  hold.release(); await applying;
  assert.equal(store.design.name, 'first draft');
});
