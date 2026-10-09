import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { defaultTalkLayout, normalizeActorImage, withTalk } from '../src/shared/design-model.js';
import { createOverlay } from '../src/shared/overlay-model.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, uploadDesignImage, saveDesign, appReady, applyInEditor, temporaryDataDirectory, talkStage } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, viewport = { width: 1280, height: 720 }) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-actor-image-'));
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
  return { context, page, url, errors };
}
// Self-made solid PNGs with an optional transparent border reveal the browser's
// painted contain bounds, without external images or a PNG decoding dependency.
async function imageRef(page, url, width, height, inset = 0, color = '#fd01df') {
  const data = await page.evaluate(({ width, height, inset, color }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color;
    ctx.fillRect(inset, inset, width - 2 * inset, height - 2 * inset);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height, inset, color });
  return (await uploadDesignImage(url, Buffer.from(data, 'base64'))).ref;
}
function actorOnlyLayout(panel = { x: 20, y: 10, w: 50, h: 60 }) {
  const layout = defaultTalkLayout('9:16');
  for (const item of Object.values(layout.panels)) item.hidden = true;
  layout.panels.actor = { ...panel, z: 3, hidden: false };
  return layout;
}
const custom = value => normalizeActorImage({ mode: 'custom', ...value });
async function outputPage(context, url, query = '') {
  const output = await context.newPage(); output.setDefaultTimeout(8000);
  await output.goto(`${url}/output.html${query}`);
  await output.locator('#talk-stage').waitFor();
  return output;
}
async function waitActor(page, settings) {
  await page.waitForFunction(settings => {
    const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
    const stage = doc.getElementById('talk-stage'), image = doc.getElementById('actor-image');
    return stage?.dataset.actorImage === 'custom' && image?.complete && image.naturalWidth > 0 &&
      stage.dataset.actorImageOverflow === String(settings.overflow) &&
      stage.style.getPropertyValue('--actor-image-size') === `${settings.scale}%` &&
      stage.style.getPropertyValue('--actor-image-position') === `${settings.alignX} ${settings.alignY}` &&
      stage.style.getPropertyValue('--actor-image-left') === `${(100 - settings.scale) * ({ left: 0, center: .5, right: 1 }[settings.alignX]) + settings.offsetX}%` &&
      stage.style.getPropertyValue('--actor-image-top') === `${(100 - settings.scale) * ({ top: 0, center: .5, bottom: 1 }[settings.alignY]) + settings.offsetY}%`;
  }, settings);
}
async function paintedBounds(page, color = [253, 1, 223]) {
  const png = await page.locator('#talk-stage').screenshot();
  return page.evaluate(async ({ png, color }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let left = image.width, top = image.height, right = -1, bottom = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (color.every((value, j) => Math.abs(pixels[i + j] - value) <= 2)) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return right < left ? null : { left, top, right: right + 1, bottom: bottom + 1 };
  }, { png: png.toString('base64'), color });
}
function expectedBounds(panel, settings, width, height, inset, canvas = [1280, 720]) {
  const px = panel.x / 100 * canvas[0], py = panel.y / 100 * canvas[1];
  const pw = panel.w / 100 * canvas[0], ph = panel.h / 100 * canvas[1];
  const factor = Math.min(pw / width, ph / height) * settings.scale / 100;
  const ax = { left: 0, center: .5, right: 1 }[settings.alignX], ay = { top: 0, center: .5, bottom: 1 }[settings.alignY];
  const left = px + (pw - width * factor) * ax + pw * settings.offsetX / 100 + inset * factor;
  const top = py + (ph - height * factor) * ay + ph * settings.offsetY / 100 + inset * factor;
  const clip = settings.overflow ? [0, 0, ...canvas] : [px, py, px + pw, py + ph];
  return { left: Math.max(clip[0], left), top: Math.max(clip[1], top), right: Math.min(clip[2], left + (width - 2 * inset) * factor), bottom: Math.min(clip[3], top + (height - 2 * inset) * factor) };
}
function nearBounds(actual, expected, message) {
  assert.ok(actual, `${message}: no painted pixels`);
  // Transparent-edge interpolation can consume a couple of fully solid pixels at 200%.
  for (const edge of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(actual[edge] - expected[edge]) <= 3, `${message} ${edge}: ${actual[edge]} versus ${expected[edge]}`);
}
async function screenshotDifference(page, before, after, panel) {
  return page.evaluate(async ({ before, after, panel }) => {
    const pixels = async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { width: image.width, data: ctx.getImageData(0, 0, image.width, image.height).data };
    };
    const a = await pixels(before), b = await pixels(after);
    let count = 0, outside = 0, outsideMax = 0, left = a.width, top = Infinity, right = 0, bottom = 0, max = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const delta = Math.max(...[0, 1, 2, 3].map(j => Math.abs(a.data[i + j] - b.data[i + j])));
      if (!delta) continue;
      const x = i / 4 % a.width, y = Math.floor(i / 4 / a.width);
      count++; max = Math.max(max, delta); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      if (x < Math.floor(panel.x) || x >= Math.ceil(panel.x + panel.w) || y < Math.floor(panel.y) || y >= Math.ceil(panel.y + panel.h)) {
        outsideMax = Math.max(outsideMax, delta);
        if (delta > 2) outside++;
      }
    }
    return { count, outside, outsideMax, max, left, top, right, bottom };
  }, { before: before.toString('base64'), after: after.toString('base64'), panel });
}

