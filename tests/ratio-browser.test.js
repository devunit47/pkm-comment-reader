import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { defaultTalkLayout, defaultActorImage, normalizeActorImage, withTalk } from '../src/shared/design-model.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, readDesign, saveDesign, saveTalk, waitForDesign, appReady, applyInEditor, editorThemeCSS, editorTarget, temporaryDataDirectory, talkStage } from './browser-support.js';

// P1-B2: layouts and additions are kept per ratio, and no screen borrows another ratio's.
const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const EDITOR = '#design-preview-editor';
const PREVIEW = '#design-preview-editor';

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-ratio-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport });
  await blockExternalFonts(context);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(url); await appReady(page);
  return { context, page, url, errors, editor: page.locator(EDITOR), preview: page.locator(PREVIEW) };
}
async function openCanvas(page, ratio = '9:16') {
  await page.locator('[data-page="studio"]').click();
  const editor = page.locator(PREVIEW);
  await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editor.locator('#preview-ratio').selectOption(ratio);
  await page.waitForFunction(ratio => { const frame = document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame'); return frame.contentWindow.innerHeight === (ratio === '9:16' ? 1920 : 1080); }, ratio);
  return editor;
}
async function applyCanvas(editor) {
  await editor.locator('#apply-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
}
const panelStyle = (page, selector) => talkStage(page).locator(`#talk-stage ${selector}`).evaluate(element => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height }));
const stageBox = page => talkStage(page).locator('#talk-stage').evaluate(stage => { const box = stage.getBoundingClientRect(); return { width: box.width, height: box.height, ratio: stage.ownerDocument.body.dataset.ratio, editing: 'frameEditing' in stage.dataset }; });

browserTest('the chosen ratio is edited inside its own frame and saved only to that ratio', async t => {
  const { page, url, errors } = await fixture(t);
  const editor = await openCanvas(page);
  const frame = page.frameLocator(`${PREVIEW} #design-preview-frame`);
  const chat = frame.locator('.stage-chat');
  assert.equal(await chat.evaluate(e => e.style.left), '4%');
  assert.equal(await chat.evaluate(e => e.style.width), '92%');
  await editorTarget(editor, 'chat');
  const move = editor.locator('.canvas-target[data-target-id="chat"]');
  await move.press('ArrowDown'); await move.press('ArrowDown');
  assert.equal((await readDesign(url)).ratios['9:16'], null, 'the draft is not saved');
  await applyCanvas(editor);
  const saved = await waitForDesign(url, design => design.ratios['9:16']?.layout?.panels.chat.y > 64);
  assert.equal(saved.ratios['16:9'], null); assert.equal(saved.ratios['4:3'], null);
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  const landscape = await stageBox(page);
  assert.equal(landscape.ratio, '16:9'); assert.equal(landscape.editing, false);
  assert.equal(await talkStage(page).locator('#talk-stage .stage-chat').evaluate(element => element.style.position), '');
  assert.deepEqual(errors, []);
});

browserTest('the talk screen follows the output size, framed to its ratio, and survives reload', async t => {
  const { page, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.chat.y = 50;
  await saveTalk(url, { layout: null });
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios, '9:16': { layout: portrait, overlays: { version: 1, items: [createOverlay('text', { id: 'portrait-text', text: '縦だけ' })], assets: {} } } } }));
  // Read seeded data before opening a draft that later SSE updates would invalidate.
  await page.reload(); await appReady(page);
  await page.locator('[data-page="studio"]').click();
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1080x1920'));
  await waitForDesign(url, design => design.outputSize === '1080x1920');
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  const box = await stageBox(page);
  assert.equal(box.ratio, '9:16');
  assert.ok(Math.abs(box.width / box.height - 9 / 16) < .01);
  assert.equal((await panelStyle(page, '.stage-chat')).top, '50%');
  assert.deepEqual(await talkStage(page).locator('#talk-stage > .pokome-overlay').allTextContents(), ['縦だけ']);
  await page.reload(); await appReady(page);
  await page.locator('#enter-talk').click();
  assert.equal((await stageBox(page)).ratio, '9:16');
  assert.equal((await panelStyle(page, '.stage-chat')).top, '50%');
  await page.locator('#leave-talk').click();
  await page.locator('[data-page="studio"]').click();
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1280x720'));
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  assert.equal((await stageBox(page)).ratio, '16:9');
  assert.equal(await talkStage(page).locator('#talk-stage > .pokome-overlay').count(), 0, 'portrait additions stay in 9:16');
  assert.deepEqual(errors, []);
});

