import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesignStore, createPresetClient, checkPreset } from '../src/browser/design-client.js';
import { defaultDesign } from '../src/shared/design-model.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const id = 'a9f73841-92fb-4a91-966b-cbf59e62a3ff';
const ref = `images/${'a'.repeat(64)}.png`;
const images = { [ref]: { bytes: 100, type: 'image/png', width: 1, height: 1 } };
function server() {
  const requests = [], hooks = { put: [] };
  let current = { design: defaultDesign(), images: {}, revision: 'r0' }, serial = 0;
  const preset = { id, design: { ...defaultDesign(), name: '画像のあるプリセット', theme: '.pokome-workspace { color: #fff; }', studio: { ...defaultDesign().studio, image: ref }, outputSize: '1080x1920' }, images, revision: 'p1' };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  async function fetchImpl(url, options = {}) {
    const method = options.method || 'GET', body = options.body && JSON.parse(options.body);
    requests.push({ url, method, body, headers: options.headers });
    if (url === '/api/design/current' && method === 'GET') return reply(200, current);
    if (url === '/api/design/current' && method === 'PUT') {
      const hook = hooks.put.shift(); if (hook && await hook === 'fail') return reply(503, { error: '保存に失敗しました。' });
      if (options.headers['If-Match'] !== current.revision) return reply(409, { error: '別の画面で変更されました。' });
      current = { design: body.presetId ? preset.design : body, images: body.presetId ? images : current.images, revision: `r${++serial}` };
      return reply(200, current);
    }
    if (url === `/api/design/presets/${id}` && method === 'GET') return reply(200, preset);
    if (url === '/api/design/presets' && method === 'POST') return reply(201, { ...preset, design: { ...current.design, name: body.name } });
    return reply(200, { id, ...body });
  }
  return { fetchImpl, requests, hooks, preset, get current() { return current; }, external() { current = { ...current, revision: 'external' }; } };
}

test('reading a preset validates its isolated catalog without changing current or saving', async () => {
  const backend = server(), store = await createDesignStore({ fetchImpl: backend.fetchImpl, watch: false });
  const checked = [], client = createPresetClient(store, { fetchImpl: backend.fetchImpl, validate: async value => checked.push(value) });
  const before = structuredClone(store.design), preset = await client.read(id);
  assert.equal(preset.design.studio.image, ref);
  assert.equal(preset.design.outputSize, '1080x1920');
  assert.deepEqual(store.design, before); assert.deepEqual(store.images, {});
  assert.equal(checked.length, 1);
  assert.equal(backend.requests.filter(request => request.method !== 'GET').length, 0);
  preset.design.studio.title = 'draft only';
  assert.equal(store.design.studio.title, before.studio.title);
});

test('create and overwrite wait for pending current saves and use the acknowledged revision', async () => {
  const backend = server(), store = await createDesignStore({ fetchImpl: backend.fetchImpl, watch: false });
  const client = createPresetClient(store, { fetchImpl: backend.fetchImpl, validate: async () => {} }), hold = gate();
  backend.hooks.put.push(hold.promise);
  const saving = store.save({ ...store.design, name: 'latest design' });
  const creating = client.create(' 👩‍👩‍👧‍👦 '.repeat(1));
  await tick(); assert.equal(backend.requests.filter(request => request.method === 'POST').length, 0);
  hold.release(); await saving; await creating;
  const saved = backend.requests.find(request => request.method === 'POST');
  assert.deepEqual(saved.body, { name: '👩‍👩‍👧‍👦', currentRevision: 'r1' });
  await client.overwrite(backend.preset);
  const overwritten = backend.requests.at(-1);
  assert.deepEqual(overwritten.body, { overwrite: true, currentRevision: 'r1' }); assert.equal(overwritten.headers['If-Match'], 'p1');
});

test('apply changes the visible design and image catalog only after the server succeeds', async () => {
  const backend = server(), store = await createDesignStore({ fetchImpl: backend.fetchImpl, watch: false }), hold = gate(), notifications = [];
  store.subscribe(detail => notifications.push(detail));
  backend.hooks.put.push(hold.promise);
  const applying = store.applyPreset(backend.preset, store.revision);
  await tick(); assert.deepEqual(store.design, defaultDesign()); assert.deepEqual(store.images, {});
  await assert.rejects(store.save(store.design), /適用中/);
  hold.release(); await applying;
  assert.deepEqual(store.design, backend.preset.design); assert.deepEqual(store.images, images); assert.deepEqual(notifications, [{ applied: true }]);
  const request = backend.requests.find(request => request.method === 'PUT');
  assert.deepEqual(request.body, { presetId: id, presetRevision: 'p1' }); assert.equal(request.headers['If-Match'], 'r0');
});

test('failed apply preserves current and a changed current revision refuses stale apply and reset', async () => {
  const backend = server(), store = await createDesignStore({ fetchImpl: backend.fetchImpl, watch: false });
  backend.hooks.put.push(Promise.resolve('fail'));
  await assert.rejects(store.applyPreset(backend.preset, 'r0'), /失敗/); assert.deepEqual(store.design, defaultDesign());
  await store.save({ ...store.design, name: 'changed locally' });
  const requests = backend.requests.length;
  await assert.rejects(store.applyPreset(backend.preset, 'r0'), /別の画面/);
  await assert.rejects(store.reset('r0'), /別の画面/); assert.equal(backend.requests.length, requests);
  await store.reset('r1'); assert.deepEqual(store.design, defaultDesign());
});

test('names validate whole graphemes, reject excess/control text, and ids never enter paths unchecked', async () => {
  const backend = server(), store = await createDesignStore({ fetchImpl: backend.fetchImpl, watch: false });
  const client = createPresetClient(store, { fetchImpl: backend.fetchImpl, validate: async () => {} });
  await client.create('👩‍👩‍👧‍👦'.repeat(40));
  assert.equal(backend.requests.at(-1).body.name, '👩‍👩‍👧‍👦'.repeat(40));
  await assert.rejects(client.create('👩‍👩‍👧‍👦'.repeat(41)), /1〜40/);
  await assert.rejects(client.create('line\nbreak'), /制御/);
  await assert.rejects(client.read('../current'), /id/);
  assert.throws(() => client.openFolder('con'), /id/);
  await client.rename(backend.preset, '<b>そのままの文字</b>'); assert.equal(backend.requests.at(-1).headers['If-Match'], 'p1');
  await client.remove(backend.preset); assert.equal(backend.requests.at(-1).headers['If-Match'], 'p1');
});

test('browser verification compiles preset CSS and decodes references from its own image scope', async () => {
  const backend = server(), visited = [], compiled = [];
  class Image { naturalWidth = 1; naturalHeight = 1; set src(value) { visited.push(value); } async decode() {} }
  await checkPreset(backend.preset, { Image, compile: css => compiled.push(css) });
  assert.deepEqual(compiled, [backend.preset.design.theme]); assert.deepEqual(visited, [`/api/design/presets/${id}/images/${ref.slice(7)}`]);
  await assert.rejects(checkPreset(backend.preset, { Image: class { async decode() { throw new Error('bad'); } }, compile() {} }), /壊れて/);
  await assert.rejects(checkPreset(backend.preset, { Image: class { naturalWidth = 4001; naturalHeight = 4000; async decode() {} }, compile() {} }), /1600万/);
});
