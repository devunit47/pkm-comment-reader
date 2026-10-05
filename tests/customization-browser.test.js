import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.js';
import { createHash } from 'node:crypto';
import { DEFAULT_STUDIO } from '../src/shared/studio.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { chromium, executablePath, browserAvailable, readDesign, appReady, blockExternalFonts, applyInEditor, closeEditor, editorThemeCSS } from './browser-support.js';

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
// Applied images are copied into customization/current under their SHA-256.
const ref = (bytes, extension = 'png') => `images/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
const redURL = ref(redPNG), blueURL = ref(bluePNG);
const served = value => `/api/design/current/${value}`;

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
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

}
const savedStudio = async page => (await readDesign(new URL(page.url()).origin)).studio;
const currentCSS = page => page.locator('#pokome-user-theme').textContent();
async function applyCSS(page, name) {
  await applyInEditor(page, async editor => {
    const css = name === 'hide.css' ? hidingCSS : cssOne;
    await editorThemeCSS(editor);
    await editor.locator('#draft-css').fill(css);
  });
}
async function applyImage(page) {
  await applyInEditor(page, async editor => {
    await editor.locator('#target-select').selectOption('actor');
    await editor.locator('#draft-image').setInputFiles({ name: 'actor.png', mimeType: 'image/png', buffer: redPNG });
    await editor.locator('#design-status').filter({ hasText: '画像を下書きに入れました' }).waitFor();
  });
}
async function resetAppearance(page, confirm = true) {
  const recovery = page.locator('#appearance-recovery');
  await recovery.locator('#open-reset').click();
  assert.equal(await recovery.locator('dialog').evaluate(dialog => dialog.matches(':modal')), true);
  await recovery.locator(confirm ? '#confirm-reset' : '#cancel-reset').click();
  assert.equal(await recovery.locator('dialog').isVisible(), false);
  // The reset is saved to the folder asynchronously; its message appears when done.
  if (confirm) await page.waitForFunction(() => document.querySelector('#appearance-recovery').shadowRoot.querySelector('#result').textContent !== '');
}
async function screenshot(page, name) {
  if (!qaDirectory) return;
  await mkdir(qaDirectory, { recursive: true });
  await page.screenshot({ path: join(qaDirectory, name + '.png'), fullPage: true });
}
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
  await studio(page); await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('rose'));
  await applyCSS(page, 'first.css'); await applyImage(page, 'actor.png');
  const beforeCancel = await savedStudio(page), beforeCSS = await currentCSS(page);
  await resetAppearance(page, false);
  assert.deepEqual(await savedStudio(page), beforeCancel); assert.equal(await currentCSS(page), beforeCSS);
  await page.locator('#workspace-editor #edit').click();
  assert.equal(await page.locator('#layout-session').isVisible(), true);
  await resetAppearance(page);
  assert.equal(await page.locator('#layout-session').isVisible(), false);
  await studio(page);
  await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('violet'));
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
  assert.equal((await savedStudio(page)).theme, DEFAULT_STUDIO.theme);
  assert.equal(await page.locator('#stage-title').textContent(), DEFAULT_STUDIO.title);
  assert.equal(await page.locator('#actor-image').getAttribute('src'), null);
  assert.match(await page.locator('#talk-stage').getAttribute('style'), /\.\/speech-background\.svg/);
  assert.deepEqual(await readDesign(base), defaultDesign());
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pokome-workspace-v1')).home), null);
  for (const key of ['pokome-studio', 'pokome-theme-v1', 'pokome-overlays-v1']) assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, key);
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), value, key);
  await resetAppearance(page); await resetAppearance(page);
  assert.equal(await page.locator('#appearance-recovery #open-reset').isVisible(), true);
  assert.equal(await page.locator('#appearance-recovery #open-reset').evaluate(button => button.matches(':focus')), true);
  await page.reload(); await appReady(page); await studio(page);
  assert.equal((await savedStudio(page)).theme, DEFAULT_STUDIO.theme);
  assert.equal(await currentCSS(page), '');
  await screenshot(page, 'local-restored-default');
  for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(await readFile(join(directory, file)), bytes, file);
  // The applied design lives beside the user's own files, which stay untouched.
  assert.deepEqual((await readdir(directory)).sort(), ['current', 'images', 'presets', 'styles']);
  assert.deepEqual(await readdir(join(directory, 'presets')), [], 'recovery keeps the preset folder');
  assert.ok(requests.some(url => new URL(url).pathname === '/style.css'));
  assert.ok(requests.some(url => new URL(url).pathname === '/speech-background.svg'));
  assert.equal((await fetch(base + '/style.css')).status, 200);
  assert.equal((await fetch(base + '/speech-background.svg')).status, 200);
  assert.deepEqual(errors, []);
});
