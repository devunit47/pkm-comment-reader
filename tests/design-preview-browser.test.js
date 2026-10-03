import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.js';
import { DEFAULT_STUDIO } from '../studio.js';
import { OVERLAYS_KEY, createOverlay } from '../overlay-model.js';
import { chromium, executablePath, browserAvailable } from './browser-support.js';

// These exercise the actual modal and its epoch/DOM handlers, not a stand-in
// draft controller. Browser launch failures must fail, never become a pass.
const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const ROOT = '#design-preview-editor';
const frameSelector = `${ROOT} #design-preview-frame`;

function png(red, green, blue) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,red,green,blue,255]))), chunk('IEND', Buffer.alloc(0))]);
}
const redPNG = png(240, 30, 50), bluePNG = png(40, 80, 230);
const imageFile = (name, buffer = redPNG) => ({ name, mimeType: 'image/png', buffer });
const setFile = (text, name = 'overlays.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const overlaySet = text => JSON.stringify({ version: 1, items: [createOverlay('text', { id: 'imported-text', text })], assets: {} });

async function fixture(t, initial = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  let server, directory;
  t.after(async () => {
    await browser.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  directory = await mkdtemp(join(tmpdir(), 'pokome-preview-browser-'));
  server = createServer({ customizationDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  // External font availability is irrelevant to these deterministic UI checks.
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.addInitScript(values => {
    if (window !== window.top) return;
    if (!sessionStorage.getItem('preview-fixture-seeded')) {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      sessionStorage.setItem('preview-fixture-seeded', 'true');
    }
    const probe = window.__previewProbe = { writes: [], speech: 0, sockets: 0 };
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        if (this === localStorage) probe.writes.push([method, ...args]);
        return original.apply(this, args);
      };
    }
    if (globalThis.SpeechSynthesis) {
      const speak = SpeechSynthesis.prototype.speak;
      SpeechSynthesis.prototype.speak = function (...args) { probe.speech++; return speak.apply(this, args); };
    }
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); probe.sockets++; }
    };
  }, initial);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator(`${ROOT} #open-design-preview`).waitFor({ state: 'attached' });
  return { page, url, errors, editor: page.locator(ROOT) };
}

async function openPreview(page) {
  await page.locator('[data-page="studio"]').click();
  await page.locator(`${ROOT} #open-design-preview`).click();
  await ready(page);
  return page.frameLocator(frameSelector);
}
async function ready(page) {
  await page.waitForFunction(root => {
    const ui = document.querySelector(root)?.shadowRoot;
    return ui?.getElementById('design-dialog').open && !ui.getElementById('apply-design').disabled;
  }, ROOT);
}
async function countItems(page, count) {
  await page.waitForFunction(([root, expected]) => {
    const doc = document.querySelector(root)?.shadowRoot?.getElementById('design-preview-frame').contentDocument;
    return doc?.querySelectorAll('#talk-stage > .pokome-overlay').length === expected;
  }, [ROOT, count]);
}
async function number(editor, key, value) {
  await editor.locator(`#overlay-${key}`).fill(String(value));
  await editor.locator(`#overlay-${key}`).dispatchEvent('change');
}
async function appearance(page) {
  return page.evaluate(() => ({
    storage: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])),
    stage: document.getElementById('talk-stage').outerHTML,
    comments: document.getElementById('comment-list').innerHTML,
    theme: document.getElementById('pokome-user-theme').textContent,
    writes: window.__previewProbe.writes.length,
    speech: window.__previewProbe.speech,
    sockets: window.__previewProbe.sockets,
  }));
}
async function savedOverlays(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), OVERLAYS_KEY); }
async function settledFrame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); }
async function beginImageGate(page, firstOnly = false) {
  await page.evaluate(firstOnly => {
    const native = window.__nativeImageDecode ||= HTMLImageElement.prototype.decode;
    const state = window.__imageGate = { entered: 0, release: null };
    const gate = new Promise(resolve => { state.release = resolve; });
    HTMLImageElement.prototype.decode = async function () {
      await native.call(this); state.entered++;
      if (!firstOnly || state.entered === 1) await gate;
    };
  }, firstOnly);
}
async function releaseImageGate(page) {
  await page.evaluate(() => window.__imageGate.release());
  await settledFrame(page);
}
async function beginFileGate(page, name = 'delayed.json') {
  await page.evaluate(name => {
    const native = window.__nativeFileText ||= File.prototype.text;
    const state = window.__fileGate = { entered: 0, completed: 0, release: null };
    const gate = new Promise(resolve => { state.release = resolve; });
    File.prototype.text = async function () {
      if (this.name !== name) return native.call(this);
      state.entered++; await gate;
      const text = await native.call(this); state.completed++; return text;
    };
  }, name);
}
async function releaseFileGate(page) {
  await page.evaluate(() => window.__fileGate.release());
  // Native File.text() can complete in a later task; wait for the actual
  // intercepted read rather than relying on elapsed time or a second file.
  await page.waitForFunction(() => window.__fileGate.entered > 0 && window.__fileGate.completed === window.__fileGate.entered);
  await settledFrame(page);
}

