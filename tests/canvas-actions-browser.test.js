import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { defaultTalkLayout, withTalk } from '../src/shared/design-model.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, saveDesign, editorTarget, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const ROOT = '#design-preview-editor';
async function fixture(t, seed) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-canvas-actions-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  if (seed) await saveDesign(url, seed);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  await blockExternalFonts(page);
  await page.goto(url); await appReady(page);
  const editor = page.locator(ROOT);
  await page.locator('[data-page="studio"]').click(); await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  return { page, editor, url };
}
const target = (editor, id) => editor.locator(`.canvas-target[data-target-id="${id}"]`);
const value = async (editor, id) => Number(await editor.locator(`#${id}`).inputValue());
async function number(editor, id, next) { await editor.locator(`#${id}`).fill(String(next)); await editor.locator(`#${id}`).dispatchEvent('change'); }
const textSeed = design => withTalk(design, '16:9', { overlays: { version: 1, items: [createOverlay('text', { id: 'note', x: 10, y: 10, w: 20, h: 10 })], assets: {} } });

browserTest('snapping, temporary Alt release and held keys use one undo operation', async t => {
  const { page, editor, url } = await fixture(t, textSeed), before = await readDesign(url);
  await editorTarget(editor, 'note');
  const hit = target(editor, 'note');
  await hit.press('ArrowRight'); assert.equal(await value(editor, 'overlay-x'), 12);
  await editor.locator('#canvas-snap').uncheck();
  await hit.press('ArrowRight'); assert.equal(await value(editor, 'overlay-x'), 13);
  await hit.focus();
  await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight');
  assert.equal(await value(editor, 'overlay-x'), 16);
  await editor.locator('#undo-design').click(); assert.equal(await value(editor, 'overlay-x'), 13);
  await editor.locator('#redo-design').click(); assert.equal(await value(editor, 'overlay-x'), 16);
  await editor.locator('#canvas-snap').check();
  const canvas = await editor.locator('#design-preview-frame').boundingBox();
  let box = await hit.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + canvas.width * .031, box.y + box.height / 2); await page.mouse.up();
  assert.equal(await value(editor, 'overlay-x'), 20);
  box = await hit.boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + canvas.width * .031, box.y + box.height / 2); await page.mouse.up();
  await page.keyboard.up('Alt');
  assert.ok(Math.abs(await value(editor, 'overlay-x') - 23.1) < .2);
  await editor.locator('#undo-design').click(); assert.equal(await value(editor, 'overlay-x'), 20);
  await number(editor, 'overlay-x', 13.25); assert.equal(await value(editor, 'overlay-x'), 13.25, 'numeric input does not snap');
  assert.deepEqual(await readDesign(url), before);
});

browserTest('canvas Delete removes additions only and inputs retain native keyboard editing', async t => {
  const { page, editor } = await fixture(t, textSeed);
  await editorTarget(editor, 'note');
  const input = editor.locator('#overlay-text');
  await input.fill('AB'); await input.press('Home'); await input.press('Delete');
  assert.equal(await input.inputValue(), 'B');
  assert.equal(await target(editor, 'note').count(), 1);
  await input.press('ArrowRight'); assert.equal(await value(editor, 'overlay-x'), 10);
  await input.press('Control+z'); assert.equal(await target(editor, 'note').count(), 1);
  await editor.locator('#overlay-x').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await value(editor, 'overlay-x'), 10);
  await target(editor, 'note').press('Delete'); assert.equal(await target(editor, 'note').count(), 0);
  await editor.locator('#undo-design').click(); assert.equal(await target(editor, 'note').count(), 1);
  await editorTarget(editor, 'chat');
  await target(editor, 'chat').press('Delete');
  assert.equal(await target(editor, 'chat').count(), 1);
  assert.equal(await editor.locator('#panel-hidden').isChecked(), false);
});

browserTest('ratio copy and reset confirm their scope, preserve additions and undo independently', async t => {
  const { editor, url } = await fixture(t, design => {
    const layout = defaultTalkLayout('9:16'); layout.panels.chat.x = 7;
    return withTalk(textSeed(design), '9:16', { layout, actorImage: { mode: 'custom', scale: 140 }, overlays: { version: 1, items: [createOverlay('text', { id: 'portrait', text: '縦の文字' })], assets: {} } });
  });
  const before = await readDesign(url);
  await editorTarget(editor, 'screen');
  await editor.locator('#copy-ratio-source').selectOption('9:16'); await editor.locator('#copy-ratio').click();
  await editor.locator('#editor-confirm-cancel').click();
  assert.equal(await editor.locator('#target-select option[value=note]').count(), 1);
  await editor.locator('#copy-ratio').click(); await editor.locator('#editor-confirm-accept').click();
  assert.equal(await editor.locator('#target-select option[value=portrait]').count(), 1);
  await editorTarget(editor, 'chat'); assert.equal(await value(editor, 'panel-x'), 7);
  await editorTarget(editor, 'actor'); assert.equal(await value(editor, 'actor-scale'), 140);
  await editorTarget(editor, 'screen'); await editor.locator('#reset-ratio').click(); await editor.locator('#editor-confirm-accept').click();
  assert.equal(await editor.locator('#target-select option[value=portrait]').count(), 1, 'reset preserves additions');
  await editorTarget(editor, 'actor'); assert.equal(await editor.locator('#actor-mode').inputValue(), 'theme');
  await editor.locator('#undo-design').click(); assert.equal(await value(editor, 'actor-scale'), 140);
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#target-select option[value=note]').count(), 1);
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  await editor.locator('#preview-ratio').selectOption('9:16'); await editorTarget(editor, 'chat');
  assert.equal(await value(editor, 'panel-x'), 7, 'the source ratio is unchanged');
  assert.deepEqual(await readDesign(url), before);
});

