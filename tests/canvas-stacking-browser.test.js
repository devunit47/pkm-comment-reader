import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { chromium, executablePath, browserAvailable, saveDesign, appReady, blockExternalFonts, closeEditor, uploadDesignImage } from './browser-support.js';

const ids = ['header', 'chat', 'speech', 'actor', 'footer'];
// Hit testing reports the actual browser paint order, including ancestor
// stacking contexts. Make normally click-through additions visible to it.
async function paintOrder(stage, panelId) {
  return stage.evaluate((stage, panelId) => {
    const doc = stage.ownerDocument;
    const targets = [...stage.querySelectorAll('.pokome-panel,.pokome-overlay')];
    for (const item of targets) item.style.pointerEvents = 'auto';
    const box = (panelId ? stage.querySelector(`[data-panel-type="${panelId}"]`) : stage).getBoundingClientRect();
    const seen = new Set();
    const result = [];
    for (const element of doc.elementsFromPoint(box.left + box.width * .4, box.top + box.height * .4)) {
      const target = element.closest('.pokome-panel,.pokome-overlay');
      if (!target || !stage.contains(target) || seen.has(target)) continue;
      seen.add(target); result.push(target.dataset.overlayId || target.dataset.panelType);
    }
    for (const item of targets) item.style.removeProperty('pointer-events');
    return result;
  }, panelId);
}

test('panels and additions share paint order in the canvas, talk and reloaded output', { skip: !browserAvailable }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-stacking-'));
  const server = createServer({ customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await blockExternalFonts(page);
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const ref = (await uploadDesignImage(url, Buffer.from(bytes, 'base64'))).ref;
  const output = await context.newPage();
  await blockExternalFonts(output);
  await output.setViewportSize({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  output.on('pageerror', error => errors.push(error.message));
  for (const [name, chatZ, overlayZ, expected] of [
    ['same z', 3, 3, ['second', 'first', 'footer', 'actor', 'speech', 'chat', 'header']],
    ['addition behind chat', 4, 2, ['chat', 'footer', 'actor', 'speech', 'header', 'second', 'first']],
    ['addition ahead of chat', 2, 4, ['second', 'first', 'footer', 'actor', 'speech', 'header', 'chat']],
  ]) {
    await saveDesign(url, design => ({ ...design, studio: { ...design.studio, layout: 'left' }, ratios: { ...design.ratios, '16:9': {
      layout: { version: 1, panels: Object.fromEntries(ids.map(id => [id, { x: 20, y: 20, w: 50, h: 50, z: id === 'chat' ? chatZ : 3, hidden: false }])) },
      overlays: { version: 1, items: ['first', 'second'].map(id => createOverlay(id === 'first' ? 'image' : 'text', { id, assetId: 'red', text: id, x: 20, y: 20, w: 50, h: 50, z: overlayZ })), assets: { red: ref } },
    } } }));
    await page.goto(url); await appReady(page);
    await page.locator('[data-page="studio"]').click();
    const editor = page.locator('#design-preview-editor');
    await editor.locator('#open-design-preview').click();
    await editor.locator('#apply-design:not(:disabled)').waitFor();
    const previewStage = page.frameLocator('#design-preview-frame').locator('#talk-stage');
    await previewStage.locator('[data-overlay-id="second"]').waitFor({ state: 'attached' });
    assert.deepEqual(await paintOrder(previewStage), expected, `${name}: canvas`);
    await closeEditor(editor);
    await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
    assert.deepEqual(await paintOrder(page.locator('#talk-stage')), expected, `${name}: talk`);
    await output.goto(`${url}/output.html`);
    await output.locator('[data-overlay-id="second"]').waitFor({ state: 'attached' });
    await output.reload();
    await output.locator('[data-overlay-id="second"]').waitFor({ state: 'attached' });
    assert.deepEqual(await paintOrder(output.locator('#talk-stage')), expected, `${name}: reloaded output`);
  }
  // A stylesheet layout still has the model's default panel z=1. Merely
  // previewing it must not put a z=0 addition in front or materialize a layout.
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios, '16:9': {
    layout: null, overlays: { version: 1, items: [createOverlay('text', { id: 'behind', text: '背景の文字', x: 0, y: 0, w: 100, h: 100, z: 0 })], assets: {} },
  } } }));
  await page.goto(url); await appReady(page);
  await page.locator('[data-page="studio"]').click();
  const editor = page.locator('#design-preview-editor');
  await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  const previewStage = page.frameLocator('#design-preview-frame').locator('#talk-stage');
  await previewStage.locator('[data-overlay-id="behind"]').waitFor({ state: 'attached' });
  assert.deepEqual(await paintOrder(previewStage, 'chat'), ['chat', 'behind'], 'default layout: canvas');
  await closeEditor(editor);
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  assert.deepEqual(await paintOrder(page.locator('#talk-stage'), 'chat'), ['chat', 'behind'], 'default layout: talk');
  await output.goto(`${url}/output.html`); await output.reload();
  await output.locator('[data-overlay-id="behind"]').waitFor({ state: 'attached' });
  assert.deepEqual(await paintOrder(output.locator('#talk-stage'), 'chat'), ['chat', 'behind'], 'default layout: reloaded output');
  assert.deepEqual(errors, []);
});