browserTest('the portrait default keeps the speech minimum off the comments on a short talk screen', async t => {
  const { page, url, errors } = await fixture(t, { width: 1280, height: 720 });
  await page.locator('[data-page="studio"]').click();
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1080x1920'));
  await waitForDesign(url, design => design.outputSize === '1080x1920');
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  const boxes = await talkStage(page).locator('#talk-stage').evaluate(stage => Object.fromEntries(['.stage-speech', '.stage-chat', '.stage-footer'].map(selector => {
    const box = stage.querySelector(selector).getBoundingClientRect(); return [selector, { top: box.top, bottom: box.bottom, height: box.height }];
  })));
  assert.ok(boxes['.stage-speech'].height >= 220, 'the speech minimum still applies');
  assert.ok(boxes['.stage-speech'].bottom <= boxes['.stage-chat'].top + 1, `speech ends at ${boxes['.stage-speech'].bottom}, comments start at ${boxes['.stage-chat'].top}`);
  assert.ok(boxes['.stage-chat'].bottom <= boxes['.stage-footer'].top + 1, 'the comments keep their bottom edge');
  assert.ok(boxes['.stage-chat'].height > 100, 'the comments stay usable');
  assert.deepEqual(errors, []);
});

browserTest('a comments panel pushed down by the speech minimum moves from where it is shown', async t => {
  const { page, editor, url, errors } = await fixture(t, { width: 1280, height: 720 });
  await openCanvas(page);
  await editorThemeCSS(editor);
  await editor.locator('#draft-css').fill('.pokome-workspace .stage-speech { min-height: 700px; }');
  await editor.locator('#draft-css').dispatchEvent('change');
  await editorTarget(editor, 'chat');
  await editor.locator('#canvas-snap').uncheck();
  const frame = page.frameLocator(`${PREVIEW} #design-preview-frame`);
  const box = () => frame.locator('#talk-stage .stage-chat').evaluate(element => { const { top, height } = element.getBoundingClientRect(); return { top, height }; });
  const before = await box();
  const handle = await editor.locator('.canvas-target[data-target-id="chat"]').boundingBox();
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x, y + 20, { steps: 4 }); await page.mouse.up();
  const after = await box();
  const scale = (await editor.locator('#design-preview-frame').boundingBox()).width / 1080;
  assert.ok(Math.abs(after.top - before.top - 20 / scale) <= 1, `moved from ${before.top} to ${after.top}`);
  assert.ok(Math.abs(after.height - before.height) <= 1, `height changed from ${before.height} to ${after.height}`);
  await applyCanvas(editor);
  await waitForDesign(url, design => design.ratios['9:16']?.layout?.panels.chat.y > 64);
  assert.deepEqual(errors, []);
});