browserTest('actor pixels follow contain scaling and every alignment, including transparency, image replacement and panel resize', async t => {
  const { context, page, url, errors } = await fixture(t);
  const portrait = await imageRef(page, url, 120, 240, 8);
  const landscape = await imageRef(page, url, 300, 120);
  let layout = actorOnlyLayout();
  const theme = '.pokome-workspace .stage-actor img { width:17% !important; height:33% !important; transform:scale(3) !important; object-fit:fill !important; object-position:left top !important; left:29% !important; top:41% !important; } .pokome-workspace { --actor-image-size:7% !important; overflow:visible !important; }';
  await saveDesign(url, design => withTalk({ ...design, theme, studio: { ...design.studio, source: 'image', image: portrait, actorAppearance: 'none' } }, '16:9', { layout, actorImage: custom({ scale: 100 }) }));
  const output = await outputPage(context, url);
  for (const scale of [100, 110, 200]) for (const alignX of ['left', 'center', 'right']) for (const alignY of ['top', 'center', 'bottom']) {
    const settings = custom({ scale, alignX, alignY, overflow: true });
    await saveDesign(url, design => withTalk(design, '16:9', { actorImage: settings }));
    await waitActor(output, settings);
    nearBounds(await paintedBounds(output), expectedBounds(layout.panels.actor, settings, 120, 240, 8), `${scale} ${alignX}/${alignY}`);
  }
  const offset = custom({ scale: 200, alignX: 'right', alignY: 'bottom', offsetX: -12.5, offsetY: 25, overflow: false });
  await saveDesign(url, design => withTalk(design, '16:9', { actorImage: offset }));
  await waitActor(output, offset);
  nearBounds(await paintedBounds(output), expectedBounds(layout.panels.actor, offset, 120, 240, 8), 'offset with panel clipping');
  const settings = custom({ scale: 110, alignX: 'right', alignY: 'bottom', offsetX: 10, offsetY: -5, overflow: true });
  await saveDesign(url, design => withTalk({ ...design, studio: { ...design.studio, image: landscape } }, '16:9', { actorImage: settings }));
  await waitActor(output, settings);
  await output.waitForFunction(() => document.getElementById('actor-image').naturalWidth === 300);
  nearBounds(await paintedBounds(output), expectedBounds(layout.panels.actor, settings, 300, 120, 0), 'landscape replacement');
  layout = actorOnlyLayout({ x: 10, y: 20, w: 70, h: 35 });
  await saveDesign(url, design => withTalk(design, '16:9', { layout }));
  await output.waitForFunction(() => document.querySelector('.stage-actor').style.width === '70%');
  nearBounds(await paintedBounds(output), expectedBounds(layout.panels.actor, settings, 300, 120, 0), 'resized panel');
  assert.equal(await output.locator('#actor-image').evaluate(image => getComputedStyle(image).transform), 'none');
  assert.deepEqual(errors, []);
});