browserTest('design preview edits multiple text/image items independently, applies and restores persistence', async t => {
  const { page, editor, errors } = await fixture(t);
  const frame = await openPreview(page), before = await appearance(page);
  await editor.locator('#add-text').click();
  const first = await editor.locator('#overlay-select').inputValue();
  const text = '<img src=x onerror=alert(1)>\n日本語の二行目';
  await editor.locator('#overlay-text').fill(text);
  // Native color pickers are OS UI; drive the same input event with a value.
  await editor.locator('#overlay-color').evaluate(input => { input.value = '#123456'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await number(editor, 'font-size', 44);
  for (const [key, value] of Object.entries({ x: 12, y: 14, w: 24, h: 16, z: 7 })) await number(editor, key, value);
  const firstItem = frame.locator(`.pokome-overlay[data-overlay-id="${first}"]`);
  assert.equal(await firstItem.textContent(), text);
  assert.equal(await firstItem.locator('img,script').count(), 0, 'HTML text is inert');
  assert.equal(await firstItem.evaluate(element => getComputedStyle(element).color), 'rgb(18, 52, 86)');
  assert.equal(await firstItem.evaluate(element => getComputedStyle(element).fontSize), '44px');
  await editor.locator('#add-text').click();
  const second = await editor.locator('#overlay-select').inputValue();
  await editor.locator('#overlay-text').fill('独立した二つ目');
  await number(editor, 'x', 55); await number(editor, 'z', 2);
  await editor.locator('#overlay-image').setInputFiles(imageFile('red.png'));
  await countItems(page, 3); await ready(page);
  const red = await editor.locator('#overlay-select').inputValue();
  await number(editor, 'x', 60);
  await editor.locator('#overlay-image').setInputFiles(imageFile('blue.png', bluePNG));
  await countItems(page, 4); await ready(page);
  const blue = await editor.locator('#overlay-select').inputValue();
  assert.notEqual(red, blue);
  assert.equal(await frame.locator('.pokome-overlay img').count(), 2);
  assert.equal(await firstItem.evaluate(element => element.style.left), '12%');
  await editor.locator('#overlay-select').selectOption(first);
  const move = frame.locator(`.overlay-hit[data-overlay-id="${first}"] button[data-resize="false"]`);
  const resize = frame.locator(`.overlay-hit[data-overlay-id="${first}"] button[data-resize="true"]`);
  await move.press('ArrowRight'); await move.press('Shift+ArrowDown');
  assert.equal(Number(await editor.locator('#overlay-x').inputValue()), 13);
  assert.equal(Number(await editor.locator('#overlay-h').inputValue()), 17);
  const canvas = await page.locator(frameSelector).boundingBox(), handle = await move.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 32, handle.y + handle.height / 2 + 20); await page.mouse.up();
  assert.ok(Math.abs(Number(await editor.locator('#overlay-x').inputValue()) - (13 + 32 / canvas.width * 100)) < 0.15, 'scaled pointer movement preserves logical percentages');
  const sizeBefore = { w: Number(await editor.locator('#overlay-w').inputValue()), h: Number(await editor.locator('#overlay-h').inputValue()) };
  const sizeHandle = await resize.boundingBox();
  await page.mouse.move(sizeHandle.x + sizeHandle.width / 2, sizeHandle.y + sizeHandle.height / 2);
  await page.mouse.down(); await page.mouse.move(sizeHandle.x + sizeHandle.width / 2 + 24, sizeHandle.y + sizeHandle.height / 2 + 16); await page.mouse.up();
  assert.ok(Number(await editor.locator('#overlay-w').inputValue()) > sizeBefore.w);
  assert.ok(Number(await editor.locator('#overlay-h').inputValue()) > sizeBefore.h);
  await number(editor, 'z', 9);
  assert.equal(await firstItem.evaluate(element => getComputedStyle(element).zIndex), '9');
  await editor.locator('#overlay-hidden').check(); assert.equal(await firstItem.isVisible(), false);
  await editor.locator('#overlay-hidden').uncheck(); assert.equal(await firstItem.isVisible(), true);
  await editor.locator('#overlay-select').selectOption(second); await editor.locator('#delete-overlay').click();
  await editor.locator('#overlay-select').selectOption(blue); await editor.locator('#delete-overlay').click();
  await countItems(page, 2);
  assert.deepEqual(await appearance(page), before, 'all edits remain isolated before Apply');
  await editor.locator('#apply-design').click();
  assert.equal(await editor.locator('#design-dialog').isVisible(), false);
  const saved = await savedOverlays(page);
  assert.deepEqual(saved.items.map(item => item.id), [first, red]);
  assert.equal(Object.keys(saved.assets).length, 1, 'deleting an image prunes its unreferenced bytes');
  assert.equal(await page.locator('#talk-stage > .pokome-overlay').count(), 2);
  await page.reload();
  await page.locator(`${ROOT} #open-design-preview`).waitFor({ state: 'attached' });
  assert.deepEqual(await savedOverlays(page), saved);
  assert.equal(await page.locator(`#talk-stage .pokome-overlay[data-overlay-id="${first}"]`).textContent(), text);
  assert.equal(await page.locator('#talk-stage > .pokome-overlay').first().evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.deepEqual(errors, []);
});

browserTest('preview CSS and sample markup are isolated; Cancel, iframe Escape and history discard drafts', async t => {
  const { page, editor, errors } = await fixture(t, { 'pokome-studio': JSON.stringify({ ...DEFAULT_STUDIO, listCount: 3 }) });
  const before = await appearance(page), previewRequests = [];
  page.on('request', request => { if (request.frame() !== page.mainFrame()) previewRequests.push(request.url()); });
  let frame = await openPreview(page);
  await editor.getByText('画面のデザインも試す', { exact: true }).click();
  await editor.locator('#draft-theme').selectOption('rose');
  await editor.locator('#draft-title').fill('未適用の題名');
  await editor.getByText('追加CSSをプレビュー', { exact: true }).click();
  await editor.locator('#draft-css').fill('.pokome-workspace .pokome-comment__author { color: #123456; }');
  assert.equal(await frame.locator('#talk-stage').getAttribute('data-theme'), 'rose');
  assert.equal(await frame.locator('.stage-comment.pokome-comment').count(), 2);
  assert.equal(await frame.locator('.pokome-comment__author').first().evaluate(element => getComputedStyle(element).color), 'rgb(18, 52, 86)');
  assert.equal(await frame.locator('.pokome-comment__body').count(), 2);
  assert.equal(await frame.locator('script,iframe,object,embed,link').count(), 0);
  assert.equal(await page.locator(frameSelector).getAttribute('sandbox'), 'allow-same-origin');
  assert.match(await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /connect-src 'none'/);
  await editor.locator('#add-text').click();
  assert.deepEqual(await appearance(page), before);
  assert.deepEqual(previewRequests, [], 'the script-free iframe issues no external requests');
  await editor.locator('#cancel-design').click();
  assert.deepEqual(await appearance(page), before);
  frame = await openPreview(page); await countItems(page, 0);
  assert.equal(await frame.locator('#stage-title').textContent(), DEFAULT_STUDIO.title);
  await editor.locator('#add-text').click();
  await frame.locator('.overlay-hit button').first().press('Escape');
  assert.equal(await editor.locator('#design-dialog').isVisible(), false);
  assert.deepEqual(await appearance(page), before);
  await openPreview(page); await editor.locator('#add-text').click();
  await page.evaluate(() => { history.pushState({ previewTest: true }, ''); history.back(); });
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await appearance(page), before);
  assert.deepEqual(errors, []);
});

browserTest('invalid CSS and quota failure preserve the live design and leave an editable draft', async t => {
  const { page, editor, errors } = await fixture(t);
  await openPreview(page); const before = await appearance(page);
  await editor.locator('#add-text').click(); await editor.locator('#overlay-text').fill('保存待ち');
  await editor.getByText('追加CSSをプレビュー', { exact: true }).click();
  await editor.locator('#draft-css').fill('body { display:none; }');
  await editor.locator('#apply-design').click();
  assert.match(await editor.locator('#design-status').textContent(), /適用できませんでした/);
  assert.deepEqual(await appearance(page), before);
  await editor.locator('#draft-css').fill('.pokome-workspace .pokome-comment__author { color:#abcdef; }');
  await page.evaluate(key => {
    const set = Storage.prototype.setItem;
    let fail = true;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key && fail) { fail = false; throw new DOMException('Quota exceeded', 'QuotaExceededError'); }
      return set.call(this, name, value);
    };
  }, OVERLAYS_KEY);
  await editor.locator('#apply-design').click();
  assert.match(await editor.locator('#design-status').textContent(), /保存できません/);
  const after = await appearance(page);
  assert.deepEqual(after.storage, before.storage);
  assert.equal(after.stage, before.stage); assert.equal(after.theme, before.theme); assert.equal(after.comments, before.comments);
  assert.equal(await editor.locator('#design-dialog').isVisible(), true);
  await countItems(page, 1);
  await editor.locator('#apply-design').click();
  assert.equal(await editor.locator('#design-dialog').isVisible(), false);
  assert.equal((await savedOverlays(page)).items[0].text, '保存待ち');
  assert.deepEqual(errors, []);
});

