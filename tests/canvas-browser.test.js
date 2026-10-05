import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, editorTarget } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-canvas-'));
  const server = createServer({ customizationDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(page);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url); await appReady(page);
  const editor = page.locator('#design-preview-editor');
  await page.locator('[data-page="studio"]').click(); await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  return { page, editor, url };
}
async function number(editor, id, value) { const input = editor.locator(`#${id}`); await input.fill(String(value)); await input.press('Tab'); }

browserTest('canvas selection is read-only and the first panel edit materializes one undoable draft operation', async t => {
  const { page, editor, url } = await fixture(t), before = await readDesign(url);
  await editorTarget(editor, 'chat');
  assert.equal(await editor.locator('.canvas-target[data-selected=true] .canvas-handle').count(), 8);
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  await number(editor, 'panel-x', 12.25);
  assert.equal(Number(await editor.locator('#panel-x').inputValue()), 12.25);
  assert.deepEqual(await readDesign(url), before);
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  await editor.locator('#redo-design').click();
  await editor.locator('#panel-hidden').check();
  assert.equal(await page.frameLocator('#design-preview-editor #design-preview-frame').locator('.stage-chat').isVisible(), false);
  assert.equal(await editor.locator('.canvas-target[data-target-id=chat]').isVisible(), true);
  await editorTarget(editor, 'actor');
  assert.equal(await editor.locator('.canvas-target[data-target-id=chat]').isVisible(), false);
  await editorTarget(editor, 'chat'); await editor.locator('#panel-hidden').uncheck();
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal((await readDesign(url)).ratios['16:9'].layout.panels.chat.x, 12.25);
});

browserTest('ratio and confirmation size are separate and do not save view changes', async t => {
  const { editor, url } = await fixture(t), before = await readDesign(url);
  assert.equal(await editor.locator('#preview-ratio').inputValue(), '16:9');
  assert.equal(await editor.locator('#preview-width').inputValue(), '1280x720');
  await editor.locator('#preview-ratio').selectOption('9:16');
  assert.deepEqual(await editor.locator('#preview-width option').evaluateAll(options => options.map(o => o.value)), ['1080x1920']);
  await editor.locator('#preview-ratio').selectOption('16:9');
  assert.equal(await editor.locator('#preview-width').inputValue(), '1920x1080');
  await editor.locator('#preview-width').selectOption('640x360');
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  assert.deepEqual(await readDesign(url), before);
});

browserTest('panel pointer gestures start at their rendered rectangle, resize from every edge, and cancel without a save', async t => {
  const { page, editor, url } = await fixture(t), before = await readDesign(url);
  await editorTarget(editor, 'actor');
  await editor.locator('#canvas-snap').uncheck();
  const target = editor.locator('.canvas-target[data-target-id=actor]');
  const rect = await target.boundingBox(), canvas = await editor.locator('#design-preview-frame').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 - canvas.width * .02, rect.y + rect.height / 2);
  await page.mouse.up();
  const moved = await target.boundingBox();
  assert.ok(Math.abs(moved.x - rect.x + canvas.width * .02) < 2, 'first movement uses the displayed origin');
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const handle = await target.locator(`[data-edge=${edge}]`).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 4, handle.y + handle.height / 2 + 4);
    await target.dispatchEvent('pointercancel', { pointerId: 1 });
    assert.equal(await editor.locator('#draft-state').textContent(), '変更なし', `${edge} cancels the materialization too`);
    await page.mouse.up();
  }
  assert.deepEqual(await readDesign(url), before);
});

browserTest('scrolled canvas handles cannot cover the sticky editor toolbar in a narrow dock', async t => {
  const { page, editor } = await fixture(t);
  await page.setViewportSize({ width: 150, height: 1000 });
  await editorTarget(editor, 'actor');
  const result = await editor.locator('#design-dialog').evaluate(dialog => {
    const root = dialog.getRootNode(), bar = root.querySelector('.bar'), hit = root.querySelector('.canvas-target[data-target-id=actor]');
    const handle = hit.querySelector('[data-edge=nw]');
    const before = handle.getBoundingClientRect(), title = bar.getBoundingClientRect();
    dialog.scrollTop += before.top - title.top - 20;
    const rect = handle.getBoundingClientRect();
    return { within: rect.top >= 0 && rect.top < bar.getBoundingClientRect().bottom, coveredByCanvas: root.elementFromPoint(rect.left + 8, rect.top + 8)?.closest('.canvas-target') !== null };
  });
  assert.equal(result.within, true, 'the scenario scrolls a handle into the toolbar area');
  assert.equal(result.coveredByCanvas, false, 'the toolbar paints and receives input above the canvas');
});

browserTest('blank panel numbers keep a standard layout unmaterialized', async t => {
  const { editor, url } = await fixture(t), before = await readDesign(url);
  await editorTarget(editor, 'actor');
  for (const key of ['x', 'y', 'w', 'h', 'z']) {
    const value = await editor.locator(`#panel-${key}`).inputValue();
    await number(editor, `panel-${key}`, '');
    assert.equal(await editor.locator(`#panel-${key}`).inputValue(), value);
    assert.equal(await editor.locator('#draft-state').textContent(), '変更なし');
  }
  assert.deepEqual(await readDesign(url), before);
});

browserTest('west and north panel resize stop at the boundary without moving the opposite edge', async t => {
  const { page, editor } = await fixture(t);
  await editorTarget(editor, 'actor'); await editor.locator('#canvas-snap').uncheck();
  for (const edge of ['w', 'n']) {
    for (const [key, value] of Object.entries({ w: 30, h: 30, x: 20, y: 20 })) await number(editor, `panel-${key}`, value);
    const hit = editor.locator('.canvas-target[data-target-id=actor]'), handle = await hit.locator(`[data-edge=${edge}]`).boundingBox();
    const canvas = await editor.locator('#design-preview-frame').boundingBox();
    await page.mouse.move(handle.x + 8, handle.y + 8); await page.mouse.down();
    await page.mouse.move(handle.x + 8 - (edge === 'w' ? canvas.width * .4 : 0), handle.y + 8 - (edge === 'n' ? canvas.height * .4 : 0)); await page.mouse.up();
    const position = Number(await editor.locator(edge === 'w' ? '#panel-x' : '#panel-y').inputValue());
    const dimension = Number(await editor.locator(edge === 'w' ? '#panel-w' : '#panel-h').inputValue());
    assert.equal(position, 0); assert.equal(position + dimension, 50, `${edge} preserves the opposite edge`);
  }
});
