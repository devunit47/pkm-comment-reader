import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.js';
import { buildPages } from '../build-pages.js';
import { createPreviewServer } from '../preview-pages.js';
import { DEFAULT_STUDIO } from '../studio.js';
import { chromium, executablePath, browserAvailable } from './browser-support.js';

const cssOne = '.pokome-workspace .pokome-panel { border-radius: 7px; }';
const cssTwo = '.pokome-workspace .pokome-panel { border-radius: 11px; }';
const hidingCSS = '.pokome-workspace { display: none !important; }';
const qaDirectory = process.env.CUSTOMIZATION_QA_DIRECTORY;

// Small, valid, distinct PNGs, made entirely in memory without new dependencies.
function png(red, green, blue) {
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rows.set([red, green, blue, 255], y * 65 + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const redPNG = png(229, 80, 98), bluePNG = png(70, 100, 220);
const paddedJPEG = Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z', 'base64'), Buffer.from('\0\0trailing metadata')]);
const redURL = `data:image/png;base64,${redPNG.toString('base64')}`;
const blueURL = `data:image/png;base64,${bluePNG.toString('base64')}`;

async function fixture(t, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-customization-browser-'));
  await mkdir(join(directory, 'styles')); await mkdir(join(directory, 'images'));
  for (const [file, data] of Object.entries(files)) await writeFile(join(directory, file), data);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function openBrowser(t, url, initialStorage = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(values => {
    if (!sessionStorage.getItem('customization-test-initialized')) {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('customization-test-initialized', 'true');
    }
  }, initialStorage);
  await page.goto(url);
  await page.locator('#appearance-recovery #open-reset').waitFor();
  return { page, errors, requests };
}

async function studio(page, local = true) {
  await page.locator('[data-page="studio"]').click();
  if (local) await page.waitForFunction(() => !document.querySelector('#customization-status').textContent.includes('一覧を取得しています'));
}
const savedStudio = page => page.evaluate(() => JSON.parse(localStorage.getItem('pokome-studio') || '{}'));
const currentCSS = page => page.locator('#pokome-user-theme').textContent();
async function applyCSS(page, name, expected = name) {
  await page.locator('#customization-style').selectOption(name);
  await page.locator('#apply-customization-style').click();
  await page.waitForFunction(value => document.querySelector('#customization-status').textContent.includes(value), expected);
}
async function applyImage(page, name, target = 'image', expected = name) {
  await page.locator('#customization-image').selectOption(name);
  await page.locator('#customization-image-target').selectOption(target);
  await page.locator('#apply-customization-image').click();
  await page.waitForFunction(value => document.querySelector('#customization-status').textContent.includes(value), expected);
}
async function resetAppearance(page, confirm = true) {
  const recovery = page.locator('#appearance-recovery');
  await recovery.locator('#open-reset').click();
  assert.equal(await recovery.locator('dialog').evaluate(dialog => dialog.matches(':modal')), true);
  await recovery.locator(confirm ? '#confirm-reset' : '#cancel-reset').click();
  assert.equal(await recovery.locator('dialog').isVisible(), false);
}
async function screenshot(page, name) {
  if (!qaDirectory) return;
  await mkdir(qaDirectory, { recursive: true });
  await page.screenshot({ path: join(qaDirectory, name + '.png'), fullPage: true });
}
async function holdResponse(page, pattern, response) {
  let release, signalStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  await page.route(pattern, async route => { signalStarted(); await gate; await route.fulfill(response); }, { times: 1 });
  return {
    started,
    async finish() {
      const received = page.waitForResponse(pattern);
      release(); await (await received).finished();
      // Fetch text/blob and image decoding complete in subsequent browser tasks.
      await page.waitForTimeout(100);
    },
  };
}

test('local picker applies CSS and both image targets, rejects invalid files and persists copies after deletion', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t, {
    'styles/first.css': cssOne, 'styles/invalid.css': 'body { display: none; }',
    'styles/broken.css': 'this is not CSS', 'images/actor.png': redPNG,
    'images/background.png': bluePNG, 'images/broken.png': redPNG.subarray(0, 33), 'images/padded.jpg': paddedJPEG,
    'images/ignored.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const base = await serve(t, createServer({ customizationDirectory: directory }));
  const { page, errors } = await openBrowser(t, base);
  await studio(page);
  assert.equal(await page.locator('#customization-directory').textContent(), directory);
  assert.deepEqual(await page.locator('#customization-style option').evaluateAll(options => options.map(option => option.value)), ['', 'broken.css', 'first.css', 'invalid.css']);
  assert.equal(await page.locator('#customization-image option[value="ignored.svg"]').count(), 0);
  assert.equal(await page.locator('#apply-customization-style').isDisabled(), true);
  await applyCSS(page, 'first.css');
  assert.match(await currentCSS(page), /border-radius: 7px/);
  await applyImage(page, 'padded.jpg');
  assert.equal((await savedStudio(page)).image, `data:image/jpeg;base64,${paddedJPEG.toString('base64')}`);
  assert.equal(await page.locator('#actor-image').evaluate(image => image.complete && image.naturalWidth), 1);
  await applyImage(page, 'actor.png'); await applyImage(page, 'background.png', 'speechImage');
  assert.equal((await savedStudio(page)).image, redURL);
  assert.equal((await savedStudio(page)).speechImage, blueURL);
  assert.equal(await page.locator('#actor-image').getAttribute('src'), redURL);
  assert.match(await page.locator('#talk-stage').getAttribute('style'), /data:image\/png;base64/);
  const goodCSS = await currentCSS(page), goodStudio = await savedStudio(page);
  await applyCSS(page, 'invalid.css', '適用できません');
  assert.equal(await currentCSS(page), goodCSS);
  await applyCSS(page, 'broken.css', '適用できません');
  assert.equal(await currentCSS(page), goodCSS);
  await applyImage(page, 'broken.png', 'image', '適用できません');
  assert.deepEqual(await savedStudio(page), goodStudio);

  // The choice remains listed until refreshed; a vanished file has a useful error.
  await page.locator('#customization-style').selectOption('first.css');
  await rm(join(directory, 'styles/first.css'));
  await page.locator('#apply-customization-style').click();
  await page.waitForFunction(() => document.querySelector('#customization-status').textContent.includes('見つかりません'));
  assert.equal(await currentCSS(page), goodCSS);
  await page.locator('#refresh-customizations').click();
  await page.waitForFunction(() => !document.querySelector('#customization-style option[value="first.css"]'));
  assert.equal(await page.locator('#apply-customization-style').isDisabled(), true);
  await rm(join(directory, 'images/actor.png')); await rm(join(directory, 'images/background.png'));
  await page.reload(); await studio(page);
  assert.equal(await currentCSS(page), goodCSS);
  assert.deepEqual(await savedStudio(page), goodStudio);
  await page.waitForFunction(() => document.querySelector('#actor-image').complete && document.querySelector('#actor-image').naturalWidth === 16);
  await screenshot(page, 'local-customization-list');
  assert.deepEqual(errors, []);
});

test('protected recovery resets all appearance, supports cancel and repeat, preserves settings and user folder', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t, { 'styles/hide.css': hidingCSS, 'styles/first.css': cssOne, 'images/actor.png': redPNG });
  const originalFiles = {};
  for (const kind of ['styles', 'images']) for (const name of await readdir(join(directory, kind))) originalFiles[`${kind}/${name}`] = await readFile(join(directory, kind, name));
  const preserved = {
    'pokome-connections': { twitch: 'keep_channel', kick: 'keep-kick' },
    'pokome-voices': { twitch: 'keep_voice', kick: '' },
    'pokome-users-v2': { twitch: { keep_user: { muted: true } }, kick: {} },
    'pokome-speech-options': { twitch: { volume: 0.3 }, kick: {} },
    'pokome-setup-complete': true,
  };
  const base = await serve(t, createServer({ customizationDirectory: directory }));
  const { page, errors, requests } = await openBrowser(t, base, preserved);
  await studio(page); await page.locator('#studio-theme').selectOption('rose');
  await applyCSS(page, 'first.css'); await applyImage(page, 'actor.png');
  const beforeCancel = await savedStudio(page), beforeCSS = await currentCSS(page);
  await resetAppearance(page, false);
  assert.deepEqual(await savedStudio(page), beforeCancel); assert.equal(await currentCSS(page), beforeCSS);
  await page.locator('#workspace-editor #edit').click();
  assert.equal(await page.locator('#layout-session').isVisible(), true);
  await resetAppearance(page);
  assert.equal(await page.locator('#layout-session').isVisible(), false);
  await studio(page);
  await page.locator('#studio-theme').selectOption('violet');
  await applyCSS(page, 'hide.css');
  assert.equal(await page.locator('main').isVisible(), false);
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  assert.equal(await page.locator('#appearance-recovery #open-reset').isVisible(), true);
  await page.locator('#appearance-recovery #open-reset').click();
  await screenshot(page, 'protected-recovery-dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#appearance-recovery dialog').isVisible(), false);
  assert.equal(await page.locator('main').isVisible(), false);
  await resetAppearance(page);
  assert.equal(await page.locator('main').isVisible(), true);
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(await currentCSS(page), '');
  assert.equal(await page.locator('#studio-theme').inputValue(), DEFAULT_STUDIO.theme);
  assert.equal(await page.locator('#stage-title').textContent(), DEFAULT_STUDIO.title);
  assert.equal(await page.locator('#actor-image').getAttribute('src'), null);
  assert.match(await page.locator('#talk-stage').getAttribute('style'), /\.\/speech-background\.svg/);
  for (const key of ['pokome-studio', 'pokome-theme-v1', 'pokome-workspace-v1']) assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, key);
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), value, key);
  await resetAppearance(page); await resetAppearance(page);
  assert.equal(await page.locator('#appearance-recovery #open-reset').isVisible(), true);
  assert.equal(await page.locator('#appearance-recovery #open-reset').evaluate(button => button.matches(':focus')), true);
  await page.reload(); await studio(page);
  assert.equal(await page.locator('#studio-theme').inputValue(), DEFAULT_STUDIO.theme);
  assert.equal(await currentCSS(page), '');
  await screenshot(page, 'local-restored-default');
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await readFile(join(directory, file)), bytes, file);
  assert.deepEqual((await readdir(directory)).sort(), ['images', 'styles']);
  assert.ok(requests.some(url => new URL(url).pathname === '/style.css'));
  assert.ok(requests.some(url => new URL(url).pathname === '/speech-background.svg'));
  assert.equal((await fetch(base + '/style.css')).status, 200);
  assert.equal((await fetch(base + '/speech-background.svg')).status, 200);
  assert.deepEqual(errors, []);
});