browserTest('a pushed-down panel moved up into the speech minimum stays put and keeps its height', async t => {
  const { page, editor, url, errors } = await fixture(t, { width: 1280, height: 720 });
  await openCanvas(page);
  await editorThemeCSS(editor);
  await editor.locator('#draft-css').fill('.pokome-workspace .stage-speech { min-height: 700px; }');
  await editor.locator('#draft-css').dispatchEvent('change');
  await editorTarget(editor, 'chat');
  await editor.locator('#canvas-snap').uncheck();
  const frame = page.frameLocator(`${PREVIEW} #design-preview-frame`);
  const box = () => frame.locator('#talk-stage .stage-chat').evaluate(element => { const { top, height } = element.getBoundingClientRect(); return { top, height }; });
  const before = await box();
  const move = editor.locator('.canvas-target[data-target-id="chat"]');
  await move.press('ArrowUp');
  const after = await box();
  assert.ok(Math.abs(after.top - before.top) <= 1 && Math.abs(after.height - before.height) <= 1, `from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  await move.press('ArrowUp'); await move.press('ArrowUp');
  const again = await box();
  assert.ok(Math.abs(again.top - before.top) <= 1 && Math.abs(again.height - before.height) <= 1, `repeated presses: ${JSON.stringify(again)}`);
  // Moving down still works from where it is shown.
  await move.press('ArrowDown');
  const down = await box();
  assert.ok(down.top > before.top && Math.abs(down.height - before.height) <= 1, `down: ${JSON.stringify(down)}`);
  await applyCanvas(editor);
  await waitForDesign(url, design => design.ratios['9:16']?.layout?.panels.chat.y > 64);
  assert.deepEqual(errors, []);
});

browserTest('the preview moves the panels below the speech panel when draft CSS raises its minimum', async t => {
  const { page, preview, errors } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  await preview.locator('#open-design-preview').click();
  await page.waitForFunction(root => !document.querySelector(root).shadowRoot.getElementById('apply-design').disabled, PREVIEW);
  await preview.locator('#preview-ratio').selectOption('9:16');
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === 1920, PREVIEW);
  await editorThemeCSS(preview);
  await preview.locator('#draft-css').fill('.pokome-workspace .stage-speech { min-height: 600px; }');
  const frame = page.frameLocator(`${PREVIEW} #design-preview-frame`);
  // The draft CSS input redraws the preview synchronously.
  const boxes = await frame.locator('#talk-stage').evaluate(stage => Object.fromEntries(['.stage-speech', '.stage-chat'].map(selector => {
    const box = stage.querySelector(selector).getBoundingClientRect(); return [selector, { bottom: box.bottom, top: box.top, height: box.height }];
  })));
  assert.ok(boxes['.stage-speech'].height >= 600, 'the draft CSS applies');
  assert.ok(boxes['.stage-speech'].bottom <= boxes['.stage-chat'].top + 1, `speech ends at ${boxes['.stage-speech'].bottom}, comments start at ${boxes['.stage-chat'].top}`);
  assert.deepEqual(errors, []);
});

browserTest('copying between ratios happens only on request and explains a grid source', async t => {
  const { page, editor, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.header.h = 12;
  const note = createOverlay('text', { id: 'note', text: '横のメモ' });
  const portraitImage = normalizeActorImage({ mode: 'custom', scale: 152, alignY: 'bottom', offsetX: 3.75 });
  const landscapeImage = normalizeActorImage({ mode: 'theme', scale: 110, overflow: true });
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios,
    '9:16': { layout: portrait, overlays: { version: 1, items: [], assets: {} }, actorImage: portraitImage },
    '16:9': { layout: null, overlays: { version: 1, items: [note], assets: {} }, actorImage: landscapeImage } } }));
  await openCanvas(page, '4:3');
  await editorTarget(editor, 'screen');
  await editor.locator('#copy-ratio-source').selectOption('9:16');
  await editor.locator('#copy-ratio').click(); await editor.locator('#editor-confirm-accept').click();
  await applyCanvas(editor);
  let design = await waitForDesign(url, value => value.ratios['4:3']?.layout?.panels.header.h === 12);
  assert.deepEqual(design.ratios['4:3'].layout, portrait);
  assert.deepEqual(design.ratios['9:16'].layout, portrait);
  assert.deepEqual(design.ratios['4:3'].actorImage, portraitImage);
  await openCanvas(page, '4:3'); await editorTarget(editor, 'screen');
  await editor.locator('#copy-ratio-source').selectOption('16:9');
  await editor.locator('#copy-ratio').click();
  assert.match(await editor.locator('#editor-confirm').textContent(), /標準|配置/);
  await editor.locator('#editor-confirm-accept').click(); await applyCanvas(editor);
  design = await waitForDesign(url, value => value.ratios['4:3']?.overlays.items[0]?.text === '横のメモ');
  assert.deepEqual(design.ratios['4:3'].layout, portrait, 'a grid source keeps the target panel positions');
  assert.deepEqual(design.ratios['4:3'].actorImage, landscapeImage);
  assert.deepEqual(design.ratios['9:16'].actorImage, portraitImage);
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
  // Landscape streams are not cropped at the edges, so 16:9 has no guide or toggle.
  assert.equal(await frame.locator('#safe-guides > *').count(), 0);
  assert.equal(await preview.locator('#preview-guides').isHidden(), true);
  await preview.locator('#add-text').click(); await preview.locator('#overlay-text').fill('横の文字');
  await preview.locator('#preview-ratio').selectOption('9:16');
  await page.waitForFunction(root => document.querySelector(root).shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === 1920, PREVIEW);
  const viewport = await preview.locator('#preview-viewport').boundingBox();
  assert.ok(viewport.height > viewport.width, 'portrait previews keep their shape');
  // The draw runs on the next frame after the size changes.
  await frame.locator('.pokome-overlay').first().waitFor({ state: 'detached' });
  assert.equal(await frame.locator('.pokome-overlay').count(), 0, '9:16 starts without the 16:9 additions');
  // At 1920px tall the speech minimum fits, so the comments sit at their saved 64%.
  assert.equal(await frame.locator('#talk-stage .stage-chat').evaluate(element => { const stage = element.closest('#talk-stage').getBoundingClientRect(); return Math.round((element.getBoundingClientRect().top - stage.top) / stage.height * 100); }), 64);
  assert.equal(await preview.locator('#preview-guides').isVisible(), true);
  assert.equal(await frame.locator('#safe-guides .guide-shade').count(), 2);
  assert.deepEqual(await frame.locator('#safe-guides .guide-shade').evaluateAll(nodes => nodes.map(node => node.style.height)), ['6%', '10%']);
  await preview.locator('#preview-guides').uncheck();
  assert.equal(await frame.locator('#safe-guides').isHidden(), true);
  await preview.locator('#add-text').click(); await preview.locator('#overlay-text').fill('縦の文字');
  await preview.locator('#preview-ratio').selectOption('16:9');
  assert.equal(await frame.locator('#safe-guides > *').count(), 0);
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
  assert.deepEqual(await talkStage(page).locator('#talk-stage > .pokome-overlay').allTextContents(), ['横の文字']);
  assert.equal(await page.locator('#safe-guides').count(), 0);
  assert.deepEqual(errors, []);
});