browserTest('theme placement restores important theme styles and keeps saved custom values without an image', async t => {
  const { context, page, url, errors } = await fixture(t);
  const ref = await imageRef(page, url, 120, 240);
  const settings = custom({ scale: 177, alignY: 'bottom', offsetY: 2.5, overflow: true });
  const theme = '.pokome-workspace .stage-actor img { object-fit:cover !important; transform:scale(1.3) !important; } .pokome-workspace .stage-actor { overflow:visible !important; }';
  await saveDesign(url, design => withTalk({ ...design, theme, studio: { ...design.studio, source: 'image', image: ref } }, '16:9', { actorImage: settings }));
  const output = await outputPage(context, url);
  await waitActor(output, settings);
  for (const studio of [{ source: 'image', image: '' }, { source: 'space', image: ref }]) {
    await saveDesign(url, design => ({ ...design, studio: { ...design.studio, ...studio } }));
    await output.waitForFunction(() => !document.getElementById('talk-stage').hasAttribute('data-actor-image'));
    assert.equal(await output.locator('#talk-stage').evaluate(stage => [...stage.style].some(name => name.startsWith('--actor-image-'))), false);
  }
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, source: 'image', image: ref } }));
  await waitActor(output, settings);
  await saveDesign(url, design => withTalk(design, '16:9', { actorImage: { ...settings, mode: 'theme' } }));
  await output.waitForFunction(() => !document.getElementById('talk-stage').hasAttribute('data-actor-image'));
  assert.deepEqual(await output.locator('#actor-image').evaluate(image => { const style = getComputedStyle(image); return { fit: style.objectFit, transform: style.transform }; }), { fit: 'cover', transform: 'matrix(1.3, 0, 0, 1.3, 0, 0)' });
  assert.equal(await output.locator('#talk-stage').evaluate(stage => [...stage.style].some(name => name.startsWith('--actor-image-'))), false);
  assert.deepEqual(errors, []);
});

browserTest('live, output and preview choose their own actor ratio and follow saved changes', async t => {
  const { context, page, url, errors } = await fixture(t);
  const ref = await imageRef(page, url, 120, 240);
  const ratios = { '16:9': custom({ scale: 110 }), '9:16': custom({ scale: 150, alignY: 'bottom' }), '4:3': custom({ scale: 200, alignX: 'right' }) };
  await saveDesign(url, design => {
    let next = { ...design, studio: { ...design.studio, source: 'image', image: ref } };
    for (const [ratio, actorImage] of Object.entries(ratios)) next = withTalk(next, ratio, { actorImage });
    return next;
  });
  await page.reload(); await appReady(page);
  const output = await outputPage(context, url);
  const cases = [
    ['16:9', '1280x720', { width: 1280, height: 720 }],
    ['9:16', '1080x1920', { width: 540, height: 960 }],
    ['4:3', '1440x1080', { width: 720, height: 540 }],
  ];
  for (const [ratio, size, viewport] of cases) {
    await page.locator('[data-page="studio"]').click(); await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption(size));
    await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
    await waitActor(page, ratios[ratio]);
    await output.setViewportSize(viewport); await waitActor(output, ratios[ratio]);
    await page.locator('#leave-talk').click();
  }
  await page.locator('[data-page="studio"]').click(); await page.locator('#open-design-preview').click();
  const frame = page.frameLocator('#design-preview-frame');
  for (const [ratio, size] of cases) {
    await page.locator('#preview-ratio').selectOption(ratio);
    await page.locator('#preview-width').selectOption(size);
    await page.waitForFunction(scale => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').contentDocument?.getElementById('talk-stage')?.style.getPropertyValue('--actor-image-size') === `${scale}%`, ratios[ratio].scale);
    assert.equal(await frame.locator('#talk-stage').evaluate(stage => stage.style.getPropertyValue('--actor-image-position')), `${ratios[ratio].alignX} ${ratios[ratio].alignY}`);
  }
  await page.locator('#cancel-design').click();
  ratios['4:3'] = custom({ scale: 163, alignY: 'bottom', offsetY: 4.25 });
  await saveDesign(url, design => withTalk(design, '4:3', { actorImage: ratios['4:3'] }));
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  await waitActor(page, ratios['4:3']); await waitActor(output, ratios['4:3']);
  assert.deepEqual(errors, []);
});

