import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createServer } from '../server.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { UNREFERENCED_IMAGE_GRACE_MS } from '../src/server/design-storage.js';
import { fixtureDesign, fixtureFiles, fixtureImages } from './fixtures/preset-design.js';

const unreadable = {
  'broken JSON': '{"format":"pokome-design","version":2,',
  'unknown version': JSON.stringify({ ...fixtureDesign(), version: 99 }),
};

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-unreadable-'));
  const directory = join(folder, 'customization');
  const server = createServer({ customizationDirectory: directory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolveClose => server.close(resolveClose));
    const target = resolve(folder);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('pokome-unreadable-'));
    await rm(target, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method, body, revision) => fetch(base + path, {
    method, headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) },
    body: JSON.stringify(body),
  });
  const current = async () => (await (await fetch(base + '/api/design/current')).json());
  await current();
  for (const [ref, bytes] of Object.entries(fixtureFiles)) {
    const response = await fetch(base + '/api/design/images', { method: 'PUT', body: bytes,
      headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': fixtureImages[ref].type } });
    assert.equal(response.status, 200);
  }
  assert.equal((await send('/api/design/current', 'PUT', fixtureDesign(), (await current()).revision)).status, 200);
  const created = await send('/api/design/presets', 'POST', { name: '保持するプリセット', currentRevision: (await current()).revision });
  assert.equal(created.status, 201);
  const preset = await created.json();
  const originalPath = join(directory, 'current', 'design.json');
  async function damage(raw, target = join(directory, 'current')) {
    await writeFile(join(target, 'design.json'), raw);
    const past = new Date(Date.now() - UNREFERENCED_IMAGE_GRACE_MS - 60000);
    for (const ref of Object.keys(fixtureFiles)) await utimes(join(target, ref), past, past);
  }
  async function assertImages(target = join(directory, 'current')) {
    for (const [ref, bytes] of Object.entries(fixtureFiles)) assert.deepEqual(await readFile(join(target, ref)), bytes);
  }
  return { base, directory, send, current, preset, originalPath, damage, assertImages };
}

for (const [kind, raw] of Object.entries(unreadable)) {
  for (const operation of ['list', 'rename', 'delete']) {
    test(`${kind}: ${operation} preserves aged current images and the original design`, async t => {
      const app = await fixture(t); await app.damage(raw);
      let response;
      if (operation === 'list') response = await fetch(app.base + '/api/design/presets');
      if (operation === 'rename') response = await app.send(`/api/design/presets/${app.preset.id}`, 'PUT', { name: '名前だけ変更' }, app.preset.revision);
      if (operation === 'delete') response = await app.send(`/api/design/presets/${app.preset.id}`, 'DELETE', {}, app.preset.revision);
      assert.equal(response.status, 200);
      // This assertion fails on master: fallback defaults mark every image unused.
      await app.assertImages();
      assert.equal(await readFile(app.originalPath, 'utf8'), raw);
    });
  }

  for (const operation of ['save', 'reset', 'apply', 'create preset', 'overwrite preset']) {
    test(`${kind}: ${operation} cannot replace or export fallback defaults`, async t => {
      const app = await fixture(t); await app.damage(raw);
      const before = await app.current();
      const presetPath = join(app.directory, 'presets', app.preset.id, 'design.json');
      const presetBefore = await readFile(presetPath, 'utf8');
      let response;
      if (operation === 'save') response = await app.send('/api/design/current', 'PUT', { ...defaultDesign(), name: '変更' }, before.revision);
      if (operation === 'reset') response = await app.send('/api/design/current', 'PUT', defaultDesign(), before.revision);
      if (operation === 'apply') response = await app.send('/api/design/current', 'PUT', { presetId: app.preset.id, presetRevision: app.preset.revision }, before.revision);
      if (operation === 'create preset') response = await app.send('/api/design/presets', 'POST', { name: '作成しない', currentRevision: before.revision });
      if (operation === 'overwrite preset') response = await app.send(`/api/design/presets/${app.preset.id}`, 'PUT', { overwrite: true, currentRevision: before.revision }, app.preset.revision);
      assert.equal(response.status, 422, operation);
      assert.match((await response.json()).error, /退避/);
      assert.equal(await readFile(app.originalPath, 'utf8'), raw);
      assert.equal(await readFile(presetPath, 'utf8'), presetBefore);
      assert.deepEqual(await readdir(join(app.directory, 'presets')), [app.preset.id]);
      await app.assertImages();
    });
  }

  test(`${kind}: unreadable preset images remain untouched by listing and refused operations`, async t => {
    const app = await fixture(t);
    const presetFolder = join(app.directory, 'presets', app.preset.id);
    await app.damage(raw, presetFolder);
    const response = await fetch(app.base + '/api/design/presets');
    assert.equal(response.status, 200);
    assert.ok((await response.json()).presets.find(preset => preset.id === app.preset.id).error);
    assert.equal((await fetch(`${app.base}/api/design/presets/${app.preset.id}`)).status, 422);
    const currentBefore = await readFile(app.originalPath, 'utf8');
    const revision = (await app.current()).revision;
    assert.equal((await app.send('/api/design/current', 'PUT', { presetId: app.preset.id, presetRevision: app.preset.revision }, revision)).status, 422);
    assert.equal(await readFile(app.originalPath, 'utf8'), currentBefore);
    assert.equal(await readFile(join(presetFolder, 'design.json'), 'utf8'), raw);
    await app.assertImages(presetFolder);
  });
}

test('unreadable current reports protection, and fixing the original restores saving', async t => {
  const app = await fixture(t); await app.damage(unreadable['broken JSON']);
  const blocked = await app.current();
  assert.deepEqual(blocked.design, defaultDesign());
  assert.equal(blocked.readOnly, true);
  assert.match(blocked.warning, /標準.*退避/);
  await writeFile(app.originalPath, JSON.stringify(fixtureDesign()));
  const repaired = await app.current();
  assert.notEqual(repaired.readOnly, true);
  const saved = await app.send('/api/design/current', 'PUT', { ...fixtureDesign(), name: '修復後' }, repaired.revision);
  assert.equal(saved.status, 200);
  await app.assertImages();
});
