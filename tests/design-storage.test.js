import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { MAX_IMAGE_BYTES, defaultDesign } from '../src/shared/design-model.js';
import { UNREFERENCED_IMAGE_GRACE_MS, inspectImageBytes } from '../src/server/design-storage.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sizedPNG = (width, height, length = png.length) => {
  const bytes = Buffer.alloc(length); png.copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
};

async function serve(t) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-design-'));
  const directory = join(folder, 'customization');
  const server = createServer({ customizationDirectory: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = base;
  const write = (path, body, type, headers = {}) => fetch(base + path, { method: 'PUT', body, headers: { 'Content-Type': type, Origin: origin, ...headers } });
  const current = async () => (await fetch(`${base}/api/design/current`)).json();
  const upload = async (bytes, type = 'image/png') => (await write('/api/design/images', bytes, type)).json();
  const save = async (design, revision) => write('/api/design/current', JSON.stringify(design), 'application/json', { 'If-Match': revision });
  return { base, directory, folder, write, current, upload, save };
}

test('a fresh folder serves the default design and creates current/images without any file', async t => {
  const { base, directory, current } = await serve(t);
  const response = await fetch(`${base}/api/design/current`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const value = await current();
  assert.deepEqual(value.design, defaultDesign());
  assert.equal(value.revision, 'default');
  assert.deepEqual(value.images, {});
  assert.deepEqual(await readdir(join(directory, 'current')), ['images']);
});

test('saving stores a normalized design.json, keeps referenced images and reports the new revision', async t => {
  const { directory, current, upload, save } = await serve(t);
  const image = await upload(png);
  assert.deepEqual(image, { ref: `images/${sha(png)}.png`, type: 'image/png', bytes: png.length, width: 1, height: 1 });
  const design = { ...defaultDesign(), name: 'x', theme: '.pokome-workspace{}', studio: { ...defaultDesign().studio, image: image.ref, title: '保存' },
    ratios: { ...defaultDesign().ratios, '16:9': { layout: null, overlays: { version: 1, items: [{ id: 'item-1', type: 'image', assetId: 'asset-1' }], assets: { 'asset-1': image.ref } } } },
    extra: 'dropped' };
  const response = await save(design, 'default');
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.notEqual(saved.revision, 'default');
  assert.equal(saved.design.studio.image, image.ref);
  assert.equal(saved.design.ratios['16:9'].overlays.assets['asset-1'], image.ref);
  const file = JSON.parse(await readFile(join(directory, 'current', 'design.json'), 'utf8'));
  assert.equal(Object.hasOwn(file, 'extra'), false);
  assert.equal(file.studio.title, '保存');
  assert.deepEqual(await current(), { design: saved.design, images: saved.images, revision: saved.revision });
  // Only temporary-free, final files remain.
  assert.deepEqual((await readdir(join(directory, 'current'))).sort(), ['design.json', 'images']);
});

test('a stale or missing revision is rejected so another tab cannot be overwritten', async t => {
  const { save, write } = await serve(t);
  const first = await (await save(defaultDesign(), 'default')).json();
  const stale = await save({ ...defaultDesign(), name: 'late' }, 'default');
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).revision, first.revision);
  const missing = await write('/api/design/current', JSON.stringify(defaultDesign()), 'application/json');
  assert.equal(missing.status, 428);
  assert.equal((await save({ ...defaultDesign(), name: 'next' }, first.revision)).status, 200);
});

test('writes require this app as origin, a JSON or image type and bounded bodies', async t => {
  const { base, write } = await serve(t);
  const body = JSON.stringify(defaultDesign());
  for (const headers of [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${base}/api/design/current`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json', 'If-Match': 'default', Origin: base, ...headers } });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  const noOrigin = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/design/current`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': 'default' } }, resolve);
    req.on('error', reject); req.end(body);
  });
  assert.equal(noOrigin.statusCode, 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    assert.equal((await write('/api/design/current', body, type, { 'If-Match': 'default' })).status, 415, type);
    assert.equal((await write('/api/design/images', png, type)).status, 415, type);
  }
  assert.equal((await write('/api/design/images', png, 'image/svg+xml')).status, 415);
  assert.equal((await write('/api/design/current', '{broken', 'application/json', { 'If-Match': 'default' })).status, 400);
  assert.equal((await write('/api/design/current', JSON.stringify({ format: 'other' }), 'application/json', { 'If-Match': 'default' })).status, 400);
  assert.equal((await fetch(`${base}/api/design/current`, { method: 'DELETE', headers: { Origin: base } })).status, 405);
  assert.equal((await fetch(`${base}/api/design/current`, { headers: { Origin: 'http://evil.example' } })).status, 403);
  // Bodies over the limit stop with 413 before being stored.
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1); png.copy(huge);
  assert.equal((await write('/api/design/images', huge, 'image/png')).status, 413);
});

test('uploaded images are checked by signature, declared type and pixels; exactly 20MB is accepted', async t => {
  const { write, upload } = await serve(t);
  assert.equal((await write('/api/design/images', gif, 'image/png')).status, 422, 'a GIF sent as PNG');
  assert.equal((await write('/api/design/images', Buffer.from('<svg/>'), 'image/png')).status, 422);
  assert.equal((await write('/api/design/images', sizedPNG(4001, 4000), 'image/png')).status, 422);
  assert.equal((await upload(sizedPNG(4000, 4000))).width, 4000);
  const exact = sizedPNG(1, 1, MAX_IMAGE_BYTES);
  const accepted = await upload(exact);
  assert.equal(accepted.bytes, MAX_IMAGE_BYTES);
  assert.equal(inspectImageBytes(sizedPNG(1, 1, MAX_IMAGE_BYTES + 1), 'png'), null);
  // The same bytes are stored once.
  assert.equal((await upload(png)).ref, (await upload(png)).ref);
});

