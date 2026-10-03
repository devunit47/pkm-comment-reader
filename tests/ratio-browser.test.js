import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { defaultTalkLayout } from '../design-model.js';
import { createOverlay } from '../overlay-model.js';
import { chromium, executablePath, browserAvailable, readDesign, saveDesign, saveTalk, waitForDesign, appReady } from './browser-support.js';

// P1-B2: layouts and additions are kept per ratio, and no screen borrows another ratio's.
const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const EDITOR = '#workspace-editor';
const PREVIEW = '#design-preview-editor';

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-ratio-'));
  const server = createServer({ customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(url); await appReady(page);
  return { context, page, url, errors, editor: page.locator(EDITOR), preview: page.locator(PREVIEW) };
}
const panelStyle = (page, selector) => page.locator(`#talk-stage ${selector}`).evaluate(element => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height }));
const stageBox = page => page.locator('#talk-stage').evaluate(stage => { const box = stage.getBoundingClientRect(); return { width: box.width, height: box.height, ratio: stage.dataset.frameRatio, editing: 'frameEditing' in stage.dataset }; });

browserTest('the chosen ratio is edited inside its own frame and saved only to that ratio', async t => {
  const { page, editor, url, errors } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#mode').selectOption('talk');
  assert.equal(await editor.locator('#ratio-fields').isVisible(), true);
  await editor.locator('#ratio').selectOption('9:16');
  await editor.locator('#edit').click();
  const framed = await stageBox(page);
  assert.equal(framed.ratio, '9:16');
  assert.equal(framed.editing, true);
  assert.ok(Math.abs(framed.width / framed.height - 9 / 16) < .01, `framed to 9:16, got ${framed.width}x${framed.height}`);
  // An uncreated portrait ratio starts from the portrait default, not the landscape grid.
  assert.deepEqual(await panelStyle(page, '.stage-chat'), { left: '4%', top: '64%', width: '92%', height: '29%' });
  const move = page.locator('.stage-chat [data-layout-handle] button').first();
  await move.press('ArrowUp'); await move.press('ArrowUp');
  const saved = await waitForDesign(url, design => design.ratios['9:16']?.layout?.panels.chat.y === 60);
  assert.equal(saved.ratios['16:9'], null, 'the landscape ratio is untouched');
  assert.equal(saved.ratios['4:3'], null);
  await page.locator('#layout-session #finish').click();
  // The talk screen previews the output size (1280x720 by default): landscape grid.
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  const landscape = await stageBox(page);
  assert.equal(landscape.ratio, '16:9');
  assert.equal(landscape.editing, false);
  assert.equal(await page.locator('#talk-stage .stage-chat').evaluate(element => element.style.position), '', 'the grid, not the portrait layout');
  assert.deepEqual(errors, []);
});

browserTest('the talk screen follows the output size, framed to its ratio, and survives reload', async t => {
  const { page, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.chat.y = 50;
  await saveTalk(url, { layout: null });
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios, '9:16': { layout: portrait, overlays: { version: 1, items: [createOverlay('text', { id: 'portrait-text', text: '縦だけ' })], assets: {} } } } }));
  await page.locator('[data-page="studio"]').click();
  await page.locator('#output-size').selectOption('1080x1920');
  await waitForDesign(url, design => design.outputSize === '1080x1920');
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  const box = await stageBox(page);
  assert.equal(box.ratio, '9:16');
  assert.ok(Math.abs(box.width / box.height - 9 / 16) < .01);
  assert.equal((await panelStyle(page, '.stage-chat')).top, '50%');
  assert.deepEqual(await page.locator('#talk-stage > .pokome-overlay').allTextContents(), ['縦だけ']);
  await page.reload(); await appReady(page);
  await page.locator('#enter-talk').click();
  assert.equal((await stageBox(page)).ratio, '9:16');
  assert.equal((await panelStyle(page, '.stage-chat')).top, '50%');
  await page.locator('#leave-talk').click();
  await page.locator('[data-page="studio"]').click();
  await page.locator('#output-size').selectOption('1280x720');
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  assert.equal((await stageBox(page)).ratio, '16:9');
  assert.equal(await page.locator('#talk-stage > .pokome-overlay').count(), 0, 'portrait additions stay in 9:16');
  assert.deepEqual(errors, []);
});

browserTest('copying between ratios happens only on request and explains a grid source', async t => {
  const { page, editor, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.header.h = 12;
  const note = createOverlay('text', { id: 'note', text: '横のメモ' });
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios,
    '9:16': { layout: portrait, overlays: { version: 1, items: [], assets: {} } },
    '16:9': { layout: null, overlays: { version: 1, items: [note], assets: {} } } } }));
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#mode').selectOption('talk');
  await editor.locator('#ratio').selectOption('4:3');
  await editor.locator('#copy-ratio summary').click();
  await editor.locator('#copy-source').selectOption('4:3');
  await editor.locator('#copy-ratio-button').click();
  assert.match(await editor.locator('#status').textContent(), /同じ/);
  await editor.locator('#copy-source').selectOption('9:16');
  await editor.locator('#copy-ratio-button').click();
  let design = await waitForDesign(url, value => value.ratios['4:3']?.layout?.panels.header.h === 12);
  assert.deepEqual(design.ratios['4:3'].layout, portrait);
  assert.deepEqual(design.ratios['9:16'].layout, portrait, 'the source is unchanged');
  await editor.locator('#copy-source').selectOption('16:9');
  await editor.locator('#copy-ratio-button').click();
  assert.match(await editor.locator('#status').textContent(), /標準の並び/);
  design = await waitForDesign(url, value => value.ratios['4:3']?.overlays.items[0]?.text === '横のメモ');
  assert.deepEqual(design.ratios['4:3'].layout, portrait, 'a grid source copies only the additions');
  assert.deepEqual(errors, []);
});