browserTest('preview preparation disables reset/import and cancellation does not poison a later session', async t => {
  const { page, editor, errors } = await fixture(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  await page.route('**/style.css', async route => { started(); await gate; await route.continue(); }, { times: 1 });
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#open-design-preview').click(); await requested;
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  assert.equal(await editor.locator('#draft-reset').isDisabled(), true);
  assert.equal(await editor.locator('#import-overlays').isDisabled(), true);
  await editor.locator('#cancel-design').click(); release();
  await openPreview(page);
  assert.equal(await editor.locator('#draft-reset').isEnabled(), true);
  assert.equal(await editor.locator('#import-overlays').isEnabled(), true);
  await editor.locator('#add-text').click(); await countItems(page, 1);
  await editor.locator('#cancel-design').click();
  assert.equal(await savedOverlays(page), null);
  assert.deepEqual(errors, []);
});

browserTest('pending image decode cannot resurrect items after reset, cancel, or a newer set import', async t => {
  const { page, editor, errors } = await fixture(t);
  await beginImageGate(page); await openPreview(page); const before = await appearance(page);
  await editor.locator('#overlay-image').setInputFiles(imageFile('red.png'));
  await page.waitForFunction(() => window.__imageGate.entered === 1);
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  await editor.locator('#draft-reset').click();
  await releaseImageGate(page); await countItems(page, 0); await ready(page);
  assert.deepEqual(await appearance(page), before);
  await editor.locator('#cancel-design').click();

  await beginImageGate(page); await openPreview(page);
  await editor.locator('#overlay-image').setInputFiles(imageFile('red.png'));
  await page.waitForFunction(() => window.__imageGate.entered === 1);
  await editor.locator('#cancel-design').click();
  await releaseImageGate(page); await openPreview(page); await countItems(page, 0);

  await beginImageGate(page);
  await editor.locator('#overlay-image').setInputFiles(imageFile('red.png'));
  await page.waitForFunction(() => window.__imageGate.entered === 1);
  await editor.locator('#import-overlays').setInputFiles(setFile(overlaySet('新しいセット')));
  await countItems(page, 1); await ready(page);
  await releaseImageGate(page);
  assert.equal(await page.frameLocator(frameSelector).locator('.pokome-overlay').textContent(), '新しいセット');
  assert.equal(await page.frameLocator(frameSelector).locator('.pokome-overlay img').count(), 0);
  assert.deepEqual(await appearance(page), before);
  await editor.locator('#apply-design').click();
  assert.equal((await savedOverlays(page)).items[0].text, '新しいセット');
  assert.deepEqual(errors, []);
});

browserTest('latest image wins without waiting for superseded decode, and deleting an add-image ID cannot strand Apply', async t => {
  const { page, editor, errors } = await fixture(t);
  await openPreview(page); const before = await appearance(page);
  await beginImageGate(page, true);
  await editor.locator('#overlay-image').setInputFiles(imageFile('old-red.png'));
  await page.waitForFunction(() => window.__imageGate.entered === 1);
  await editor.locator('#overlay-image').setInputFiles(imageFile('new-blue.png', bluePNG));
  await page.waitForFunction(() => window.__imageGate.entered === 2);
  await countItems(page, 1); await ready(page);
  const frame = page.frameLocator(frameSelector);
  assert.equal(await frame.locator('.pokome-overlay img').getAttribute('src'), `data:image/png;base64,${bluePNG.toString('base64')}`);
  await releaseImageGate(page); await ready(page); await countItems(page, 1);
  assert.equal(await frame.locator('.pokome-overlay img').getAttribute('src'), `data:image/png;base64,${bluePNG.toString('base64')}`);
  await editor.locator('#draft-reset').click();
  const imported = { version: 1, items: [createOverlay('text', { id: 'add-image', text: '削除する文字' })], assets: {} };
  await editor.locator('#import-overlays').setInputFiles(setFile(JSON.stringify(imported)));
  await countItems(page, 1); await ready(page);
  await beginImageGate(page);
  await editor.locator('#overlay-image').setInputFiles(imageFile('red.png'));
  await page.waitForFunction(() => window.__imageGate.entered === 1);
  await editor.locator('#overlay-select').selectOption('add-image');
  await editor.locator('#delete-overlay').click(); await countItems(page, 0);
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  await releaseImageGate(page); await countItems(page, 1); await ready(page);
  assert.equal(await frame.locator('.pokome-overlay[data-overlay-id="add-image"]').count(), 0);
  assert.equal(await frame.locator('.pokome-overlay img').count(), 1);
  assert.deepEqual(await appearance(page), before);
  assert.deepEqual(errors, []);
});

browserTest('pending set imports yield to newer edits, reset, and newer imports without partial replacement', async t => {
  const { page, editor, errors } = await fixture(t);
  await openPreview(page); const before = await appearance(page);
  await beginFileGate(page);
  await editor.locator('#import-overlays').setInputFiles(setFile(overlaySet('古いセット'), 'delayed.json'));
  await page.waitForFunction(() => window.__fileGate.entered);
  await editor.locator('#add-text').click(); await editor.locator('#overlay-text').fill('新しい編集');
  await releaseFileGate(page);
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-status').textContent.includes('新しい編集が優先'), ROOT);
  assert.equal(await page.frameLocator(frameSelector).locator('.pokome-overlay').textContent(), '新しい編集');
  await beginFileGate(page);
  await editor.locator('#import-overlays').setInputFiles(setFile(overlaySet('復活しない'), 'delayed.json'));
  await page.waitForFunction(() => window.__fileGate.entered);
  await editor.locator('#draft-reset').click(); await releaseFileGate(page); await countItems(page, 0);
  await beginFileGate(page);
  await editor.locator('#import-overlays').setInputFiles(setFile(overlaySet('古いインポート'), 'delayed.json'));
  await page.waitForFunction(() => window.__fileGate.entered);
  await editor.locator('#import-overlays').setInputFiles(setFile(overlaySet('最新インポート')));
  await countItems(page, 1); await ready(page); await releaseFileGate(page);
  assert.equal(await page.frameLocator(frameSelector).locator('.pokome-overlay').textContent(), '最新インポート');
  await editor.locator('#import-overlays').setInputFiles(setFile(JSON.stringify({ version: 1, items: [{ id: 'bad', type: 'image', assetId: 'missing' }], assets: {} })));
  await ready(page);
  assert.match(await editor.locator('#design-status').textContent(), /読み込めない/);
  assert.equal(await page.frameLocator(frameSelector).locator('.pokome-overlay').textContent(), '最新インポート');
  assert.deepEqual(await appearance(page), before);
  assert.deepEqual(errors, []);
});

browserTest('external appearance changes require reload even after cancelling and reopening the editor', async t => {
  const { page, editor, url, errors } = await fixture(t);
  await openPreview(page); await editor.locator('#add-text').click();
  const other = await page.context().newPage();
  await other.goto(url);
  await other.locator(`${ROOT} #open-design-preview`).waitFor({ state: 'attached' });
  const externalCSS = '.pokome-workspace .pokome-comment__author { color:#123456; }';
  await other.evaluate(css => localStorage.setItem('pokome-theme-v1', css), externalCSS);
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-status').textContent.includes('別のタブ'), ROOT);
  await editor.locator('#apply-design').click();
  assert.match(await editor.locator('#design-status').textContent(), /再読み込み/);
  assert.equal(await savedOverlays(page), null);
  await editor.locator('#cancel-design').click();
  await editor.locator('#open-design-preview').click();
  assert.equal(await editor.locator('#design-dialog').isVisible(), false);
  assert.match(await editor.locator('#preview-result').textContent(), /再読み込み/);
  await page.reload();
  const frame = await openPreview(page);
  assert.equal(await frame.locator('.pokome-comment__author').first().evaluate(element => getComputedStyle(element).color), 'rgb(18, 52, 86)');
  await countItems(page, 0);
  assert.deepEqual(errors, []);
});

browserTest('preview speech clamp uses saved geometry and relaxes when draft CSS lowers the minimum', async t => {
  const panels = Object.fromEntries(['header','chat','speech','actor','footer'].map(id => [id, { x: 0, y: 0, w: 40, h: 20, z: 1, hidden: false }]));
  panels.speech = { x: 50, y: 75, w: 50, h: 25, z: 2, hidden: false };
  const workspace = JSON.stringify({ version: 1, home: null, talk: { panels } });
  const { page, editor, errors } = await fixture(t, { 'pokome-workspace-v1': workspace, 'pokome-theme-v1': '.pokome-workspace .stage-speech { min-height:300px; }' });
  const frame = await openPreview(page), speech = frame.locator('.stage-speech');
  assert.ok(Math.abs(await speech.evaluate(element => parseFloat(getComputedStyle(element).top)) - 420) < 1);
  await editor.getByText('追加CSSをプレビュー', { exact: true }).click();
  await editor.locator('#draft-css').fill('.pokome-workspace .stage-speech { min-height:100px; }');
  assert.ok(Math.abs(await speech.evaluate(element => parseFloat(getComputedStyle(element).top)) - 540) < 1, 'lowering min-height uses raw y75/h25 rather than the old clamped top');
  await editor.locator('#preview-width').selectOption('640');
  await page.waitForFunction(root => {
    const frame = document.querySelector(root).shadowRoot.getElementById('design-preview-frame');
    return Math.abs(parseFloat(frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('.stage-speech')).top) - 260) < 1;
  }, ROOT);
  assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), workspace);
  await editor.locator('#cancel-design').click();
  assert.deepEqual(errors, []);
});