browserTest('moving across equal z values renumbers both kinds and one undo restores the original order', async t => {
  const { editor } = await fixture(t, design => {
    const layout = defaultTalkLayout('9:16');
    for (const panel of Object.values(layout.panels)) panel.z = 1;
    return withTalk(textSeed(design), '16:9', { layout });
  });
  await editorTarget(editor, 'note'); await editor.locator('#canvas-backward').click();
  const overlayZ = await value(editor, 'overlay-z');
  await editorTarget(editor, 'pinned'); assert.ok(await value(editor, 'panel-z') > overlayZ);
  await editor.locator('#undo-design').click(); assert.equal(await value(editor, 'panel-z'), 1);
  await editorTarget(editor, 'note'); assert.equal(await value(editor, 'overlay-z'), 1);
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  await editorTarget(editor, 'pinned'); await editor.locator('#canvas-forward').click();
  assert.ok(await value(editor, 'panel-z') > 1);
  await editor.locator('#undo-design').click(); assert.equal(await value(editor, 'panel-z'), 1);
});

browserTest('Shift corner resize preserves image pixel aspect at landscape and portrait preview sizes', async t => {
  const { page, editor } = await fixture(t);
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  for (const ratio of ['16:9', '9:16']) {
    await editor.locator('#preview-ratio').selectOption(ratio);
    await editor.locator('#overlay-image').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer });
    await editor.locator('#design-status').filter({ hasText: '追加' }).waitFor();
    await editor.locator('#apply-design:not(:disabled)').waitFor();
    const id = await editor.locator('#target-select').inputValue();
    await number(editor, 'overlay-x', 20); await number(editor, 'overlay-y', 20);
    await number(editor, 'overlay-w', 20); await number(editor, 'overlay-h', 30);
    const hit = target(editor, id), before = await hit.boundingBox();
    const handle = await hit.locator('[data-edge=se]').boundingBox();
    await page.keyboard.down('Shift');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2 + 7); await page.mouse.up();
    await page.keyboard.up('Shift');
    const after = await hit.boundingBox();
    assert.ok(after.width > before.width);
    assert.ok(Math.abs(after.width / after.height - before.width / before.height) < .015, ratio);
    await editor.locator('#undo-design').click();
    assert.equal(await value(editor, 'overlay-w'), 20); assert.equal(await value(editor, 'overlay-h'), 30);
  }
});

browserTest('saved addition IDs matching panel or screen names remain separate editing targets', async t => {
  const { editor, url } = await fixture(t, design => withTalk(design, '16:9', {
    overlays: { version: 1, items: ['chat', 'screen', 'footer', 'pinned'].map(id => createOverlay('text', { id, text: `追加-${id}`, x: 50, y: 50, w: 10, h: 10 })), assets: {} },
  }));
  const before = await readDesign(url);
  await editor.locator('#target-select').selectOption({ label: 'コメント欄' });
  assert.equal(await editor.locator('#overlay-text').isVisible(), false, 'the panel does not expose an addition sharing its name');
  const panelX = await value(editor, 'panel-x');
  for (const id of ['chat', 'screen', 'footer', 'pinned']) {
    await editor.locator('#target-select').selectOption({ label: `追加-${id}` });
    assert.equal(await editor.locator('#panel-placement').isVisible(), false);
    const hit = target(editor, `overlay:${id}`);
    assert.equal(await hit.count(), 1);
    await hit.press('ArrowRight'); assert.equal(await value(editor, 'overlay-x'), 52);
    await editor.locator('#overlay-hidden').check(); await editor.locator('#overlay-hidden').uncheck();
    await editor.locator('#canvas-backward').click(); await editor.locator('#undo-design').click();
    await hit.press('Delete');
    assert.equal(await hit.count(), 0);
    await editor.locator('#undo-design').click();
    assert.equal(await hit.count(), 1);
  }
  await editor.locator('#target-select').selectOption({ label: 'コメント欄' });
  assert.equal(await value(editor, 'panel-x'), panelX);
  assert.equal(await editor.locator('.canvas-target').count(), 10);
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  const saved = await readDesign(url);
  assert.deepEqual(saved.ratios['16:9'].overlays.items.map(item => item.id), ['chat', 'screen', 'footer', 'pinned']);
  assert.deepEqual(saved.ratios['16:9'].overlays.items.map(item => item.x), [52, 52, 52, 52]);
  assert.deepEqual(saved.ratios['16:9'].layout, before.ratios['16:9'].layout, 'addition edits never alter panel layout');
});
