import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { chromium, executablePath, browserAvailable, readDesign, saveDesign, appReady, blockExternalFonts, uploadDesignImage, editorTarget, editorThemeCSS, closeEditor } from './browser-support.js';

// The full-screen editor: one target's settings at a time, a single draft for
// every ratio, and nothing written before Apply.
const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const ROOT = '#design-preview-editor';

async function fixture(t, { design, viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-editor-browser-'));
  const server = createServer({ customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (design) await saveDesign(url, design);
  const page = await (await browser.newContext({ viewport })).newPage();
  page.setDefaultTimeout(8000);
  await blockExternalFonts(page);
  const errors = [], puts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/design/current')) puts.push(request.postDataJSON()); });
  await page.goto(url); await appReady(page);
  return { page, url, errors, puts, editor: page.locator(ROOT) };
}
async function open(page, editor) {
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
}
const shown = editor => editor.locator('[data-target]').evaluateAll(sections => sections.filter(section => !section.hidden).map(section => section.dataset.target));

browserTest('the target list shows the five panels and additions, and each target shows only its settings', async t => {
  const item = createOverlay('text', { id: 'note', text: '資料の文字' });
  const { page, editor, errors } = await fixture(t, { design: design => ({ ...design, ratios: { ...design.ratios, '16:9': { layout: null, overlays: { version: 1, items: [item], assets: {} } } } }) });
  await open(page, editor);
  assert.deepEqual(await editor.locator('#target-select option').evaluateAll(options => options.map(option => option.value)), ['screen', 'header', 'chat', 'speech', 'actor', 'footer', 'note']);
  assert.deepEqual(await shown(editor), ['screen']);
  for (const [target, field, heading] of [['header', '#draft-title', /ヘッダー/], ['chat', '#draft-maxVisible', /コメント欄/], ['speech', '#draft-speechStyle', /読み上げ/], ['actor', '#actor-mode', /立ち絵/], ['footer', '#draft-footer', /フッター/], ['note', '#overlay-x', /追加した文字/]]) {
    await editorTarget(editor, target);
    assert.deepEqual(await shown(editor), [target === 'note' ? 'overlay' : target]);
    assert.equal(await editor.locator(field).isVisible(), true);
    assert.match(await editor.locator('#target-heading').textContent(), heading);
  }
  // Another ratio lists only its own additions; the selection falls back to the whole screen.
  await editor.locator('#preview-width').selectOption('1080x1920');
  assert.equal(await editor.locator('#target-select option[value="note"]').count(), 0);
  assert.deepEqual(await shown(editor), ['screen']);
  assert.deepEqual(errors, []);
});

browserTest('closing with changes asks first; discarding every change keeps the editor open and writes nothing', async t => {
  const { page, url, editor, errors, puts } = await fixture(t);
  const before = await readDesign(url);
  await open(page, editor);
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  assert.equal(await editor.locator('#discard-design').isDisabled(), true);
  await editorTarget(editor, 'header'); await editor.locator('#draft-title').fill('下書きの題名');
  await editor.locator('#preview-width').selectOption('1080x1920');
  await editor.locator('#add-text').click();
  assert.equal(await editor.locator('#draft-state').textContent(), '下書き・未適用');
  await editor.locator('#cancel-design').click();
  assert.match(await editor.locator('#editor-confirm-message').textContent(), /すべての比率/);
  await editor.locator('#editor-confirm-cancel').click();
  assert.equal(await editor.locator('#design-dialog').isVisible(), true, 'keep editing');
  await editor.locator('#discard-design').click();
  assert.match(await editor.locator('#editor-confirm-message').textContent(), /変更をすべて破棄します/);
  await editor.locator('#editor-confirm-accept').click();
  assert.equal(await editor.locator('#design-dialog').isVisible(), true, 'the editor stays open');
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  assert.equal(await page.frameLocator(`${ROOT} #design-preview-frame`).locator('.pokome-overlay').count(), 0, 'the portrait addition is gone too');
  await editorTarget(editor, 'header');
  assert.equal(await editor.locator('#draft-title').inputValue(), before.studio.title);
  await editor.locator('#cancel-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await readDesign(url), before); assert.equal(puts.length, 0);
  // Apply without changes closes without a write.
  await open(page, editor); await editor.locator('#apply-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal(puts.length, 0);
  assert.deepEqual(errors, []);
});

browserTest('a number being typed is not corrected until it is committed, and an empty number keeps its value', async t => {
  const { page, url, editor, errors } = await fixture(t);
  await open(page, editor); await editorTarget(editor, 'chat');
  const size = editor.locator('#draft-fontSize');
  await size.fill('1');
  assert.equal(await size.inputValue(), '1', 'typing 18 passes through 1 without becoming 16');
  await size.pressSequentially('8');
  assert.equal(await size.inputValue(), '18');
  assert.equal(await page.frameLocator(`${ROOT} #design-preview-frame`).locator('#talk-stage').evaluate(stage => stage.style.getPropertyValue('--stage-font-size')), '18px');
  await size.fill('90'); await size.dispatchEvent('change');
  assert.equal(await size.inputValue(), '64');
  await size.fill(''); await size.dispatchEvent('change');
  assert.equal(await size.inputValue(), '64');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readDesign(url)).studio.fontSize, 64);
  assert.deepEqual(errors, []);
});

browserTest('a stale draft keeps its content, cannot be applied, and restarts from the latest design', async t => {
  const { page, url, editor, errors } = await fixture(t);
  await open(page, editor); await editorTarget(editor, 'footer');
  await editor.locator('#draft-footer').fill('古い下書き');
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, title: '別のタブの題名' } }));
  await editor.locator('#design-status').filter({ hasText: '最新のデザインから編集をやり直してください' }).waitFor();
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  assert.equal(await editor.locator('#draft-footer').inputValue(), '古い下書き');
  await editor.locator('#discard-design').click(); await editor.locator('#editor-confirm-accept').click();
  assert.equal(await editor.locator('#apply-design').isDisabled(), true, 'discarding alone does not make a stale draft applicable');
  await editor.locator('#restart-design').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await editor.locator('#restart-design').isVisible(), false);
  await editorTarget(editor, 'header');
  assert.equal(await editor.locator('#draft-title').inputValue(), '別のタブの題名');
  await editor.locator('#draft-subtitle').fill('最新から編集');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  const saved = await readDesign(url);
  assert.deepEqual([saved.studio.title, saved.studio.subtitle], ['別のタブの題名', '最新から編集']);
  assert.deepEqual(errors, []);
});