browserTest('allowing image overflow keeps the default decoration and caption clipped without changing any panel geometry', async t => {
  const { context, page, url, errors } = await fixture(t);
  const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; return canvas.toDataURL('image/png').split(',')[1]; });
  const ref = (await uploadDesignImage(url, Buffer.from(data, 'base64'))).ref;
  const panelBoxes = stage => Object.fromEntries(['.stage-header', '.stage-chat', '.stage-speech', '.stage-actor', '.stage-footer'].map(selector => {
    const rect = stage.querySelector(selector).getBoundingClientRect(); return [selector, { x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
  }));
  const output = await outputPage(context, url);
  // The first snapshot must not add comments between the two screenshots.
  await output.locator('#stage-count').filter({ hasText: '12 COMMENTS' }).waitFor();
  for (const theme of ['mint', 'rose', 'violet', 'paper']) for (const layout of [null, actorOnlyLayout({ x: 10, y: 30, w: 70, h: 14 }), actorOnlyLayout({ x: 10, y: 30, w: 70, h: 5 })]) {
    const settings = custom({ scale: 200, overflow: false });
    await saveDesign(url, design => withTalk({ ...design, studio: { ...design.studio, theme, source: 'image', image: ref } }, '16:9', { layout, actorImage: settings }));
    await waitActor(output, settings);
    await output.waitForFunction(({ theme, absolute }) => document.getElementById('talk-stage').dataset.theme === theme && (document.querySelector('.stage-actor').style.position === 'absolute') === absolute, { theme, absolute: !!layout });
    const beforeBoxes = await output.locator('#talk-stage').evaluate(panelBoxes);
    const before = await output.locator('#talk-stage').screenshot();
    await saveDesign(url, design => withTalk(design, '16:9', { actorImage: { ...settings, overflow: true } }));
    await output.waitForFunction(() => document.getElementById('talk-stage').dataset.actorImageOverflow === 'true');
    assert.deepEqual(await output.locator('#talk-stage').evaluate(panelBoxes), beforeBoxes, `${theme} ${layout ? 'absolute' : 'grid'} panel geometry`);
    const after = await output.locator('#talk-stage').screenshot();
    const difference = await screenshotDifference(output, before, after, beforeBoxes['.stage-actor']);
    assert.equal(difference.outside, 0, `${theme} ${layout ? 'absolute' : 'grid'} decoration stays clipped: ${JSON.stringify(difference)}`);
  }
  assert.deepEqual(errors, []);
});

