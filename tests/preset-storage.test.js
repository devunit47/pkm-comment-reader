import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { request } from 'node:http';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer } from '../server.js';
import { defaultDesign, defaultActorImage, normalizeDesign, MAX_IMAGE_BYTES, RATIOS } from '../src/shared/design-model.js';
import { replacePresetDirectory, UNREFERENCED_IMAGE_GRACE_MS } from '../src/server/design-storage.js';
import { fixtureDesign, fixtureFiles, fixtureImages, actorRef, backgroundRef } from './fixtures/preset-design.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const imageName = ref => ref.slice(7);
const past = () => new Date(Date.now() - UNREFERENCED_IMAGE_GRACE_MS - 60000);

async function serve(t) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-presets-'));
  const directory = join(folder, 'customization');
  const server = createServer({ customizationDirectory: directory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method, value, headers = {}) => fetch(base + path, { method,
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value) });
  const json = async (response, status = 200) => {
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const current = async () => json(await fetch(`${base}/api/design/current`));
  const save = async design => json(await send('/api/design/current', 'PUT', design, { 'If-Match': (await current()).revision }));
  const newPreset = async name => json(await send('/api/design/presets', 'POST', { name, currentRevision: (await current()).revision }), 201);
  const getPreset = async id => json(await fetch(`${base}/api/design/presets/${id}`));
  const list = async () => json(await fetch(`${base}/api/design/presets`));
  const update = async (preset, value) => json(await send(`/api/design/presets/${preset.id}`, 'PUT', value, { 'If-Match': preset.revision }));
  const remove = async preset => json(await send(`/api/design/presets/${preset.id}`, 'DELETE', {}, { 'If-Match': preset.revision }));
  const uploadFixture = async () => {
    for (const [ref, bytes] of Object.entries(fixtureFiles)) {
      const uploaded = await json(await fetch(`${base}/api/design/images`, { method: 'PUT', body: bytes,
        headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': fixtureImages[ref].type } }));
      assert.equal(uploaded.ref, ref);
    }
  };
  const apply = async preset => json(await send('/api/design/current', 'PUT', { presetId: preset.id, presetRevision: preset.revision },
    { 'If-Match': (await current()).revision }));
  await current(); await list();
  return { base, folder, directory, send, json, current, save, newPreset, getPreset, list, update, remove, uploadFixture, apply };
}

async function manualPreset(directory, id, design = fixtureDesign(), files = fixtureFiles) {
  const folder = join(directory, 'presets', id);
  await mkdir(folder); await mkdir(join(folder, 'images'));
  await writeFile(join(folder, 'design.json'), typeof design === 'string' ? design : JSON.stringify(design));
  for (const [ref, bytes] of Object.entries(files)) await writeFile(join(folder, ref), bytes);
  return folder;
}

async function openedFilesDuring(operation) {
  const original = fs.open, files = [];
  fs.open = async (path, ...options) => { files.push(String(path)); return original(path, ...options); };
  syncBuiltinESMExports();
  try { await operation(); }
  finally { fs.open = original; syncBuiltinESMExports(); }
  return files;
}

test('saving a complete scene, resetting, previewing and applying preserves every ratio, theme and image', async t => {
  const app = await serve(t); await app.uploadFixture();
  const design = fixtureDesign(); await app.save(design);
  const preset = await app.newPreset(design.name);
  assert.match(preset.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(preset.design, design);
  assert.deepEqual(preset.images, fixtureImages);
  assert.deepEqual((await readdir(join(app.directory, 'presets', preset.id))).sort(), ['design.json', 'images']);
  for (const ref of Object.keys(fixtureFiles)) {
    assert.deepEqual(await readFile(join(app.directory, 'presets', preset.id, ref)), fixtureFiles[ref]);
    const response = await fetch(`${app.base}/api/design/presets/${preset.id}/images/${imageName(ref)}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureFiles[ref]);
  }
  const reset = await app.save(defaultDesign());
  const draft = await app.getPreset(preset.id);
  assert.deepEqual(draft.design, design);
  // Reading a draft and cancelling it have no server write to perform.
  assert.deepEqual(await app.current(), reset);
  for (const ratio of RATIOS) assert.deepEqual(draft.design.ratios[ratio], design.ratios[ratio]);
  const restored = await app.apply(draft);
  assert.deepEqual(restored.design, design);
  assert.deepEqual(await app.current(), restored);
  assert.equal(Object.hasOwn(restored.design, 'backgroundMode'), false);
  assert.equal(Object.hasOwn(restored.design, 'chromaColor'), false);
});

test('version 2 preset preview preserves its original, applying upgrades only current and renaming upgrades the preset', async t => {
  const app = await serve(t), normalized = fixtureDesign();
  const legacy = structuredClone(normalized); legacy.version = 2;
  for (const ratio of RATIOS) delete legacy.ratios[ratio].actorImage;
  const folder = await manualPreset(app.directory, 'legacy-scene', legacy);
  const path = join(folder, 'design.json'), raw = await readFile(path, 'utf8'), before = await stat(path);
  const imageTimes = {};
  for (const ref of Object.keys(fixtureFiles)) {
    const date = past(); await utimes(join(folder, ref), date, date);
    imageTimes[ref] = (await stat(join(folder, ref))).mtimeMs;
  }
  const list = await app.list();
  assert.equal(list.presets.find(item => item.id === 'legacy-scene').error, undefined);
  const preview = await app.getPreset('legacy-scene');
  assert.deepEqual(preview.design, normalized);
  for (const ratio of RATIOS) assert.deepEqual(preview.design.ratios[ratio].actorImage, defaultActorImage());
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  for (const ref of Object.keys(fixtureFiles)) {
    assert.deepEqual(await readFile(join(folder, ref)), fixtureFiles[ref]);
    assert.equal((await stat(join(folder, ref))).mtimeMs, imageTimes[ref]);
  }
  const applied = await app.apply(preview);
  assert.deepEqual(applied.design, normalized);
  assert.equal(JSON.parse(await readFile(join(app.directory, 'current', 'design.json'), 'utf8')).version, 3);
  assert.equal(await readFile(path, 'utf8'), raw, 'applying writes only current');
  const renamed = await app.update(preview, { name: '旧デザインの名前変更' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 3);
  assert.deepEqual(renamed.design, { ...normalized, name: '旧デザインの名前変更' });
});

test('new actor image settings and off-canvas images round-trip through current and all preset writes', async t => {
  const app = await serve(t); await app.uploadFixture();
  const design = fixtureDesign();
  for (const [index, ratio] of RATIOS.entries()) {
    design.ratios[ratio].actorImage = { mode: index === 1 ? 'theme' : 'custom', scale: 110 + index * 45,
      alignX: ['left', 'center', 'right'][index], alignY: ['bottom', 'center', 'top'][index],
      offsetX: [-100, 1.125, 100][index], offsetY: [100, -3.125, -100][index], overflow: index !== 1 };
    Object.assign(design.ratios[ratio].overlays.items[0], [
      { x: -100, y: -100, w: 200, h: 200 }, { x: 0, y: 8.5, w: 100, h: 100 }, { x: 98, y: 98, w: 2, h: 2 },
    ][index]);
  }
  const expected = normalizeDesign(design, fixtureImages);
  assert.deepEqual((await app.save(design)).design, expected);
  let preset = await app.newPreset(design.name);
  assert.deepEqual(preset.design, expected);
  assert.deepEqual((await app.getPreset(preset.id)).design, expected);
  await app.save(defaultDesign());
  assert.deepEqual((await app.apply(preset)).design, expected);
  preset = await app.update(preset, { overwrite: true, currentRevision: (await app.current()).revision });
  assert.deepEqual(preset.design, expected);
  const renamed = await app.update(preset, { name: '画像配置の保存' });
  assert.deepEqual(renamed.design, { ...expected, name: '画像配置の保存' });
  assert.equal(JSON.parse(await readFile(join(app.directory, 'presets', preset.id, 'design.json'), 'utf8')).version, 3);
  for (const ref of Object.keys(fixtureFiles)) assert.deepEqual(await readFile(join(app.directory, 'presets', preset.id, ref)), fixtureFiles[ref]);
});

test('creating a preset from version 2 current writes a new version 3 preset without converting current', async t => {
  const app = await serve(t); await app.uploadFixture();
  const normalized = fixtureDesign(), legacy = structuredClone(normalized); legacy.version = 2;
  for (const ratio of RATIOS) delete legacy.ratios[ratio].actorImage;
  const path = join(app.directory, 'current', 'design.json'), raw = JSON.stringify(legacy, null, 2) + '\n';
  await writeFile(path, raw);
  const preset = await app.newPreset(legacy.name);
  assert.deepEqual(preset.design, normalized);
  assert.equal(JSON.parse(await readFile(join(app.directory, 'presets', preset.id, 'design.json'), 'utf8')).version, 3);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('current saves never read preset images', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const presetFiles = new Set();
  for (let index = 0; index < 3; index++) {
    const preset = await app.newPreset(`画像確認 ${index}`);
    for (const ref of Object.keys(fixtureFiles)) presetFiles.add(join(app.directory, 'presets', preset.id, ref));
  }
  const files = await openedFilesDuring(() => app.save({ ...fixtureDesign(), name: 'currentのみ更新' }));
  assert.deepEqual(files.filter(path => presetFiles.has(path)), [], 'current saving must not inspect any preset image');
});

test('a preset image GET reads only the requested image once', async t => {
  const app = await serve(t), folder = await manualPreset(app.directory, 'single-image-read');
  const files = await openedFilesDuring(async () => {
    const response = await fetch(`${app.base}/api/design/presets/single-image-read/images/${imageName(actorRef)}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureFiles[actorRef]);
  });
  assert.deepEqual(files.filter(path => dirname(path) === join(folder, 'images')), [join(folder, actorRef)]);
});

test('a pending preset image read never blocks a current save', async t => {
  const app = await serve(t), folder = await manualPreset(app.directory, 'pending-image');
  const original = fs.open, target = join(folder, actorRef), timers = [];
  let release, started, imageRequest, saving, intercepted = false;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const deadline = message => new Promise((_, reject) => { timers.push(setTimeout(() => reject(new Error(message)), 3000)); });
  fs.open = async (path, ...options) => {
    if (String(path) === target && !intercepted) { intercepted = true; started(); await gate; }
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  try {
    imageRequest = fetch(`${app.base}/api/design/presets/pending-image/images/${imageName(actorRef)}`);
    await Promise.race([ready, deadline('image reading did not start')]);
    saving = app.save({ ...defaultDesign(), name: '画像の待機中も保存' });
    assert.equal((await Promise.race([saving, deadline('current save waited for a preset image')])).design.name, '画像の待機中も保存');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    release(); fs.open = original; syncBuiltinESMExports();
    if (imageRequest) { const response = await imageRequest; assert.equal(response.status, 200); await response.arrayBuffer(); }
    if (saving) await saving;
  }
});

test('a direct preset image GET rejects forged bytes, invalid paths and directory junctions', async t => {
  const app = await serve(t), folder = await manualPreset(app.directory, 'checked-image');
  const path = `${app.base}/api/design/presets/checked-image/images/${imageName(actorRef)}`;
  await writeFile(join(folder, actorRef), fixtureFiles[backgroundRef]);
  const forged = await fetch(path); assert.equal(forged.status, 404); await forged.arrayBuffer();
  const svg = await fetch(path.replace('.png', '.svg')); assert.equal(svg.status, 404); await svg.arrayBuffer();
  const traversal = await fetch(path.replace('checked-image', '..%2Fcurrent')); assert.equal(traversal.status, 400); await traversal.arrayBuffer();
  const missing = await fetch(path.replace('checked-image', 'missing')); assert.equal(missing.status, 404); await missing.arrayBuffer();
  const outside = join(app.folder, 'outside-get'); await mkdir(outside); await writeFile(join(outside, imageName(actorRef)), fixtureFiles[actorRef]);
  await rm(join(folder, 'images'), { recursive: true }); await symlink(outside, join(folder, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await fetch(path); assert.ok([422, 503].includes(linked.status)); await linked.arrayBuffer();
  assert.deepEqual(await readFile(join(outside, imageName(actorRef))), fixtureFiles[actorRef]);
});

test('a directory swap during a preset image GET is rejected before sending bytes', async t => {
  const app = await serve(t), folder = await manualPreset(app.directory, 'swapped-get');
  const imageFolder = join(folder, 'images'), outside = join(app.folder, 'outside-get-swap'), displaced = join(app.folder, 'displaced-get');
  await mkdir(outside); await writeFile(join(outside, imageName(actorRef)), fixtureFiles[actorRef]);
  const original = fs.realpath; let checks = 0, swapped = false;
  fs.realpath = async (path, ...options) => {
    const value = await original(path, ...options);
    if (String(path) === imageFolder && ++checks === 2) {
      swapped = true; await rename(imageFolder, displaced); await symlink(outside, imageFolder, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return value;
  };
  syncBuiltinESMExports();
  let response;
  try { response = await fetch(`${app.base}/api/design/presets/swapped-get/images/${imageName(actorRef)}`); await response.arrayBuffer(); }
  finally { fs.realpath = original; syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.equal(response.status, 422);
  assert.deepEqual(await readFile(join(outside, imageName(actorRef))), fixtureFiles[actorRef]);
});

test('grapheme-bounded names, duplicate names and renaming affect the name only', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const family = '👨‍👩‍👧‍👦', maximum = family.repeat(40);
  const first = await app.newPreset(` ${maximum} `), second = await app.newPreset(maximum);
  assert.notEqual(first.id, second.id); assert.equal(first.design.name, maximum);
  assert.equal((await app.list()).presets.filter(value => value.name === maximum).length, 2);
  const renamed = await app.update(first, { name: '新しい名前 / <>& 🎨' });
  assert.deepEqual(renamed.design, { ...first.design, name: '新しい名前 / <>& 🎨' });
  assert.deepEqual(renamed.images, first.images);
  for (const name of ['', '   ', family.repeat(41), '改\n行', '制\u0085御']) {
    const response = await app.send('/api/design/presets', 'POST', { name, currentRevision: (await app.current()).revision });
    assert.equal(response.status, 400, JSON.stringify(name)); await response.arrayBuffer();
  }
});

test('refresh discovers manually placed scenes and reports broken designs and invalid images as unavailable', async t => {
  const app = await serve(t);
  const folder = await manualPreset(app.directory, 'manual-scene');
  const bad = [
    ['broken-json', '{broken', fixtureFiles],
    ['old-version', { ...fixtureDesign(), version: 1 }, fixtureFiles],
    ['broken-overlays', { ...fixtureDesign(), ratios: { ...fixtureDesign().ratios, '9:16': { layout: null, overlays: { version: 2, items: [], assets: {} } } } }, fixtureFiles],
    ['broken-theme', { ...fixtureDesign(), theme: 'a'.repeat(1000001) }, fixtureFiles],
    ['missing-image', fixtureDesign(), {}],
    ['svg-image', fixtureDesign(), { ...fixtureFiles, 'images/picture.svg': Buffer.from('<svg/>') }],
    ['fake-hash', fixtureDesign(), { ...fixtureFiles, [`images/${'0'.repeat(64)}.png`]: fixtureFiles[actorRef] }],
  ];
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1); fixtureFiles[actorRef].copy(huge);
  bad.push(['huge-image', fixtureDesign(), { ...fixtureFiles, [`images/${sha(huge)}.png`]: huge }]);
  const pixels = Buffer.from(fixtureFiles[actorRef]); pixels.writeUInt32BE(4001, 16); pixels.writeUInt32BE(4000, 20);
  bad.push(['huge-pixels', fixtureDesign(), { ...fixtureFiles, [`images/${sha(pixels)}.png`]: pixels }]);
  for (const [id, design, files] of bad) await manualPreset(app.directory, id, design, files);
  const invalidIds = process.platform === 'win32' ? [] : ['con'];
  for (const id of invalidIds) await manualPreset(app.directory, id);
  const listed = await app.list(), available = listed.presets.find(value => value.id === 'manual-scene');
  assert.equal(available.name, fixtureDesign().name); assert.ok(available.updatedAt); assert.ok(available.revision); assert.equal(available.error, undefined);
  assert.deepEqual((await app.getPreset('manual-scene')).design, fixtureDesign());
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'design.json'), 'utf8')), fixtureDesign());
  for (const id of [...bad.map(value => value[0]), ...invalidIds]) {
    const item = listed.presets.find(value => value.id === id);
    assert.ok(item.error, id); assert.equal(item.revision, null, id);
    const response = await fetch(`${app.base}/api/design/presets/${id}`);
    assert.ok([400, 422].includes(response.status), id); await response.arrayBuffer();
  }
});

test('preset mutations enforce origins, ids, JSON bodies and revisions', async t => {
  const app = await serve(t), before = await app.current(), preset = await app.newPreset('安全な保存');
  for (const [path, method, body] of [
    ['/api/design/presets', 'POST', { name: '禁止', currentRevision: before.revision }],
    [`/api/design/presets/${preset.id}`, 'PUT', { name: '禁止' }],
    [`/api/design/presets/${preset.id}`, 'DELETE', {}],
    ['/api/design/open-folder', 'POST', {}],
  ]) {
    for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'none' }]) {
      const response = await app.send(path, method, body, { 'If-Match': preset.revision, ...headers });
      assert.equal(response.status, 403, `${method}: ${JSON.stringify(headers)}`); await response.arrayBuffer();
    }
    const wrongType = await app.send(path, method, body, { 'If-Match': preset.revision, 'Content-Type': 'text/plain' });
    assert.equal(wrongType.status, 415); await wrongType.arrayBuffer();
    const invalidHost = await new Promise((resolve, reject) => {
      const req = request(app.base + path, { method, headers: { Host: 'other.example', Origin: 'http://other.example',
        'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'If-Match': preset.revision } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', reject); req.end(JSON.stringify(body));
    });
    assert.equal(invalidHost, 403, method);
  }
  for (const id of ['..%2Fcurrent', '..%5Ccurrent', 'x%00', 'con', 'UPPER', 'a'.repeat(65)]) {
    const read = await fetch(`${app.base}/api/design/presets/${id}`); assert.equal(read.status, 400, id); await read.arrayBuffer();
    const write = await app.send(`/api/design/presets/${id}`, 'PUT', { name: '禁止' }, { 'If-Match': preset.revision });
    assert.equal(write.status, 400, id); await write.arrayBuffer();
    const open = await app.send('/api/design/open-folder', 'POST', { id }); assert.equal(open.status, 400, id); await open.arrayBuffer();
  }
  const missing = await app.send(`/api/design/presets/${preset.id}`, 'PUT', { name: 'missing' }); assert.equal(missing.status, 428); await missing.arrayBuffer();
  const stale = await app.send(`/api/design/presets/${preset.id}`, 'DELETE', {}, { 'If-Match': 'stale' }); assert.equal(stale.status, 409); await stale.arrayBuffer();
  const currentChanged = await app.save({ ...defaultDesign(), name: '変更済み' });
  const oldCurrent = await app.send('/api/design/presets', 'POST', { name: '古い版', currentRevision: before.revision });
  assert.equal(oldCurrent.status, 409); await oldCurrent.arrayBuffer();
  const oldPreset = preset;
  const renamed = await app.update(preset, { name: '変更後' });
  const staleApply = await app.send('/api/design/current', 'PUT', { presetId: oldPreset.id, presetRevision: oldPreset.revision }, { 'If-Match': currentChanged.revision });
  assert.equal(staleApply.status, 409); await staleApply.arrayBuffer();
  assert.deepEqual(await app.current(), currentChanged);
  assert.equal((await app.getPreset(renamed.id)).design.name, '変更後');
});

test('failed replacement and a stopped swap retain the old preset and recover it on refresh', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const preset = await app.newPreset('元の保存'), target = join(app.directory, 'presets', preset.id);
  const staged = join(app.directory, 'presets', `.${preset.id}.stage-00000000-0000-0000-0000-000000000000`);
  const backup = join(app.directory, 'presets', `.${preset.id}.backup`);
  await mkdir(staged); await mkdir(join(staged, 'images')); await writeFile(join(staged, 'design.json'), '{broken');
  let renames = 0;
  await assert.rejects(replacePresetDirectory(target, staged, backup, { renameDirectory: async (from, to) => {
    if (++renames === 2) throw Object.assign(new Error('stopped'), { code: 'EIO' });
    await rename(from, to);
  } }), { code: 'EIO' });
  assert.deepEqual(JSON.parse(await readFile(join(target, 'design.json'), 'utf8')), preset.design);
  assert.deepEqual((await app.getPreset(preset.id)).design, preset.design);
  // Simulate termination after old -> backup, with incomplete staged data.
  await mkdir(staged); await mkdir(join(staged, 'images')); await writeFile(join(staged, 'design.json'), '{broken');
  await rename(target, backup);
  const refreshed = await app.list(); assert.ok(refreshed.presets.some(value => value.id === preset.id && !value.error));
  assert.deepEqual((await app.getPreset(preset.id)).design, preset.design);
  assert.deepEqual((await readdir(join(app.directory, 'presets'))).sort(), [preset.id]);
  for (const [ref, bytes] of Object.entries(fixtureFiles)) assert.deepEqual(await readFile(join(target, ref)), bytes);
});

// Regression: checking only the directory's own lstat before readdir lets a
// parent junction replacement redirect recursive deletion into another tree.
test('junction replacement during backup cleanup never deletes an outside file', async t => {
  const app = await serve(t), preset = await app.newPreset('交換前');
  const target = join(app.directory, 'presets', preset.id), backup = join(app.directory, 'presets', `.${preset.id}.backup`);
  const staged = join(app.directory, 'presets', `.${preset.id}.stage-00000000-0000-0000-0000-000000000000`);
  const displaced = join(app.folder, 'displaced-backup'), outside = join(app.folder, 'outside-backup');
  await mkdir(staged); await mkdir(join(staged, 'images')); await writeFile(join(staged, 'design.json'), JSON.stringify({ ...defaultDesign(), name: '交換後' }));
  await mkdir(outside); await writeFile(join(outside, 'sentinel.txt'), 'keep');
  const original = fs.readdir; let swapped = false;
  fs.readdir = async (path, ...options) => {
    if (String(path) === backup && !swapped) {
      swapped = true; await rename(backup, displaced); await symlink(outside, backup, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  try { await replacePresetDirectory(target, staged, backup); }
  finally { fs.readdir = original; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
  assert.equal(JSON.parse(await readFile(join(target, 'design.json'), 'utf8')).name, '交換後');
});

test('junction replacement during deleted image cleanup never deletes an outside image', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const preset = await app.newPreset('削除前'), outside = join(app.folder, 'outside-images'), displaced = join(app.folder, 'displaced-images');
  await mkdir(outside);
  const name = `${'0'.repeat(64)}.png`, outsideFile = join(outside, name), oldDate = past();
  await writeFile(outsideFile, 'keep'); await utimes(outsideFile, oldDate, oldDate);
  const original = fs.readdir; let swapped = false;
  fs.readdir = async (path, ...options) => {
    if (basename(String(path)) === 'images' && basename(dirname(String(path))).startsWith('.deleted-') && !swapped) {
      swapped = true; await rename(path, displaced); await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  let response;
  try { response = await app.send(`/api/design/presets/${preset.id}`, 'DELETE', {}, { 'If-Match': preset.revision }); await response.arrayBuffer(); }
  finally { fs.readdir = original; syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.ok([422, 503].includes(response.status));
  assert.equal(await readFile(outsideFile, 'utf8'), 'keep');
});

test('junction replacement after a copy directory check never writes an outside image', async t => {
  const app = await serve(t), outside = join(app.folder, 'outside-copy'), displaced = join(app.folder, 'displaced-copy');
  await manualPreset(app.directory, 'copy-source'); const preset = await app.getPreset('copy-source');
  await mkdir(outside); await writeFile(join(outside, 'sentinel.txt'), 'keep');
  const currentImages = join(app.directory, 'current', 'images'), original = fs.realpath;
  let checks = 0, swapped = false;
  fs.realpath = async (path, ...options) => {
    const result = await original(path, ...options);
    if (String(path) === currentImages && ++checks === 3) {
      swapped = true; await rename(path, displaced); await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  };
  syncBuiltinESMExports();
  let response;
  try { response = await app.send('/api/design/current', 'PUT', { presetId: preset.id, presetRevision: preset.revision }, { 'If-Match': 'default' }); await response.arrayBuffer(); }
  finally { fs.realpath = original; syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.ok([422, 503].includes(response.status));
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
});

test('junction replacement at the copy write boundary never writes bytes in the outside directory', async t => {
  const app = await serve(t), outside = join(app.folder, 'outside-write'), displaced = join(app.folder, 'displaced-write');
  await manualPreset(app.directory, 'write-source'); const preset = await app.getPreset('write-source');
  await mkdir(outside); await writeFile(join(outside, 'sentinel.txt'), 'keep');
  const currentImages = join(app.directory, 'current', 'images'), originalOpen = fs.open, originalWrite = fs.writeFile;
  let swapped = false;
  const swapBeforeWrite = async path => {
    if (!swapped && dirname(String(path)) === currentImages && String(path).endsWith('.tmp')) {
      swapped = true; await rename(currentImages, displaced); await symlink(outside, currentImages, process.platform === 'win32' ? 'junction' : 'dir');
    }
  };
  fs.writeFile = async (path, ...options) => { await swapBeforeWrite(path); return originalWrite(path, ...options); };
  fs.open = async (path, ...options) => {
    const handle = await originalOpen(path, ...options), write = handle.writeFile;
    handle.writeFile = async (...content) => { await swapBeforeWrite(path); return write.apply(handle, content); };
    return handle;
  };
  syncBuiltinESMExports();
  let response;
  try { response = await app.send('/api/design/current', 'PUT', { presetId: preset.id, presetRevision: preset.revision }, { 'If-Match': 'default' }); await response.arrayBuffer(); }
  finally { fs.open = originalOpen; fs.writeFile = originalWrite; syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.ok([422, 503].includes(response.status));
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
});

test('overlapping preset reads and overwrites never expose a missing or incomplete folder', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  let preset = await app.newPreset('並行確認'), stop = false;
  const statuses = [];
  const reader = (async () => { while (!stop) {
    const response = await fetch(`${app.base}/api/design/presets/${preset.id}`); statuses.push(response.status); await response.arrayBuffer();
  } })();
  try {
    for (let index = 0; index < 12; index++) {
      await app.save({ ...fixtureDesign(), studio: { ...fixtureDesign().studio, title: `改訂 ${index}` } });
      preset = await app.update(preset, { overwrite: true, currentRevision: (await app.current()).revision });
    }
  } finally { stop = true; await reader; }
  assert.ok(statuses.length > 0); assert.ok(statuses.every(status => status === 200), JSON.stringify(statuses));
  assert.equal(preset.design.studio.title, '改訂 11');
});

test('reset and overwrite give released images a full grace period and collect them afterwards', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  let preset = await app.newPreset('片付け確認');
  const currentImages = join(app.directory, 'current', 'images'), presetImages = join(app.directory, 'presets', preset.id, 'images');
  const oldDate = past();
  for (const ref of Object.keys(fixtureFiles)) { await utimes(join(currentImages, imageName(ref)), oldDate, oldDate); await utimes(join(presetImages, imageName(ref)), oldDate, oldDate); }
  await app.save(defaultDesign());
  assert.deepEqual((await readdir(currentImages)).sort(), Object.keys(fixtureFiles).map(imageName).sort(), 'reset gives previously used images a fresh grace period');
  preset = await app.update(preset, { overwrite: true, currentRevision: (await app.current()).revision });
  assert.equal(preset.design.studio.image, '');
  assert.deepEqual((await readdir(presetImages)).sort(), Object.keys(fixtureFiles).map(imageName).sort(), 'overwrite keeps released preset images');
  for (const ref of Object.keys(fixtureFiles)) { await utimes(join(currentImages, imageName(ref)), oldDate, oldDate); await utimes(join(presetImages, imageName(ref)), oldDate, oldDate); }
  await app.list();
  assert.deepEqual(await readdir(currentImages), []); assert.deepEqual(await readdir(presetImages), []);
});

test('deleting a preset removes its entire folder immediately and preserves current copies', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const preset = await app.newPreset('すぐ削除'), before = await app.current();
  await app.remove(preset);
  assert.deepEqual(await readdir(join(app.directory, 'presets')), [], 'no deleted folder remains immediately after deletion');
  assert.deepEqual(await app.current(), before);
  for (const [ref, bytes] of Object.entries(fixtureFiles)) assert.deepEqual(await readFile(join(app.directory, 'current', ref)), bytes);
});

test('refresh removes a partially deleted preset after an immediate removal failure without waiting for age', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const preset = await app.newPreset('削除再試行'), original = fs.unlink;
  let failed = false, response;
  fs.unlink = async (path, ...options) => {
    if (!failed && basename(String(path)) === imageName(actorRef) && basename(dirname(dirname(String(path)))).startsWith('.deleted-')) {
      failed = true; throw Object.assign(new Error('removal failed'), { code: 'EIO' });
    }
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  try { response = await app.send(`/api/design/presets/${preset.id}`, 'DELETE', {}, { 'If-Match': preset.revision }); await response.arrayBuffer(); }
  finally { fs.unlink = original; syncBuiltinESMExports(); }
  assert.equal(failed, true, 'deletion attempts to remove newly stored images immediately');
  assert.equal(response.status, 503);
  assert.ok((await readdir(join(app.directory, 'presets'))).some(name => name.startsWith('.deleted-')));
  assert.deepEqual((await app.list()).presets, []);
  assert.deepEqual(await readdir(join(app.directory, 'presets')), [], 'refresh retries removal even when images are recent');
});

test('applying a preset protects images released from current for a full grace period', async t => {
  const app = await serve(t), preset = await app.newPreset('標準のプリセット');
  await app.uploadFixture(); await app.save(fixtureDesign());
  const currentImages = join(app.directory, 'current', 'images'), oldDate = past();
  for (const ref of Object.keys(fixtureFiles)) await utimes(join(currentImages, imageName(ref)), oldDate, oldDate);
  await app.apply(preset);
  assert.deepEqual((await readdir(currentImages)).sort(), Object.keys(fixtureFiles).map(imageName).sort());
  for (const ref of Object.keys(fixtureFiles)) await utimes(join(currentImages, imageName(ref)), oldDate, oldDate);
  await app.save(defaultDesign());
  assert.deepEqual(await readdir(currentImages), []);
});

test('directory links and junctions are unavailable and cannot be written or opened', async t => {
  const app = await serve(t), outside = join(app.folder, 'outside');
  await mkdir(outside); await mkdir(join(outside, 'images')); await writeFile(join(outside, 'design.json'), JSON.stringify({ ...defaultDesign(), name: '外部' }));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, join(app.directory, 'presets', 'linked'), linkType);
  assert.match((await app.list()).presets.find(value => value.id === 'linked').error, /リンク|ジャンクション/);
  for (const [path, method, body] of [
    ['/api/design/presets/linked', 'PUT', { name: '禁止' }],
    ['/api/design/presets/linked', 'DELETE', {}],
    ['/api/design/open-folder', 'POST', { id: 'linked' }],
  ]) {
    const response = await app.send(path, method, body, { 'If-Match': 'invalid' }); assert.equal(response.status, 422); await response.arrayBuffer();
  }
  const presetFolder = await manualPreset(app.directory, 'linked-images', { ...defaultDesign(), name: '画像のリンク' }, {});
  await rm(join(presetFolder, 'images'), { recursive: true }); await symlink(join(outside, 'images'), join(presetFolder, 'images'), linkType);
  assert.ok((await app.list()).presets.find(value => value.id === 'linked-images').error);
  const privateFolder = join(app.directory, 'presets', '.user-folder'); await mkdir(privateFolder);
  await writeFile(join(privateFolder, 'keep.txt'), 'keep');
  for (const name of ['.safe.backup', '.safe.stage-00000000-0000-0000-0000-000000000000', '.deleted-00000000-0000-0000-0000-000000000000']) {
    const hidden = join(app.directory, 'presets', name); await symlink(outside, hidden, linkType);
    const rejected = await fetch(`${app.base}/api/design/presets`); assert.ok([422, 503].includes(rejected.status), name); await rejected.arrayBuffer();
    assert.equal(await readFile(join(privateFolder, 'keep.txt'), 'utf8'), 'keep');
    assert.equal((await readdir(outside)).includes('design.json'), true);
    await rm(hidden, { recursive: true });
  }
  await rm(join(app.directory, 'presets'), { recursive: true }); await symlink(outside, join(app.directory, 'presets'), linkType);
  const response = await fetch(`${app.base}/api/design/presets`); assert.equal(response.status, 503); await response.arrayBuffer();
  assert.deepEqual(JSON.parse(await readFile(join(outside, 'design.json'), 'utf8')), { ...defaultDesign(), name: '外部' });
});

test('file symlinks and forged image names are never served from presets', async t => {
  const app = await serve(t), outside = join(app.folder, 'outside.png');
  await writeFile(outside, fixtureFiles[actorRef]);
  const folder = await manualPreset(app.directory, 'linked-file');
  await rm(join(folder, actorRef));
  try { await symlink(outside, join(folder, actorRef)); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('file symlinks need privileges on Windows'); return; }
    throw error;
  }
  assert.ok((await app.list()).presets.find(value => value.id === 'linked-file').error);
  const response = await fetch(`${app.base}/api/design/presets/linked-file/images/${imageName(actorRef)}`);
  assert.equal(response.status, 422); await response.arrayBuffer();
  const forged = await fetch(`${app.base}/api/design/presets/linked-file/images/${imageName(backgroundRef).replace('.png', '.svg')}`);
  assert.equal(forged.status, 404); await forged.arrayBuffer();
});

test('applying a preset notifies an already open SSE subscriber with the saved current revision', async t => {
  const app = await serve(t); await app.uploadFixture(); await app.save(fixtureDesign());
  const preset = await app.newPreset('配信出力追従'); await app.save(defaultDesign());
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${app.base}/api/design/events`, { signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let received = '';
  const applied = await app.apply(preset);
  while (!received.includes(applied.revision)) received += decoder.decode((await reader.read()).value);
  assert.match(received, /event: change/); assert.deepEqual(applied.design, preset.design);
  controller.abort();
});

test('folder opening uses server-built paths and a shell-free Windows dispatch', async t => {
  const app = await serve(t), preset = await app.newPreset('場所の確認');
  const launches = [], original = childProcess.spawn;
  if (process.platform === 'win32') {
    childProcess.spawn = (command, args, options) => {
      const child = new EventEmitter(); child.unref = () => { child.unreferenced = true; };
      launches.push({ command, args, options, child }); queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    syncBuiltinESMExports();
    t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  }
  const root = await app.json(await app.send('/api/design/open-folder', 'POST', {}));
  assert.deepEqual(root, { directory: join(app.directory, 'presets'), opened: process.platform === 'win32' });
  const selected = await app.json(await app.send('/api/design/open-folder', 'POST', { id: preset.id }));
  assert.deepEqual(selected, { directory: join(app.directory, 'presets', preset.id), opened: process.platform === 'win32' });
  if (process.platform === 'win32') {
    assert.deepEqual(launches.map(({ command, args, options, child }) => ({ command, args, options, unreferenced: child.unreferenced })), [root, selected].map(value => ({
      command: 'explorer.exe', args: [value.directory], options: { shell: false, windowsHide: true, stdio: 'ignore' }, unreferenced: true,
    })));
    childProcess.spawn = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('unavailable'))); return child; };
    syncBuiltinESMExports();
    const failed = await app.send('/api/design/open-folder', 'POST', {});
    assert.equal(failed.status, 503); await failed.arrayBuffer();
  }
});
