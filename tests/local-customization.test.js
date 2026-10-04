import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { DEFAULT_CUSTOMIZATION_DIRECTORY, MAX_CUSTOM_CSS_BYTES, MAX_CUSTOM_IMAGE_BYTES, ensureCustomizationDirectories } from '../src/server/local-customization.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
// Real 1×1 RGB JPEG, generated with Pillow; no image-library dependency is needed to run these tests.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

async function serve(t, setup = async () => {}) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-customization-'));
  const directory = join(folder, 'customization');
  await setup({ folder, directory });
  const server = createServer({ customizationDirectory: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, directory, folder, list: () => fetch(`${base}/api/customizations`), file: (kind, name, options) => fetch(`${base}/api/customizations/${kind}/${encodeURIComponent(name)}`, options) };
}

test('customization folders are app-adjacent, created automatically, and empty by default', async t => {
  assert.equal(DEFAULT_CUSTOMIZATION_DIRECTORY, join(dirname(fileURLToPath(new URL('../server.js', import.meta.url))), 'customization'));
  const { directory, list } = await serve(t);
  const response = await list();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(await response.json(), { directory, styles: [], images: [], skipped: 0 });
  assert.deepEqual((await readdir(directory)).sort(), ['images', 'styles']);
});

test('lists and serves only supported flat CSS and image files, including encoded Unicode filenames', async t => {
  const { directory, list, file } = await serve(t);
  await list();
  const css = '.pokome-workspace { --accent: #123456; }';
  await writeFile(join(directory, 'styles', '夕空 #1%.CSS'), css);
  await writeFile(join(directory, 'images', 'background.png'), png);
  await writeFile(join(directory, 'images', 'actor.gif'), gif);
  await writeFile(join(directory, 'images', 'texture.webp'), webp);
  const data = await (await list()).json();
  assert.deepEqual(data.styles, [{ name: '夕空 #1%.CSS', size: Buffer.byteLength(css) }]);
  assert.deepEqual(data.images.map(entry => entry.name), ['actor.gif', 'background.png', 'texture.webp']);
  assert.equal(data.skipped, 0);
  const style = await file('styles', '夕空 #1%.CSS');
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /^text\/css/);
  assert.equal(await style.text(), css);
  for (const [name, content, type] of [['background.png', png, 'image/png'], ['actor.gif', gif, 'image/gif'], ['texture.webp', webp, 'image/webp']]) {
    const response = await file('images', name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  }
});