browserTest('narrow docks stack the canvas above a target and settings switch', async t => {
  const { page, url, editor, errors } = await fixture(t, { viewport: { width: 400, height: 700 } });
  await open(page, editor);
  const top = async selector => (await editor.locator(selector).boundingBox())?.y;
  assert.ok(await top('#preview-viewport') < await top('#show-targets'));
  assert.equal(await editor.locator('#target-select').isVisible(), true);
  assert.equal(await editor.locator('#draft-theme').isVisible(), false);
  await editorTarget(editor, 'speech');
  assert.equal(await editor.locator('#target-select').isVisible(), false);
  assert.equal(await editor.locator('#show-settings').getAttribute('aria-pressed'), 'true');
  await editor.locator('#draft-speechTitle').fill('ドックで編集');
  const dialog = await editor.locator('#design-dialog').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  assert.ok(dialog.scroll <= dialog.client);
  await editor.locator('#draft-speechTitle').scrollIntoViewIfNeeded();
  const apply = await editor.locator('#apply-design').boundingBox();
  assert.ok(apply.y >= 0 && apply.y + apply.height <= 700, 'the header stays in view');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readDesign(url)).studio.speechTitle, 'ドックで編集');
  assert.deepEqual(errors, []);
});

browserTest('preset confirmation hides the editing tools and discarding', async t => {
  const { page, editor, errors } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  const presets = page.locator('#design-presets');
  await page.waitForFunction(() => !document.querySelector('#design-presets')?.shadowRoot?.getElementById('preset-refresh').disabled);
  await presets.locator('#preset-save').click(); await presets.locator('#preset-name').fill('確認だけ'); await presets.locator('#preset-name-submit').click();
  await presets.locator('#preset-status').filter({ hasText: 'プリセットに保存しました' }).waitFor();
  await presets.locator('#preset-load').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.match(await editor.locator('#design-title').textContent(), /プリセットを確認/);
  for (const selector of ['#target-select', '#add-text', '#discard-design', '#draft-theme']) assert.equal(await editor.locator(selector).isVisible(), false, selector);
  assert.equal(await editor.locator('#preview-width').isVisible(), true);
  await closeEditor(editor);
  assert.deepEqual(errors, []);
});

