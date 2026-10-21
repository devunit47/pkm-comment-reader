import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.js';
import { DEFAULT_STUDIO } from '../src/shared/studio.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { closeBrowser, chromium, executablePath, browserAvailable, readDesign, appReady, blockExternalFonts, applyInEditor, closeEditor, editorThemeCSS, temporaryDataDirectory, readSettings, saveSetting, talkStage, saveDesign } from './browser-support.js';

const cssOne = '.pokome-workspace .pokome-panel { border-radius: 7px; }';
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
const redPNG = png(229, 80, 98);
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

async function openBrowser(t, url, initialSettings = {}) {
  for (const [field, value] of Object.entries(initialSettings)) await saveSetting(url, field, value);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => closeBrowser(browser));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
  page.setDefaultTimeout(8000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(url);
  await appReady(page);
  return { page, errors, requests };
}

async function studio(page) {
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
  await studio(page);
  const recovery = page.locator('#design-presets');
  await recovery.locator('#preset-reset').click();
  assert.equal(await recovery.locator('#preset-confirm-dialog').evaluate(dialog => dialog.matches(':modal')), true);
  await recovery.locator(confirm ? '#preset-confirm' : '#preset-confirm-cancel').click();
  assert.equal(await recovery.locator('#preset-confirm-dialog').isVisible(), false);
  // The reset is saved asynchronously; success is announced like other operations.
  if (confirm) await page.locator('#design-presets #preset-status').filter({ hasText: '今のデザイン全体を標準へ戻しました。' }).waitFor();
}
async function screenshot(page, name) {
  if (!qaDirectory) return;
  await mkdir(qaDirectory, { recursive: true });
  await page.screenshot({ path: join(qaDirectory, name + '.png'), fullPage: true });
}
test('theme CSS leaves operating controls visible and preset reset preserves settings and user folder', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t, { 'styles/hide.css': hidingCSS, 'styles/first.css': cssOne, 'images/actor.png': redPNG });
  const originalFiles = {};
  for (const kind of ['styles', 'images']) for (const name of await readdir(join(directory, kind))) originalFiles[`${kind}/${name}`] = await readFile(join(directory, kind, name));
  const preserved = {
    connections: { twitch: 'keep_channel', kick: 'keep-kick' },
    voices: { twitch: 'keep_voice', kick: '' },
    users: { twitch: { keep_user: { muted: true } }, kick: {} },
    speechOptions: { twitch: { maxLength: 140 }, kick: {} },
    setupComplete: true,
  };
  const base = await serve(t, createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory }));
  const { page, errors, requests } = await openBrowser(t, base, preserved);
  const savedSettings = await readSettings(base);
  const recoveryShown = () => page.locator('#appearance-recovery').isVisible();
  // Recovery is reserved for a protected unreadable original.
  assert.equal(await recoveryShown(), false, 'no theme CSS: no floating recovery');
  await studio(page); await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('rose'));
  assert.equal(await recoveryShown(), false, 'design settings alone do not show recovery');
  await applyCSS(page, 'first.css'); await applyImage(page, 'actor.png');
  assert.equal(await recoveryShown(), false, 'theme CSS alone does not show recovery');
  const beforeCancel = await savedStudio(page), beforeCSS = await currentCSS(page);
  await resetAppearance(page, false);
  assert.deepEqual(await savedStudio(page), beforeCancel); assert.equal(await currentCSS(page), beforeCSS);
  await resetAppearance(page);
  assert.equal(await recoveryShown(), false, 'reset clears the CSS and hides recovery');
  await studio(page);
  await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('violet'));
  await applyCSS(page, 'hide.css');
  assert.equal(await page.locator('main').isVisible(), true);
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(await recoveryShown(), false, 'hiding CSS cannot expose recovery or hide operating controls');
  await resetAppearance(page);
  assert.equal(await page.locator('main').isVisible(), true);
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(await currentCSS(page), '');
  assert.equal((await savedStudio(page)).theme, DEFAULT_STUDIO.theme);
  assert.equal(await talkStage(page).locator('#stage-title').textContent(), DEFAULT_STUDIO.title);
  assert.equal(await talkStage(page).locator('#actor-image').getAttribute('src'), null);
  assert.match(await talkStage(page).locator('#talk-stage').getAttribute('style'), /\.\/speech-background\.svg/);
  assert.deepEqual(await readDesign(base), defaultDesign());
  assert.equal(await page.locator('#workspace-editor,#layout-session').count(), 0);
  assert.deepEqual(await readSettings(base), savedSettings);
  assert.equal(await recoveryShown(), false);
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

test('preset reset keeps an open draft stale until it is restarted', { skip: !browserAvailable }, async t => {
  const directory = await fixture(t);
  const base = await serve(t, createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory }));
  // A normal preset reset remains available when theme CSS is applied.
  await saveDesign(base, { theme: cssOne });
  const { page } = await openBrowser(t, base);
  await studio(page);
  const editor = page.locator('#design-preview-editor');
  await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editor.locator('#draft-theme').selectOption('rose');
  // Reset from the same page while its editor draft is open.
  await page.locator('#design-presets #preset-reset').evaluate(button => button.click());
  await page.locator('#design-presets #preset-confirm').click();
  await page.locator('#design-presets #preset-status').filter({ hasText: '今のデザイン全体を標準へ戻しました。' }).waitFor();
  assert.equal(await editor.locator('#design-dialog').isVisible(), true);
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  await editor.locator('#restart-design').click(); await editor.locator('#editor-confirm-accept').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await editor.locator('#draft-theme').inputValue(), DEFAULT_STUDIO.theme);
  await closeEditor(editor); assert.deepEqual(await readDesign(base), defaultDesign());
});