test('lists and serves JPEGs with padding or trailing data after the end marker', async t => {
  const { directory, list, file } = await serve(t);
  await list();
  const images = [
    ['plain.jpg', jpeg],
    ['padded.JPG', Buffer.concat([jpeg, Buffer.alloc(16)])],
    ['trailing.jpeg', Buffer.concat([jpeg, Buffer.from('appended metadata')])],
    ['boundary.jpeg', Buffer.concat([jpeg, Buffer.alloc(MAX_CUSTOM_IMAGE_BYTES - jpeg.length)])],
  ];
  assert.deepEqual(jpeg.subarray(-2), Buffer.from([0xff, 0xd9]));
  for (const [name, content] of images) await writeFile(join(directory, 'images', name), content);
  const data = await (await list()).json();
  assert.deepEqual(data.images, images.map(([name, content]) => ({ name, size: content.length })).sort((a, b) => a.name.localeCompare(b.name, 'ja')));
  assert.equal(data.skipped, 0);
  for (const [name, content] of images) {
    const response = await file('images', name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'image/jpeg', name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', name);
    assert.equal(response.headers.get('cache-control'), 'no-store', name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content, name);
  }
});

test('rejects invalid JPEG signatures, mismatched extensions, and oversized padded JPEGs', async t => {
  const { directory, list, file } = await serve(t);
  await list();
  const invalidImages = [
    ['wrong-first-byte.jpg', Buffer.concat([Buffer.from([0x00]), jpeg.subarray(1)])],
    ['wrong-second-byte.jpeg', Buffer.concat([Buffer.from([0xff, 0x00]), jpeg.subarray(2)])],
    ['wrong-third-byte.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0x00]), jpeg.subarray(3)])],
    ['short.jpg', jpeg.subarray(0, 2)],
    ['disguised-png.jpg', png],
    ['disguised-jpeg.png', jpeg],
    ['oversized.jpeg', Buffer.concat([jpeg, Buffer.alloc(MAX_CUSTOM_IMAGE_BYTES - jpeg.length + 1)])],
  ];
  for (const [name, content] of invalidImages) await writeFile(join(directory, 'images', name), content);
  const data = await (await list()).json();
  assert.deepEqual(data.images, []);
  assert.equal(data.skipped, invalidImages.length);
  for (const [name] of invalidImages) {
    const response = await file('images', name);
    assert.equal(response.status, 422, name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name);
  }
});

test('skips hidden, nested, unsupported, invalid, mismatched, and oversized files', async t => {
  const { directory, list, file } = await serve(t);
  await list();
  const styles = join(directory, 'styles');
  const images = join(directory, 'images');
  await writeFile(join(styles, '.private.css'), 'secret');
  await writeFile(join(styles, 'secret.txt'), 'secret');
  await writeFile(join(styles, 'script.js'), 'throw new Error("do not run")');
  await writeFile(join(styles, 'invalid.css'), Buffer.from([0xff, 0xfe, 0x01]));
  await writeFile(join(styles, 'embedded-nul.css'), Buffer.from([0]));
  await writeFile(join(styles, 'large.css'), Buffer.alloc(MAX_CUSTOM_CSS_BYTES + 1, 32));
  await mkdir(join(styles, 'nested'));
  await writeFile(join(styles, 'nested', 'hidden.css'), 'secret');
  await writeFile(join(images, 'external.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(images, 'fake.png'), 'this is not a PNG');
  await writeFile(join(images, 'wrong.jpeg'), png);
  await writeFile(join(images, 'large.png'), Buffer.concat([png, Buffer.alloc(MAX_CUSTOM_IMAGE_BYTES)]));
  const data = await (await list()).json();
  assert.deepEqual(data.styles, []);
  assert.deepEqual(data.images, []);
  assert.equal(data.skipped, 11);
  for (const name of ['.private.css', 'secret.txt', 'script.js', '../style.css', '..\\style.css', 'C:secret.css', 'NUL.css', 'COM¹.css']) assert.equal((await file('styles', name)).status, 400, name);
  for (const name of ['invalid.css', 'embedded-nul.css', 'large.css']) assert.equal((await file('styles', name)).status, 422, name);
  for (const name of ['fake.png', 'wrong.jpeg', 'large.png']) assert.equal((await file('images', name)).status, 422, name);
});

test('exact byte limits are accepted and reads immediately reflect edits and deletion', async t => {
  const { directory, list, file } = await serve(t);
  await list();
  const cssPath = join(directory, 'styles', 'boundary.css');
  const css = 'あ'.repeat(Math.floor(MAX_CUSTOM_CSS_BYTES / 3)) + ' ';
  assert.equal(Buffer.byteLength(css), MAX_CUSTOM_CSS_BYTES);
  await writeFile(cssPath, css);
  const paddedImage = Buffer.alloc(MAX_CUSTOM_IMAGE_BYTES);
  png.copy(paddedImage);
  await writeFile(join(directory, 'images', 'boundary.png'), paddedImage);
  assert.equal((await file('styles', 'boundary.css')).status, 200);
  assert.equal((await file('images', 'boundary.png')).status, 200);
  await writeFile(cssPath, '.pokome-workspace { color: red; }');
  assert.equal(await (await file('styles', 'boundary.css')).text(), '.pokome-workspace { color: red; }');
  await unlink(cssPath);
  const removed = await file('styles', 'boundary.css');
  assert.equal(removed.status, 404);
  assert.match((await removed.json()).error, /一覧を更新/);
});

test('symlinked files, folders and customization roots never expose outside files', async t => {
  const { directory, folder, list, file } = await serve(t);
  await list();
  const outside = join(folder, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.css'), 'private-content');
  try { await symlink(join(outside, 'private.css'), join(directory, 'styles', 'linked.css')); } catch (error) {
    if (error.code === 'EPERM') { t.skip('This Windows account cannot create symbolic links'); return; }
    throw error;
  }
  assert.equal((await (await list()).json()).skipped, 1);
  assert.equal((await file('styles', 'linked.css')).status, 422);
  await rm(join(directory, 'styles'), { recursive: true });
  await symlink(outside, join(directory, 'styles'), 'dir');
  assert.equal((await list()).status, 503);
  assert.equal((await file('styles', 'private.css')).status, 503);
  await rm(directory, { recursive: true });
  await symlink(outside, directory, 'dir');
  assert.equal((await list()).status, 503);
  assert.deepEqual(await readdir(outside), ['private.css']);
  assert.equal(await readFile(join(outside, 'private.css'), 'utf8'), 'private-content');
});

test('existing linked directories are rejected before initialization can create folders through them', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-customization-links-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const outside = join(folder, 'outside');
  await mkdir(outside);
  try { await symlink(outside, join(folder, 'customization'), 'dir'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('This Windows account cannot create symbolic links'); return; }
    throw error;
  }
  await assert.rejects(ensureCustomizationDirectories(join(folder, 'customization')));
  assert.deepEqual(await readdir(outside), []);
});

test('all customization routes enforce local Host, same origin, and read-only methods', async t => {
  const { base, list } = await serve(t);
  const paths = ['/api/customizations', '/api/customizations/styles/example.css', '/api/customizations/images/example.png'];
  for (const path of paths) {
    for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.ok(!Object.hasOwn(await response.json(), 'directory'));
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = request(base + path, { headers: { Host: 'attacker.example' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(hostileHostStatus, 403);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET');
    }
  }
  assert.equal((await fetch(`${base}/api/customizations`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await list()).status, 200);
});

test('unknown routes, malformed names, and direct static accesses do not expose local files', async t => {
  const { base } = await serve(t);
  for (const path of ['/src/server/local-customization.js', '/server.js', '/src/server/asset-manifest.js', '/package.json', '/.env', '/customization/styles/private.css', '/api/customizations/other/private.css', '/api/customizations/styles/nested/private.css', '/api/customizations/styles/']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/api/customizations/styles/%E0%A4%A.css')).status, 400);
  assert.equal((await fetch(base + '/api/customizations/styles/missing.css')).status, 404);
  assert.equal((await fetch(base + '/src/browser/customization.js')).status, 200);
});