test('pending local CSS and image responses cannot overwrite reset or a newer choice', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t, { 'styles/first.css': cssOne, 'styles/second.css': cssTwo, 'images/first.png': redPNG, 'images/second.png': bluePNG });
  const base = await serve(t, createServer({ customizationDirectory: directory }));
  const { page, errors } = await openBrowser(t, base);
  await studio(page);
  let held = await holdResponse(page, '**/api/customizations/styles/first.css', { status: 200, contentType: 'text/css', body: cssOne });
  await page.locator('#customization-style').selectOption('first.css'); await page.locator('#apply-customization-style').click(); await held.started;
  await resetAppearance(page);
  assert.equal(await page.locator('#customization-status').textContent(), '標準の見た目に戻しました。');
  await held.finish();
  assert.equal(await page.locator('#customization-status').textContent(), '標準の見た目に戻しました。');
  assert.equal(await currentCSS(page), '');
  held = await holdResponse(page, '**/api/customizations/styles/first.css', { status: 200, contentType: 'text/css', body: cssOne });
  await page.locator('#apply-customization-style').click(); await held.started;
  await applyCSS(page, 'second.css'); await held.finish();
  assert.match(await currentCSS(page), /border-radius: 11px/);
  assert.equal(await page.locator('#customization-status').textContent(), 'second.css を適用・保存しました。');
  held = await holdResponse(page, '**/api/customizations/styles/first.css', { status: 200, contentType: 'text/css', body: cssOne });
  await page.locator('#customization-style').selectOption('first.css'); await page.locator('#apply-customization-style').click(); await held.started;
  await page.locator('#theme-import').setInputFiles({ name: 'manual.css', mimeType: 'text/css', buffer: Buffer.from(cssTwo) });
  await page.waitForFunction(() => document.querySelector('#theme-import').value === '');
  await held.finish();
  assert.match(await page.locator('#customization-status').textContent(), /スタイルの読み込みを中止/);
  for (const target of ['image', 'speechImage']) {
    held = await holdResponse(page, '**/api/customizations/images/first.png', { status: 200, contentType: 'image/png', body: redPNG });
    await page.locator('#customization-image').selectOption('first.png'); await page.locator('#customization-image-target').selectOption(target);
    await page.locator('#apply-customization-image').click(); await held.started;
    await resetAppearance(page);
    assert.equal(await page.locator('#customization-status').textContent(), '標準の見た目に戻しました。');
    await held.finish();
    assert.equal(await page.locator('#customization-status').textContent(), '標準の見た目に戻しました。');
    assert.equal((await savedStudio(page))[target], undefined);
    held = await holdResponse(page, '**/api/customizations/images/first.png', { status: 200, contentType: 'image/png', body: redPNG });
    await page.locator('#apply-customization-image').click(); await held.started;
    await applyImage(page, 'second.png', target); await held.finish();
    assert.equal((await savedStudio(page))[target], blueURL);
    assert.match(await page.locator('#customization-status').textContent(), /^second.png を/);
    held = await holdResponse(page, '**/api/customizations/images/first.png', { status: 200, contentType: 'image/png', body: redPNG });
    await page.locator('#customization-image').selectOption('first.png'); await page.locator('#apply-customization-image').click(); await held.started;
    const manualInput = target === 'image' ? '#studio-image' : '#studio-speech-image';
    await page.locator(manualInput).setInputFiles({ name: 'manual.png', mimeType: 'image/png', buffer: bluePNG });
    await page.waitForFunction(id => document.querySelector(id).value === '', manualInput);
    await held.finish();
    assert.match(await page.locator('#customization-status').textContent(), /画像の読み込みを中止/);
    assert.equal((await savedStudio(page))[target], blueURL);
  }
  assert.deepEqual(errors, []);
});

