import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, saveTalk, waitForDesign, appReady, blockExternalFonts, editorTarget } from './browser-support.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-canvas-speech-'));
  const server = createServer({ customizationDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(page); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await appReady(page);
  return { base, page, errors };
}
const speechWhere = (base, predicate) => waitForDesign(base, design => { const p = design.ratios['16:9']?.layout?.panels.speech; return !!p && predicate(p); });

async function canvasSize(page, editor, size) {
  await editor.locator('#preview-width').selectOption(size);
  await page.waitForFunction(value => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === Number(value.split('x')[1]), size);
}
async function openSpeechCanvas(page) {
  await page.locator('[data-page="studio"]').click();
  const editor = page.locator('#design-preview-editor');
  await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editor.locator('#canvas-snap').uncheck();
  await canvasSize(page, editor, '1280x720'); await editorTarget(editor, 'speech');
  return editor;
}
async function applyCanvas(editor) {
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
}
const speechBox = page => page.frameLocator('#design-preview-editor #design-preview-frame').locator('.stage-speech').evaluate(element => {
  const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
});
function bottomAlignedPanels() {
  return {
    header: { x: 0, y: 0, w: 100, h: 15, hidden: false, z: 1 },
    chat: { x: 0, y: 20, w: 45, h: 70, hidden: false, z: 1 },
    speech: { x: 50, y: 75, w: 50, h: 25, hidden: false, z: 2 },
    actor: { x: 50, y: 20, w: 50, h: 40, hidden: false, z: 1 },
    footer: { x: 0, y: 95, w: 45, h: 5, hidden: false, z: 1 },
  };
}

test('one-axis resize preserves untouched saved dimensions and desktop intent', { skip: !browserAvailable }, async t => {
  const { base, page, errors } = await fixture(t);
  const panels = bottomAlignedPanels();
  const scenarios = [
    { key: 'ArrowUp', axis: 'h' }, { key: 'ArrowDown', axis: 'h' },
    { key: 'ArrowLeft', axis: 'w' }, { key: 'ArrowRight', axis: 'w' },
    { pointer: [-40, 0], axis: 'w' }, { pointer: [0, 40], axis: 'h' },
  ];
  for (const scenario of scenarios) {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-page="studio"]').click();
    // Restore the saved layout from outside; the page follows the folder's change.
    await saveTalk(base, { layout: { panels } });
    await page.waitForFunction(() => {
      const style = document.querySelector('.stage-speech').style;
      return style.width === '50%' && style.height === '25%' && style.left === '50%';
    });
    const canvas = await openSpeechCanvas(page);
    const desktop = await speechBox(page);
    await canvasSize(page, canvas, '640x360');
    const resize = canvas.locator('.canvas-target[data-target-id="speech"] .canvas-handle[data-edge="se"]');
    if (scenario.key) await canvas.locator('.canvas-target[data-target-id="speech"]').press('Shift+' + scenario.key);
    else {
      const handle = await resize.boundingBox();
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + scenario.pointer[0], y + scenario.pointer[1], { steps: 6 });
      await page.mouse.up();
    }
    const stored = Object.fromEntries(await Promise.all(['x', 'y', 'w', 'h'].map(async key => [key, Number(await canvas.locator('#panel-' + key).inputValue())])));
    await canvasSize(page, canvas, '1280x720');
    const returned = await speechBox(page);
    const label = scenario.key || `pointer-${scenario.axis}`;
    t.diagnostic(JSON.stringify({ label, stored, desktopBefore: desktop, desktopAfter: returned }));
    if (scenario.axis === 'w') {
      assert.equal(stored.h, panels.speech.h, label + ' preserves saved height');
      assert.equal(stored.y, panels.speech.y, label + ' preserves vertical intent');
      assert.equal(returned.height, desktop.height, label + ' preserves desktop height');
      assert.equal(returned.y, desktop.y, label + ' preserves desktop vertical position');
    } else {
      assert.equal(stored.w, panels.speech.w, label + ' preserves saved width');
      assert.equal(stored.x, panels.speech.x, label + ' preserves horizontal intent');
      assert.equal(returned.width, desktop.width, label + ' preserves desktop width');
      assert.equal(returned.x, desktop.x, label + ' preserves desktop horizontal position');
    }
    assert.notEqual(stored[scenario.axis], panels.speech[scenario.axis], label + ' edits the requested dimension');
    await applyCanvas(canvas);
    await speechWhere(base, p => p[scenario.axis] !== panels.speech[scenario.axis]);
  }
  assert.deepEqual(errors, []);
});