test('images are served only by validated hash names with their type and immutable caching', async t => {
  const { base, directory, upload } = await serve(t);
  const image = await upload(png);
  const name = image.ref.slice('images/'.length);
  const response = await fetch(`${base}/api/design/current/images/${name}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  // A file whose content does not match its hash name is never served or listed.
  const forged = `${'0'.repeat(64)}.png`;
  await writeFile(join(directory, 'current', 'images', forged), png);
  assert.equal((await fetch(`${base}/api/design/current/images/${forged}`)).status, 404);
  assert.equal(Object.hasOwn((await (await fetch(`${base}/api/design/current`)).json()).images, `images/${forged}`), false);
  for (const path of ['..%2Fdesign.json', '..%5Cdesign.json', `${name.slice(0, -4)}.svg`, 'x.png', `${name}%00`]) {
    assert.equal((await fetch(`${base}/api/design/current/images/${path}`)).status, 404, path);
  }
});

test('symlinked design folders and images are refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const { base, directory } = await serve(t);
  const outside = await mkdtemp(join(tmpdir(), 'pokome-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await fetch(`${base}/api/design/current`);
  const name = `${sha(png)}.png`;
  await writeFile(join(outside, name), png);
  await symlink(join(outside, name), join(directory, 'current', 'images', name));
  assert.equal((await fetch(`${base}/api/design/current/images/${name}`)).status, 404);
  await rm(join(directory, 'current'), { recursive: true });
  await mkdir(join(outside, 'current'));
  await symlink(join(outside, 'current'), join(directory, 'current'), 'dir');
  assert.equal((await fetch(`${base}/api/design/current`)).status, 503);
});

test('unreferenced images are removed only after the grace period', async t => {
  const { directory, upload, save } = await serve(t);
  const used = await upload(png), fresh = await upload(gif, 'image/gif');
  const old = await upload(sizedPNG(2, 2));
  const imageFolder = join(directory, 'current', 'images');
  const past = new Date(Date.now() - UNREFERENCED_IMAGE_GRACE_MS - 60000);
  await utimes(join(imageFolder, old.ref.slice(7)), past, past);
  await utimes(join(imageFolder, used.ref.slice(7)), past, past);
  await save({ ...defaultDesign(), studio: { ...defaultDesign().studio, image: used.ref } }, 'default');
  const remaining = await readdir(imageFolder);
  assert.ok(remaining.includes(used.ref.slice(7)), 'referenced');
  assert.ok(remaining.includes(fresh.ref.slice(7)), 'recent drafts survive');
  assert.ok(!remaining.includes(old.ref.slice(7)), 'old unreferenced images are removed');
});

test('saves notify open event streams, and closing the server ends them', async t => {
  const { base, save } = await serve(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/design/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const saved = await (await save(defaultDesign(), 'default')).json();
  while (!text.includes(saved.revision)) text += decoder.decode((await reader.read()).value);
  assert.match(text, /event: change/);
});

test('a broken design.json falls back to the default with a warning instead of failing', async t => {
  const { base, directory } = await serve(t);
  await fetch(`${base}/api/design/current`);
  await writeFile(join(directory, 'current', 'design.json'), '{"format":"pokome-design","version":1}');
  const value = await (await fetch(`${base}/api/design/current`)).json();
  assert.deepEqual(value.design, defaultDesign());
  assert.match(value.warning, /標準/);
  assert.notEqual(value.revision, 'default');
});

// Regression: on Windows a concurrent read made the replacing rename fail with
// EPERM, the save returned 503 and the edit was lost.
test('replacing design.json retries transient Windows sharing errors but not real failures', async () => {
  const { renameWithRetry } = await import('../src/server/design-storage.js');
  const calls = [];
  const flaky = failures => async (from, to) => {
    calls.push([from, to]);
    if (calls.length <= failures.length) throw Object.assign(new Error('busy'), { code: failures[calls.length - 1] });
  };
  await renameWithRetry('a', 'b', { renameFile: flaky(['EPERM', 'EBUSY', 'EACCES']), delay: async () => {} });
  assert.equal(calls.length, 4);
  calls.length = 0;
  await assert.rejects(renameWithRetry('a', 'b', { renameFile: flaky(['ENOENT']), delay: async () => {} }), { code: 'ENOENT' });
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(renameWithRetry('a', 'b', { renameFile: flaky(Array(5).fill('EPERM')), attempts: 3, delay: async () => {} }), { code: 'EPERM' });
  assert.equal(calls.length, 3);
});

test('saves and reads both stay successful while they overlap', async t => {
  const { base, current, save } = await serve(t);
  let revision = (await current()).revision, stop = false;
  const failedReads = [];
  const readers = Array.from({ length: 4 }, async () => { while (!stop) { const response = await fetch(`${base}/api/design/current`); if (response.status !== 200) failedReads.push(response.status); await response.arrayBuffer(); } });
  try {
    for (let index = 0; index < 30; index++) {
      const response = await save({ ...defaultDesign(), name: `n${index}` }, revision);
      assert.equal(response.status, 200, `save ${index}`);
      revision = (await response.json()).revision;
    }
  } finally { stop = true; await Promise.all(readers); }
  assert.deepEqual(failedReads, [], 'reads never fail while saves replace the file');
});