// Regression: with 9:16 chosen for editing, the numeric fields and reset changed
// the layout of the output-size ratio (16:9) instead.
browserTest('numeric fields and reset work on the ratio chosen for editing', async t => {
  const { page, editor, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.header.h = 6;
  await saveDesign(url, design => ({ ...design, ratios: { ...design.ratios, '9:16': { layout: portrait, overlays: { version: 1, items: [], assets: {} } } } }));
  await openCanvas(page); await editorTarget(editor, 'header');
  assert.equal(await editor.locator('#panel-h').inputValue(), '6', 'the fields show the 9:16 layout');
  await editor.locator('#panel-h').fill('10'); await editor.locator('#panel-h').dispatchEvent('change');
  await applyCanvas(editor);
  let design = await waitForDesign(url, value => value.ratios['9:16']?.layout?.panels.header.h === 10);
  assert.equal(design.ratios['16:9'], null);
  await openCanvas(page); await editorTarget(editor, 'screen');
  await editor.locator('#reset-ratio').click(); await editor.locator('#editor-confirm-accept').click();
  await applyCanvas(editor);
  design = await waitForDesign(url, value => value.ratios['9:16'] === null);
  assert.equal(design.ratios['16:9'], null);
  assert.deepEqual(errors, []);
});

browserTest('preview relayout preserves a focused panel number until it is committed', async t => {
  const { page, editor, url, errors } = await fixture(t);
  await openCanvas(page); await editorTarget(editor, 'header');
  const field = editor.locator('#panel-h');
  const transform = await editor.locator('#design-preview-frame').evaluate(frame => frame.style.transform);
  await field.fill('10');
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForFunction(before => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').style.transform !== before, transform);
  assert.equal(await field.evaluate(element => element.getRootNode().activeElement === element), true);
  assert.equal(await field.inputValue(), '10', 'a background relayout must not discard uncommitted input');
  await field.dispatchEvent('change');
  await field.fill('200'); await field.dispatchEvent('change');
  assert.equal(await field.inputValue(), '98', 'committing still clamps a focused field to the canvas');
  await field.fill('10'); await field.dispatchEvent('change');
  await applyCanvas(editor);
  const design = await waitForDesign(url, value => value.ratios['9:16']?.layout?.panels.header.h === 10);
  assert.equal(design.ratios['16:9'], null);
  assert.deepEqual(errors, []);
});

browserTest('normal panel edits preserve actor placement and layout reset clears only that ratio placement', async t => {
  const { page, editor, url, errors } = await fixture(t);
  const portrait = defaultTalkLayout('9:16'); portrait.panels.header.h = 6;
  const actorImage = normalizeActorImage({ mode: 'custom', scale: 175, alignX: 'left', alignY: 'bottom', offsetY: 2.125, overflow: true });
  const otherImage = normalizeActorImage({ mode: 'theme', scale: 125, offsetX: -3.5 });
  const note = createOverlay('text', { id: 'keep-note', text: '配置を戻しても残す' });
  await saveDesign(url, design => withTalk(withTalk(design, '9:16', { layout: portrait, actorImage, overlays: { version: 1, items: [note], assets: {} } }), '4:3', { actorImage: otherImage }));
  await openCanvas(page); await editorTarget(editor, 'header');
  await editor.locator('#panel-h').fill('10'); await editor.locator('#panel-h').dispatchEvent('change');
  await applyCanvas(editor);
  let design = await waitForDesign(url, value => value.ratios['9:16']?.layout?.panels.header.h === 10);
  assert.deepEqual(design.ratios['9:16'].actorImage, actorImage);
  assert.deepEqual(design.ratios['9:16'].overlays.items, [note]);
  await openCanvas(page); await editorTarget(editor, 'screen');
  await editor.locator('#reset-ratio').click(); await editor.locator('#editor-confirm-accept').click();
  await applyCanvas(editor);
  design = await waitForDesign(url, value => value.ratios['9:16']?.layout === null && value.ratios['9:16'].actorImage.mode === 'theme');
  assert.deepEqual(design.ratios['9:16'].actorImage, defaultActorImage());
  assert.deepEqual(design.ratios['9:16'].overlays.items, [note]);
  assert.deepEqual(design.ratios['4:3'].actorImage, otherImage);
  assert.equal(design.ratios['16:9'], null);
  assert.deepEqual(errors, []);
});