browserTest('live, preview and output share actor and outside overlay geometry, stacking and canvas clipping', async t => {
  const { context, page, url, errors } = await fixture(t);
  const ref = await imageRef(page, url, 120, 240);
  const desk = await imageRef(page, url, 1280, 720, 0, '#04eec1');
  const settings = custom({ scale: 110, overflow: true });
  const layout = actorOnlyLayout({ x: 40, y: 6, w: 55, h: 94 });
  const items = [
    createOverlay('image', { id: 'negative', assetId: 'solid', x: -60, y: -70, w: 100, h: 100, z: 1 }),
    createOverlay('image', { id: 'huge', assetId: 'solid', x: -100, y: 0, w: 200, h: 200, z: 2 }),
    createOverlay('image', { id: 'desk', assetId: 'desk', x: 0, y: 8.5, w: 100, h: 100, z: 4 }),
  ];
  await saveDesign(url, design => withTalk({ ...design, theme: '.pokome-workspace { overflow:visible !important; }', studio: { ...design.studio, source: 'image', image: ref, actorAppearance: 'none' } }, '16:9', { layout, actorImage: settings, overlays: { version: 1, items, assets: { solid: ref, desk } } }));
  await page.reload(); await appReady(page); await page.locator('#enter-talk').click();
  await waitActor(page, settings);
  const output = await outputPage(context, url);
  await waitActor(output, settings);
  const geometry = stage => {
    const canvas = stage.getBoundingClientRect();
    const box = element => { const rect = element.getBoundingClientRect(); return { x: (rect.x - canvas.x) / canvas.width, y: (rect.y - canvas.y) / canvas.height, w: rect.width / canvas.width, h: rect.height / canvas.height }; };
    return { actor: box(stage.querySelector('#actor-image')), overlays: [...stage.querySelectorAll(':scope > .pokome-overlay')].map(element => ({ ...box(element), z: getComputedStyle(element).zIndex })), clip: getComputedStyle(stage).overflow, actorClip: getComputedStyle(stage.querySelector('.stage-actor')).overflow };
  };
  const live = await talkStage(page).locator('#talk-stage').evaluate(geometry);
  assert.deepEqual(await output.locator('#talk-stage').evaluate(geometry), live);
  await talkStage(page).locator('#talk-stage').focus(); await page.keyboard.press('Escape'); await page.locator('[data-page="studio"]').click();
  await page.locator('#open-design-preview').click();
  const preview = page.frameLocator('#design-preview-frame');
  await preview.locator('#actor-image').waitFor();
  await page.waitForFunction(() => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').contentDocument.getElementById('talk-stage').dataset.actorImage === 'custom');
  assert.deepEqual(await preview.locator('#talk-stage').evaluate(geometry), live);
  assert.equal(live.clip, 'hidden'); assert.equal(live.actorClip, 'visible');
  assert.deepEqual(live.overlays.map(item => item.z), ['38', '71', '136']);
  assert.equal(live.overlays[0].x, -.6); assert.equal(live.overlays[1].w, 2);
  assert.ok(Math.abs(live.overlays[2].y - .085) < .0001, '8.5% survives browser subpixel rounding');
  await page.locator('#cancel-design').click();
  const scrollSize = () => ({ x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight });
  for (const background of ['theme', 'transparent', 'key']) {
    await output.goto(`${url}/output.html?background=${background}`);
    await waitActor(output, settings);
    for (const viewport of [{ width: 1280, height: 720 }, { width: 400, height: 225 }, { width: 1280, height: 240 }]) {
      await output.setViewportSize(viewport);
      assert.deepEqual(await output.evaluate(scrollSize), { x: viewport.width, y: viewport.height, w: viewport.width, h: viewport.height });
      assert.equal(await output.locator('#talk-stage').evaluate(stage => getComputedStyle(stage).overflow), 'hidden');
    }
  }
  await page.locator('#enter-talk').click();
  assert.deepEqual(await page.evaluate(scrollSize), { x: 1280, y: 720, w: 1280, h: 720 });
  await talkStage(page).locator('#talk-stage').focus(); await page.keyboard.press('Escape');
  assert.ok((await page.evaluate(scrollSize)).y > 720, 'the operating page keeps its ordinary vertical scroll');
  assert.deepEqual(errors, []);
});