// A 1×1 PNG; the editor uploads it as a file reference.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const pngFile = name => ({ name, mimeType: 'image/png', buffer: PNG });

browserTest('every appearance setting is edited in the draft and applied in one write', async t => {
  const { page, url, editor, errors, puts } = await fixture(t);
  const before = await readDesign(url);
  await open(page, editor);
  await editorTarget(editor, 'screen');
  await editor.locator('#draft-outputSize').selectOption('1080x1920');
  await editorThemeCSS(editor);
  const css = '.pokome-workspace .pokome-comment__author { color: #123456; }';
  await editor.locator('#draft-css-file').setInputFiles({ name: 'look.css', mimeType: 'text/css', buffer: Buffer.from(css) });
  await page.waitForFunction(([root, value]) => document.querySelector(root).shadowRoot.getElementById('draft-css').value === value, [ROOT, css]);
  const download = page.waitForEvent('download');
  await editor.locator('#draft-css-export').click();
  assert.equal(await readFile(await (await download).path(), 'utf8'), css, 'the CSS being edited is exported');
  await editor.locator('#draft-css-clear').click();
  assert.equal(await editor.locator('#draft-css').inputValue(), '');
  await editor.locator('#draft-css-file').setInputFiles({ name: 'look.css', mimeType: 'text/css', buffer: Buffer.from(css) });
  await page.waitForFunction(([root, value]) => document.querySelector(root).shadowRoot.getElementById('draft-css').value === value, [ROOT, css]);
  await editorTarget(editor, 'chat');
  await editor.locator('#draft-commentPreset').selectOption('chips');
  assert.equal(await editor.locator('#draft-commentStyle').inputValue(), 'anonymous', 'a comment preset also sets the comment format');
  await editor.locator('#draft-commentOutline').selectOption('thin');
  assert.equal(await editor.locator('#draft-commentPreset').inputValue(), '', 'a changed look no longer matches a preset');
  await editor.locator('#draft-commentTextColorMode').selectOption('custom');
  await editor.locator('#draft-commentTextColor').evaluate(input => { input.value = '#223344'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await editor.locator('#draft-commentLabel').uncheck();
  await editorTarget(editor, 'speech');
  await editor.locator('#draft-speechImage').setInputFiles(pngFile('speech.png'));
  await editor.locator('#speech-image-status').filter({ hasText: '登録' }).waitFor();
  await editorTarget(editor, 'actor');
  await editor.locator('#draft-source').selectOption('image');
  await editor.locator('#draft-image').setInputFiles(pngFile('actor.png'));
  await editor.locator('#actor-image-status').filter({ hasText: '登録' }).waitFor();
  assert.deepEqual(await readDesign(url), before); assert.equal(puts.length, 0);
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal(puts.length, 1);
  const saved = await readDesign(url);
  assert.equal(saved.outputSize, '1080x1920');
  assert.equal(saved.theme, css);
  assert.deepEqual([saved.studio.commentItemBackground, saved.studio.commentOutline, saved.studio.commentTextColor, saved.studio.commentLabel], ['light', 'thin', '#223344', false]);
  assert.match(saved.studio.speechImage, /^images\/[0-9a-f]{64}\.png$/);
  assert.equal(saved.studio.speechStyle, 'image');
  assert.match(saved.studio.image, /^images\/[0-9a-f]{64}\.png$/);
  assert.equal(saved.studio.source, 'image');
  await open(page, editor);
  await editorTarget(editor, 'actor'); await editor.locator('#draft-image-remove').click();
  await editorTarget(editor, 'speech'); await editor.locator('#draft-speechImage-reset').click();
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  const cleared = await readDesign(url);
  assert.deepEqual([cleared.studio.image, cleared.studio.speechImage], ['', '']);
  assert.deepEqual(errors, []);
});

browserTest('appearance moved into the editor has no instant-save fields left, and the history limit lives in settings', async t => {
  const { page, editor, errors } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  for (const selector of ['#studio-theme', '#studio-comment-preset', '#studio-speech-style', '#studio-image', '#studio-font-size', '#theme-css', '#theme-import', '#theme-reset']) {
    assert.equal(await page.locator(selector).count(), 0, selector);
  }
  assert.equal(await editor.locator('#open-design-preview').isVisible(), true);
  await page.locator('[data-page="settings"]').click();
  assert.equal(await page.locator('#studio-list-count').isVisible(), true);
  assert.deepEqual(errors, []);
});

browserTest('removing an image while its upload is checked keeps Apply usable and the late upload out of the draft', async t => {
  const { page, url, editor, errors } = await fixture(t);
  const { ref } = await uploadDesignImage(url, PNG);
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, source: 'image', image: ref } }));
  await page.reload(); await appReady(page);
  await open(page, editor); await editorTarget(editor, 'actor');
  await page.evaluate(() => {
    const native = HTMLImageElement.prototype.decode;
    window.__release = null;
    const gate = new Promise(resolve => { window.__release = resolve; });
    HTMLImageElement.prototype.decode = async function () { await native.call(this); await gate; };
  });
  await editor.locator('#draft-image').setInputFiles(pngFile('slow.png'));
  await editor.locator('#apply-design:disabled').waitFor();
  await editor.locator('#draft-image-remove').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  await page.evaluate(() => window.__release());
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal(await editor.locator('#actor-image-status').textContent(), '画像は未登録です。');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readDesign(url)).studio.image, '');
  assert.deepEqual(errors, []);
});