browserTest('the stream output uses the ratio closest to its own size and switches on resize', async t => {
  const { context, url, errors } = await fixture(t, { width: 540, height: 960 });
  const portrait = defaultTalkLayout('9:16'); portrait.panels.chat.y = 40;
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios,
    '9:16': { layout: portrait, overlays: { version: 1, items: [createOverlay('text', { id: 'tall', text: '縦の出力' })], assets: {} } } } }));
  const output = await context.newPage();
  await output.goto(`${url}/output.html`);
  await output.locator('#talk-stage > .pokome-overlay').waitFor({ state: 'attached' });
  assert.equal(await output.evaluate(() => document.body.dataset.ratio), '9:16');
  assert.equal(await output.locator('#talk-stage .stage-chat').evaluate(element => element.style.top), '40%');
  await output.setViewportSize({ width: 960, height: 540 });
  await output.waitForFunction(() => document.body.dataset.ratio === '16:9');
  assert.equal(await output.locator('#talk-stage > .pokome-overlay').count(), 0);
  assert.equal(await output.locator('#talk-stage .stage-chat').evaluate(element => element.style.position), '');
  await output.setViewportSize({ width: 720, height: 540 });
  await output.waitForFunction(() => document.body.dataset.ratio === '4:3');
  assert.deepEqual(errors, []);
});

browserTest('the preview shows and edits each ratio separately, with edge guides only in the preview', async t => {
  const { page, preview, url, errors } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  await preview.locator('#open-design-preview').click();
  await page.waitForFunction(root => !document.querySelector(root).shadowRoot.getElementById('apply-design').disabled, PREVIEW);
  const frame = page.frameLocator(`${PREVIEW} #design-preview-frame`);
  assert.equal(await frame.locator('#safe-guides .guide-line').count(), 1);
  assert.equal(await frame.locator('#safe-guides .guide-shade').count(), 0);
  await preview.locator('#add-text').click(); await preview.locator('#overlay-text').fill('横の文字');
  await preview.locator('#preview-width').selectOption('1080x1920');
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === 1920, PREVIEW);
  const viewport = await preview.locator('#preview-viewport').boundingBox();
  assert.ok(viewport.height > viewport.width, 'portrait previews keep their shape');
  // The draw runs on the next frame after the size changes.
  await frame.locator('.pokome-overlay').first().waitFor({ state: 'detached' });
  assert.equal(await frame.locator('.pokome-overlay').count(), 0, '9:16 starts without the 16:9 additions');
  assert.equal(await frame.locator('#talk-stage .stage-chat').evaluate(element => element.style.top), '64%');
  assert.equal(await frame.locator('#safe-guides .guide-shade').count(), 2);
  assert.deepEqual(await frame.locator('#safe-guides .guide-shade').evaluateAll(nodes => nodes.map(node => node.style.height)), ['6%', '10%']);
  await preview.locator('#preview-guides').uncheck();
  assert.equal(await frame.locator('#safe-guides').isHidden(), true);
  await preview.locator('#add-text').click(); await preview.locator('#overlay-text').fill('縦の文字');
  await preview.locator('#preview-width').selectOption('1280x720');
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === 720, PREVIEW);
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentDocument.querySelector('.pokome-overlay')?.textContent === '横の文字', PREVIEW);
  assert.deepEqual(await frame.locator('.pokome-overlay').allTextContents(), ['横の文字']);
  await preview.locator('#apply-design').click();
  await preview.locator('#design-dialog').waitFor({ state: 'hidden' });
  const design = await readDesign(url);
  assert.deepEqual(design.ratios['16:9'].overlays.items.map(item => item.text), ['横の文字']);
  assert.deepEqual(design.ratios['9:16'].overlays.items.map(item => item.text), ['縦の文字']);
  assert.equal(design.ratios['9:16'].layout, null, 'the portrait layout stays at its default');
  assert.equal(design.ratios['4:3'], null);
  // The live talk screen (16:9 output) shows only its own additions and no guides.
  assert.deepEqual(await page.locator('#talk-stage > .pokome-overlay').allTextContents(), ['横の文字']);
  assert.equal(await page.locator('#safe-guides').count(), 0);
  assert.deepEqual(errors, []);
});

// Regression: with 9:16 chosen for editing, the numeric fields and reset changed
// the layout of the output-size ratio (16:9) instead.
browserTest('numeric fields and reset work on the ratio chosen for editing', async t => {
  const { page, editor, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.header.h = 6;
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios, '9:16': { layout: portrait, overlays: { version: 1, items: [], assets: {} } } } }));
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#mode').selectOption('talk');
  await editor.locator('#ratio').selectOption('9:16');
  await editor.locator('.fields summary').click();
  await editor.locator('#panel').selectOption('header');
  assert.equal(await editor.locator('#h').inputValue(), '6', 'the fields show the 9:16 layout');
  await editor.locator('#h').fill('10'); await editor.locator('#h').dispatchEvent('change');
  let design = await waitForDesign(url, value => value.ratios['9:16']?.layout?.panels.header.h === 10);
  assert.equal(design.ratios['16:9'], null);
  await editor.locator('#reset').click();
  design = await waitForDesign(url, value => value.ratios['9:16'] === null);
  assert.equal(design.ratios['16:9'], null);
  assert.deepEqual(errors, []);
});
