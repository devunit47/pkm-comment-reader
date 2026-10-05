import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { chromium, executablePath, browserAvailable, readDesign, saveDesign, appReady, blockExternalFonts, editorTarget, closeEditor } from './browser-support.js';

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
