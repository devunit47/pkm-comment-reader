import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_ASSETS, LOCAL_FILES } from '../asset-manifest.js';
import { buildLocal, stageLocalFiles } from '../build-local.js';

async function output(t) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-local-build-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return { folder, destination: pathToFileURL(folder + '/') };
}

test('local asset staging packages the backend and empty user folders without copying user files', async t => {
  const { folder, destination } = await output(t);
  await stageLocalFiles(destination);
  assert.deepEqual((await readdir(folder)).sort(), [...LOCAL_FILES, 'customization'].sort());
  assert.deepEqual((await readdir(join(folder, 'customization'))).sort(), ['images', 'styles']);
  assert.deepEqual(await readdir(join(folder, 'customization', 'images')), []);
  assert.deepEqual(await readdir(join(folder, 'customization', 'styles')), []);
  assert.ok(LOCAL_FILES.includes('local-customization.js'));
  assert.ok(BROWSER_ASSETS.includes('customization.js'));
  assert.ok(!BROWSER_ASSETS.includes('local-customization.js'));
  assert.ok(LOCAL_FILES.every(file => !file.startsWith('customization/')));
  const config = await readFile(join(folder, 'app-config.js'), 'utf8');
  assert.match(config, /enabledPlatforms = Object\.freeze\(\['twitch'\]\)/);
  assert.doesNotMatch(config, /kick/);
  const html = await readFile(join(folder, 'index.html'), 'utf8');
  assert.equal((html.match(/data-service="kick" hidden/g) || []).length, 3);
  for (const file of ['style.css', 'theme.js', 'studio.js', 'speech-background.svg']) assert.deepEqual(await readFile(new URL('../' + file, import.meta.url)), await readFile(join(folder, file)), file);
});

test('rebuilding preserves the destination customization directory, including unsupported user files', async t => {
  const { folder, destination } = await output(t);
  await stageLocalFiles(destination);
  await writeFile(join(folder, 'customization', 'styles', 'my-design.css'), '.pokome-workspace { color: red; }');
  await writeFile(join(folder, 'customization', 'images', 'notes.txt'), 'Keep my original notes');
  await writeFile(join(folder, 'customization', 'README.txt'), 'My folder notes');
  await stageLocalFiles(destination);
  assert.equal(await readFile(join(folder, 'customization', 'styles', 'my-design.css'), 'utf8'), '.pokome-workspace { color: red; }');
  assert.equal(await readFile(join(folder, 'customization', 'images', 'notes.txt'), 'utf8'), 'Keep my original notes');
  assert.equal(await readFile(join(folder, 'customization', 'README.txt'), 'utf8'), 'My folder notes');
});

test('staging rejects an unexpected output or symlinked customization root', async t => {
  const { folder, destination } = await output(t);
  await writeFile(join(folder, 'private.env'), 'Keep private');
  await assert.rejects(stageLocalFiles(destination), /空の出力先/);
  await rm(join(folder, 'private.env'));
  const outside = await mkdtemp(join(tmpdir(), 'pokome-local-build-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try { await symlink(outside, join(folder, 'customization'), 'dir'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('This Windows account cannot create symbolic links'); return; }
    throw error;
  }
  await assert.rejects(stageLocalFiles(destination));
  assert.deepEqual(await readdir(outside), []);
});

test('packaging still requires Windows while shared staging remains portable', { skip: process.platform === 'win32' }, async t => {
  const { folder, destination } = await output(t);
  await assert.rejects(buildLocal(destination), /Windows/);
  assert.deepEqual(await readdir(folder), []);
});

test('JavaScript checking excludes customization source files', async () => {
  const checker = await readFile(new URL('../check-js.js', import.meta.url), 'utf8');
  assert.match(checker, /'customization'/);
  const ignored = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignored, /^customization\/$/m);
});