browserTest('640x360 preview scroll keeps protected handles aligned with their actual overlay rectangles', async t => {
  const { page, editor, errors } = await fixture(t);
  const frame = await openPreview(page);
  await editor.locator('#add-text').click(); const id = await editor.locator('#overlay-select').inputValue();
  await number(editor, 'y', 60); await number(editor, 'h', 20);
  await editor.locator('#preview-width').selectOption('640');
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentWindow.innerWidth === 640, ROOT);
  const stage = frame.locator('#talk-stage');
  assert.ok(await stage.evaluate(element => element.scrollHeight > element.clientHeight));
  await stage.evaluate(element => { element.scrollTop = 60; });
  await page.waitForFunction(([root, id]) => {
    const doc = document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentDocument;
    const stage = doc.querySelector('#talk-stage'), overlay = doc.querySelector(`.pokome-overlay[data-overlay-id="${id}"]`).getBoundingClientRect(), hit = doc.querySelector(`.overlay-hit[data-overlay-id="${id}"]`).getBoundingClientRect();
    return stage.scrollTop > 0 && ['left','top','width','height'].every(key => Math.abs(overlay[key] - hit[key]) < 1);
  }, [ROOT, id]);
  const move = frame.locator(`.overlay-hit[data-overlay-id="${id}"] button[data-resize="false"]`);
  await move.press('ArrowRight');
  assert.equal(Number(await editor.locator('#overlay-x').inputValue()), 6);
  const rects = await frame.locator('body').evaluate((body, id) => {
    const overlay = body.querySelector(`.pokome-overlay[data-overlay-id="${id}"]`).getBoundingClientRect(), hit = body.querySelector(`.overlay-hit[data-overlay-id="${id}"]`).getBoundingClientRect();
    return { overlay: { x: overlay.x, y: overlay.y }, hit: { x: hit.x, y: hit.y } };
  }, id);
  assert.ok(Math.abs(rects.overlay.x - rects.hit.x) < 1 && Math.abs(rects.overlay.y - rects.hit.y) < 1);
  assert.equal(await savedOverlays(page), null);
  assert.deepEqual(errors, []);
});