browserTest('undo and redo step through edits across ratios, while typing keeps the field’s own undo', async t => {
  const { page, url, editor, errors, puts } = await fixture(t);
  const before = await readDesign(url);
  await open(page, editor);
  assert.equal(await editor.locator('#undo-design').isDisabled(), true);
  await editorTarget(editor, 'header');
  await editor.locator('#draft-title').pressSequentially('一回の入力');
  await editor.locator('#draft-title').dispatchEvent('change');
  const typed = await editor.locator('#draft-title').inputValue();
  await editor.locator('#preview-width').selectOption('1080x1920');
  await editor.locator('#add-text').click();
  const frame = page.frameLocator(`${ROOT} #design-preview-frame`);
  assert.equal(await frame.locator('.pokome-overlay').count(), 1);
  await editor.locator('#preview-width').selectOption('1280x720');
  await editor.locator('#undo-design').click();
  assert.match(await editor.locator('#preview-width').inputValue(), /^1080x1920$/, 'undoing a portrait edit shows that ratio');
  assert.match(await editor.locator('#design-status').textContent(), /9:16/);
  assert.equal(await frame.locator('.pokome-overlay').count(), 0);
  await editor.locator('#redo-design').click();
  assert.equal(await frame.locator('.pokome-overlay').count(), 1);
  await editor.locator('#target-select').focus();
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await editorTarget(editor, 'header');
  assert.equal(await editor.locator('#draft-title').inputValue(), before.studio.title, 'the typed title was one operation');
  assert.equal(await editor.locator('#undo-design').isDisabled(), true);
  await editor.locator('#target-select').focus();
  await page.keyboard.press('Control+y');
  assert.equal(await editor.locator('#draft-title').inputValue(), typed);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await frame.locator('.pokome-overlay').count(), 1);
  // Discarding ends the history.
  await editor.locator('#discard-design').click(); await editor.locator('#editor-confirm-accept').click();
  assert.deepEqual([await editor.locator('#undo-design').isDisabled(), await editor.locator('#redo-design').isDisabled()], [true, true]);
  // Ctrl+Z in a text field belongs to the field, not to the draft.
  await editor.locator('#add-text').click();
  await editorTarget(editor, 'header');
  await editor.locator('#draft-subtitle').focus(); await page.keyboard.press('Control+z');
  assert.equal(await frame.locator('.pokome-overlay').count(), 1);
  assert.equal(puts.length, 0);
  assert.deepEqual(errors, []);
});

browserTest('one drag is one undo step', async t => {
  const { page, editor, errors } = await fixture(t);
  await open(page, editor);
  await editor.locator('#add-text').click();
  const x = async () => Number(await editor.locator('#overlay-x').inputValue());
  const start = await x();
  const handle = await page.frameLocator(`${ROOT} #design-preview-frame`).locator('.overlay-hit button[data-resize="false"]').boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down();
  for (const step of [10, 20, 40]) await page.mouse.move(handle.x + 5 + step, handle.y + 5);
  await page.mouse.up();
  assert.ok(await x() > start);
  await editor.locator('#undo-design').click();
  assert.equal(await x(), start);
  assert.deepEqual(errors, []);
});

