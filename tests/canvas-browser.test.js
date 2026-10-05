import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, editorTarget, editorThemeCSS } from './browser-support.js';

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
  await editorTarget(editor, 'actor');
  for (const snap of [false, true]) for (const extent of [30, 31, 31.5]) for (const edge of ['w', 'n']) {
    await editor.locator('#canvas-snap').setChecked(snap);
    for (const [key, value] of Object.entries({ w: extent, h: extent, x: 20, y: 20 })) await number(editor, `panel-${key}`, value);
    const hit = editor.locator('.canvas-target[data-target-id=actor]'), handle = await hit.locator(`[data-edge=${edge}]`).boundingBox();
    const canvas = await editor.locator('#design-preview-frame').boundingBox();
    await page.mouse.move(handle.x + 8, handle.y + 8); await page.mouse.down();
    await page.mouse.move(handle.x + 8 - (edge === 'w' ? canvas.width * .4 : 0), handle.y + 8 - (edge === 'n' ? canvas.height * .4 : 0)); await page.mouse.up();
    const position = Number(await editor.locator(edge === 'w' ? '#panel-x' : '#panel-y').inputValue());
    const dimension = Number(await editor.locator(edge === 'w' ? '#panel-w' : '#panel-h').inputValue());
    assert.equal(position, 0); assert.equal(position + dimension, 20 + extent, `${edge}, snap=${snap}, extent=${extent} preserves the opposite edge`);
  }
});

browserTest('returning a drag to its start restores geometry and keeps only earlier history', async t => {
  const { page, editor } = await fixture(t);
  await editor.locator('#canvas-snap').uncheck();
  async function returnGesture(id, prefix) {
    const hit = editor.locator(`.canvas-target[data-target-id="${id}"]`);
    const geometry = async () => Promise.all(['x', 'y', 'w', 'h'].map(key => editor.locator(`#${prefix}-${key}`).inputValue()));
    for (const edge of ['', 'se']) {
      const before = await geometry(), box = await (edge ? hit.locator('[data-edge=se]') : hit).boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x - 20, y - 10);
      assert.notDeepEqual(await geometry(), before, 'the gesture first changes geometry');
      await page.mouse.move(x, y); await page.mouse.up();
      assert.deepEqual(await geometry(), before, `${id} ${edge || 'move'} returns to the start`);
    }
  }
  await editorTarget(editor, 'actor');
  await returnGesture('actor', 'panel');
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし', 'a standard layout stays unmaterialized');
  assert.equal(await editor.locator('#undo-design').isDisabled(), true);
  await editor.locator('#add-text').click();
  const id = await editor.locator('#target-select').inputValue();
  await returnGesture(id, 'overlay');
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator(`.canvas-target[data-target-id="${id}"]`).count(), 0, 'one undo removes the earlier addition');
  assert.equal(await editor.locator('#undo-design').isDisabled(), true);
  await editorTarget(editor, 'actor'); await number(editor, 'panel-x', 10);
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editorTarget(editor, 'actor');
  await returnGesture('actor', 'panel');
  assert.equal(await editor.locator('#draft-state').textContent(), '変更なし', 'a saved layout also returns unchanged');
  assert.equal(await editor.locator('#undo-design').isDisabled(), true);
});

for (const method of ['pointer', 'keyboard', 'number']) browserTest(`east and south panel ${method} resize keeps its origin at the canvas boundary`, async t => {
  const { page, editor } = await fixture(t);
  await editorTarget(editor, 'actor');
  for (const snap of [false, true]) for (const origin of [60, 60.5]) for (const edge of ['e', 's']) {
    await editor.locator('#canvas-snap').setChecked(snap);
    for (const [key, value] of Object.entries({ w: 30, h: 30, x: origin, y: origin })) await number(editor, `panel-${key}`, value);
    const hit = editor.locator('.canvas-target[data-target-id=actor]');
    if (method === 'pointer') {
      const handle = await hit.locator(`[data-edge=${edge}]`).boundingBox(), canvas = await editor.locator('#design-preview-frame').boundingBox();
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + (edge === 'e' ? canvas.width * .2 : 0), y + (edge === 's' ? canvas.height * .2 : 0)); await page.mouse.up();
    } else if (method === 'keyboard') {
      for (let i = 0; i < 20; i++) await hit.press(edge === 'e' ? 'Shift+ArrowRight' : 'Shift+ArrowDown');
    } else await number(editor, edge === 'e' ? 'panel-w' : 'panel-h', 50);
    const position = Number(await editor.locator(edge === 'e' ? '#panel-x' : '#panel-y').inputValue());
    const dimension = Number(await editor.locator(edge === 'e' ? '#panel-w' : '#panel-h').inputValue());
    assert.equal(position, origin, `${edge}, snap=${snap}, origin=${origin} keeps the opposite edge`);
    assert.equal(dimension, 100 - origin, `${edge} stops at the canvas edge`);
  }
});

for (const kind of ['panel', 'addition']) browserTest(`hidden ${kind} selection stays aligned with its visible rectangle after preview scrolling`, async t => {
  const { page, editor } = await fixture(t);
  await editor.locator('#preview-width').selectOption('640x360');
  await page.waitForFunction(() => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').contentWindow.innerWidth === 640);
  await editorThemeCSS(editor);
  await editor.locator('#draft-css').fill('.pokome-workspace .stage-grid::after { content: ""; position: absolute; left: 900px; top: 500px; width: 1px; height: 1px; }');
  await editor.locator('#draft-css').dispatchEvent('change');
  let id = 'actor', prefix = 'panel';
  if (kind === 'addition') {
    await editor.locator('#add-text').click(); id = await editor.locator('#target-select').inputValue(); prefix = 'overlay';
  } else await editorTarget(editor, id);
  for (const [key, value] of Object.entries({ w: 25, h: 30, x: 55, y: 10 })) await number(editor, `${prefix}-${key}`, value);
  const frame = page.frameLocator('#design-preview-frame'), stage = frame.locator('#talk-stage');
  const scroll = await stage.evaluate(stage => { stage.scrollLeft = 40; stage.scrollTop = 60; return [stage.scrollLeft, stage.scrollTop]; });
  assert.deepEqual(scroll, [40, 60], 'the fixture scrolls in both directions');
  const element = frame.locator(kind === 'panel' ? '.stage-actor' : `.pokome-overlay[data-overlay-id="${id}"]`);
  const expected = await element.boundingBox();
  await editor.locator(`#${prefix}-hidden`).check();
  await editorTarget(editor, 'screen'); await editorTarget(editor, id);
  const actual = await editor.locator(`.canvas-target[data-target-id="${id}"]`).boundingBox();
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1, `${key} stays aligned: ${actual[key]} versus ${expected[key]}`);
});