test('a pending uploaded layout cannot undo a full appearance reset', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t);
  const base = await serve(t, createServer({ customizationDirectory: directory }));
  const { page, errors } = await openBrowser(t, base);
  await studio(page);
  const layout = { version: 1, talk: null, home: { panels: Object.fromEntries(['comments', 'now', 'reading'].map((id, index) => [id, {
    x: index * 30, y: 10, w: 25, h: 80, z: 1, hidden: false,
  }])) } };
  await page.evaluate(() => {
    const originalText = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'held-layout.json') return originalText.call(this);
      return new Promise(resolve => { window.releaseHeldLayout = resolve; });
    };
    window.restoreFileText = () => { File.prototype.text = originalText; };
  });
  await page.locator('#workspace-editor #import').setInputFiles({ name: 'held-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) });
  await page.waitForFunction(() => typeof window.releaseHeldLayout === 'function');
  await resetAppearance(page);
  await page.evaluate(value => { window.releaseHeldLayout(value); window.restoreFileText(); }, JSON.stringify(layout));
  await page.waitForFunction(() => document.querySelector('#workspace-editor').shadowRoot.querySelector('#import').value === '');
  assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), null);
  assert.equal(await page.locator('.comments').evaluate(panel => panel.style.position), '');
  assert.equal(await page.locator('#layout-session').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('empty and temporarily unavailable local lists recover on refresh, and repeated operations remain usable', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t);
  const base = await serve(t, createServer({ customizationDirectory: directory }));
  const { page, errors } = await openBrowser(t, base);
  await studio(page);
  for (const name of ['style', 'image']) {
    assert.equal(await page.locator(`#customization-${name}`).isDisabled(), true);
    assert.equal(await page.locator(`#apply-customization-${name}`).isDisabled(), true);
  }
  await screenshot(page, 'local-empty-list');
  await page.route('**/api/customizations', route => route.fulfill({ status: 503, json: { error: 'テスト用の一時的な読み取りエラー' } }), { times: 1 });
  await page.locator('#refresh-customizations').click();
  await page.waitForFunction(() => document.querySelector('#customization-status').textContent.includes('再試行'));
  assert.match(await page.locator('#customization-status').textContent(), /一時的/);
  await writeFile(join(directory, 'styles/added.css'), cssOne); await writeFile(join(directory, 'images/added.png'), redPNG);
  for (let operation = 0; operation < 2; operation++) {
    await page.locator('#refresh-customizations').click();
    await page.locator('#customization-style option[value="added.css"]').waitFor({ state: 'attached' });
    await applyCSS(page, 'added.css'); await applyImage(page, 'added.png');
    assert.equal((await savedStudio(page)).image, redURL);
    await resetAppearance(page);
  }
  assert.equal(await page.locator('#customization-style').isDisabled(), false);
  assert.equal(await page.locator('#appearance-recovery #open-reset').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('built Pages subpath explains limits without local APIs while uploads, persistence and recovery work', { skip: !browserAvailable }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-customization-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = pathToFileURL(directory + '/'); await buildPages(destination);
  const base = await serve(t, createPreviewServer(destination));
  const { page, errors, requests } = await openBrowser(t, base + '/preview/');
  assert.match(await page.locator('#edition-label').textContent(), /GitHub Pages/);
  await page.locator('[data-page="settings"]').click();
  const edition = await page.locator('#edition-capabilities').textContent();
  assert.match(edition, /Twitchのみ/); assert.match(edition, /ブラウザ標準音声のみ/); assert.match(edition, /フォルダー一覧は取得できません/); assert.match(edition, /localhostでは別/);
  assert.equal(await page.locator('#local-speech-controls').isVisible(), false);
  assert.equal(await page.locator('[data-service="kick"]:visible').count(), 0);
  await screenshot(page, 'pages-edition-capabilities');
  await studio(page, false);
  assert.equal(await page.locator('#local-customization').count(), 0);
  assert.match(await page.locator('#pages-customization-help').textContent(), /ファイル選択/);
  await page.locator('#theme-import').setInputFiles({ name: 'uploaded.css', mimeType: 'text/css', buffer: Buffer.from(cssOne) });
  await page.waitForFunction(() => document.querySelector('#pokome-user-theme').textContent.includes('7px'));
  await page.locator('#studio-image').setInputFiles({ name: 'actor.png', mimeType: 'image/png', buffer: redPNG });
  await page.waitForFunction(value => JSON.parse(localStorage.getItem('pokome-studio')).image === value, redURL);
  await page.locator('#studio-speech-image').setInputFiles({ name: 'speech.png', mimeType: 'image/png', buffer: bluePNG });
  await page.waitForFunction(value => JSON.parse(localStorage.getItem('pokome-studio')).speechImage === value, blueURL);
  const good = await savedStudio(page);
  await page.locator('#studio-image').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: redPNG.subarray(0, 33) });
  await page.waitForFunction(() => document.querySelector('#studio-image').value === '');
  assert.deepEqual(await savedStudio(page), good);
  await page.reload(); await studio(page, false);
  assert.match(await currentCSS(page), /7px/); assert.deepEqual(await savedStudio(page), good);
  await screenshot(page, 'pages-upload-customization');
  await page.locator('#theme-import').setInputFiles({ name: 'hide.css', mimeType: 'text/css', buffer: Buffer.from(hidingCSS) });
  await page.locator('main').waitFor({ state: 'hidden' });
  await resetAppearance(page, false); assert.equal(await page.locator('main').isVisible(), false);
  await resetAppearance(page); assert.equal(await page.locator('main').isVisible(), true);
  assert.equal(await currentCSS(page), '');
  assert.equal(await page.locator('#actor-image').getAttribute('src'), null);
  assert.match(await page.locator('#talk-stage').getAttribute('style'), /speech-background\.svg\?v=/);
  assert.equal(await page.locator('#appearance-recovery #open-reset').isVisible(), true);
  assert.deepEqual(requests.filter(url => /\/api\//.test(new URL(url).pathname)), []);
  assert.ok(requests.some(url => new URL(url).pathname === '/preview/style.css'));
  assert.ok(requests.some(url => new URL(url).pathname === '/preview/speech-background.svg'));
  assert.deepEqual(errors, []);
});