browserTest('the whole design returns to the default in the draft only after confirmation, as one undo step', async t => {
  const item = createOverlay('text', { id: 'portrait-note', text: '縦の文字' });
  const { page, url, editor, errors, puts } = await fixture(t, { design: design => ({ ...design, outputSize: '1080x1920', theme: '.pokome-workspace { color: rgb(1, 2, 3); }',
    studio: { ...design.studio, title: '保存済みの題名' },
    ratios: { ...design.ratios, '9:16': { layout: { panels: { chat: { x: 1, y: 2, w: 50, h: 40 } } }, overlays: { version: 1, items: [item], assets: {} } } } }) });
  const before = await readDesign(url);
  await open(page, editor);
  await editor.locator('#draft-reset').click();
  assert.match(await editor.locator('#editor-confirm-message').textContent(), /出力の大きさ.*テーマCSS.*すべての比率/);
  await editor.locator('#editor-confirm-cancel').click();
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  await editor.locator('#draft-reset').click(); await editor.locator('#editor-confirm-accept').click();
  assert.equal(await editor.locator('#draft-outputSize').inputValue(), '1280x720');
  assert.equal(await editor.locator('#draft-css').inputValue(), '');
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#draft-outputSize').inputValue(), '1080x1920');
  await editor.locator('#redo-design').click();
  assert.deepEqual(await readDesign(url), before); assert.equal(puts.length, 0);
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await readDesign(url), defaultDesign());
  assert.deepEqual(errors, []);
});

browserTest('leaving the page with a changed draft asks the browser to confirm', async t => {
  const { page, editor } = await fixture(t);
  await open(page, editor); await editorTarget(editor, 'footer');
  await editor.locator('#draft-footer').fill('閉じる前の確認');
  const dialog = page.waitForEvent('dialog');
  page.close({ runBeforeUnload: true });
  const shown = await dialog;
  assert.equal(shown.type(), 'beforeunload');
  await shown.dismiss();
});

// Regression (PR #9 review): a 300px dock at 200% zoom leaves 150 CSS pixels.
browserTest('a 150px wide editor keeps every target’s settings within the width', async t => {
  const { page, editor, errors } = await fixture(t, { viewport: { width: 150, height: 700 } });
  await open(page, editor);
  const overflow = () => editor.locator('#design-dialog').evaluate(dialog => {
    const width = dialog.clientWidth;
    return { scroll: dialog.scrollWidth, width, wide: [...dialog.querySelectorAll('*')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.right > width + .5; }).map(element => element.id || element.tagName).slice(0, 10) };
  });
  const views = [['targets']];
  for (const target of ['screen', 'header', 'chat', 'speech', 'actor', 'footer']) views.push([target]);
  for (const [target] of views) {
    if (target !== 'targets') await editorTarget(editor, target);
    const result = await overflow();
    assert.ok(result.scroll <= result.width && result.wide.length === 0, `${target}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(errors, []);
});

// Regression (PR #9 review): applying while a CSS file was still being read lost it.
browserTest('Apply waits for a CSS file being read, and the file then reaches the stored design', async t => {
  const { page, url, editor, errors } = await fixture(t);
  await open(page, editor); await editorThemeCSS(editor);
  await page.evaluate(() => {
    const native = Blob.prototype.text;
    const gate = new Promise(resolve => { window.__releaseCSS = resolve; });
    Blob.prototype.text = async function () { const text = await native.call(this); await gate; return text; };
  });
  const css = '.pokome-workspace .pokome-comment__author { color: #123456; }';
  await editor.locator('#draft-css-file').setInputFiles({ name: 'slow.css', mimeType: 'text/css', buffer: Buffer.from(css) });
  await editor.locator('#apply-design:disabled').waitFor();
  await page.evaluate(() => window.__releaseCSS());
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await editor.locator('#draft-css').inputValue(), css);
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readDesign(url)).theme, css);
  assert.deepEqual(errors, []);
});
