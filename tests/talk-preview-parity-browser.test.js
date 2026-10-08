import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, blockExternalFonts, appReady, saveDesign, readDesign, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, { frameStyle } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-talk-parity-'));
  const server = createServer({ customizationDirectory: directory, dataDirectory: await temporaryDataDirectory(t) });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await blockExternalFonts(context);
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(5000);
  if (frameStyle) await page.route('**/style.css', route => route.request().frame().parentFrame() ? frameStyle(route) : route.continue());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await appReady(page, { scene: !frameStyle });
  await saveDesign(url, design => ({ ...design, outputSize: '1080x1920', studio: { ...design.studio, maxVisible: 0, holdSeconds: 0 } }));
  await page.locator('#enter-talk').click();
  return { page, url, context, errors };
}
// Internal CSS pixels are measured before the enclosing iframe's transform.
const metrics = stage => {
  const view = stage.ownerDocument.defaultView, rect = stage.getBoundingClientRect();
  return { width: rect.width, height: rect.height, titleFont: view.getComputedStyle(stage.querySelector('#stage-title')).fontSize,
    panels: Object.fromEntries(['header', 'chat', 'speech', 'actor', 'footer'].map(id => {
      const box = stage.querySelector(`.stage-${id}`).getBoundingClientRect();
      return [id, [box.x - rect.x, box.y - rect.y, box.width, box.height]];
    })) };
};
for (const scene of ['talk', 'preview', 'output']) {
  browserTest(`${scene} keeps a decorative speech heading speaker when volume controls move outside the scene`, async t => {
    const { page, url, context, errors } = await fixture(t);
    const output = scene === 'output' ? await context.newPage() : null;
    if (output) { await output.goto(`${url}/output.html`); await output.locator('#talk-stage').waitFor(); }
    for (const theme of ['mint', 'rose', 'violet', 'paper']) for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      if (output) await output.emulateMedia({ colorScheme });
      for (const [speechStyle, speechBackground] of [['panel', '#ffffff'], ['bubble', '#ffffff'], ['bubble', '#000000']]) {
        await saveDesign(url, design => ({ ...design, studio: { ...design.studio, theme, speechStyle, speechBackground } }));
        await page.waitForFunction(({ theme, speechStyle, speechBackground }) => {
          const stage = document.getElementById('talk-frame').contentDocument.getElementById('talk-stage');
          return stage.dataset.theme === theme && stage.querySelector('.stage-speech').dataset.style === speechStyle && stage.style.getPropertyValue('--speech-background') === speechBackground;
        }, { theme, speechStyle, speechBackground });
        const editor = page.locator('#design-preview-editor');
        if (scene === 'preview') { await page.locator('#stage-design-edit').click(); await editor.locator('#apply-design:not(:disabled)').waitFor(); }
        const view = output || page.frameLocator(scene === 'preview' ? '#design-preview-editor #design-preview-frame' : '#talk-frame');
        const stage = view.locator('#talk-stage');
        if (output) await output.waitForFunction(({ theme, speechStyle, speechBackground }) => {
          const stage = document.getElementById('talk-stage');
          return stage.dataset.theme === theme && stage.querySelector('.stage-speech').dataset.style === speechStyle && stage.style.getPropertyValue('--speech-background') === speechBackground;
        }, { theme, speechStyle, speechBackground });
        const icon = stage.locator('.stage-speech-heading > svg.stage-speaker');
        const label = `${scene}/${theme}/${colorScheme}/${speechStyle}/${speechBackground}`;
        assert.equal(await icon.count(), 1, `${label}: heading retains its speaker`);
        assert.equal(await icon.isVisible(), true, label);
        assert.equal(await icon.getAttribute('aria-hidden'), 'true', label);
        assert.equal(await stage.locator('.stage-speech-heading :is(button,[tabindex],[role="button"])').count(), 0, `${label}: heading is decoration only`);
        const appearance = await icon.evaluate(e => {
          const css = e.ownerDocument.defaultView.getComputedStyle(e), box = e.getBoundingClientRect();
          return { color: css.color, stroke: css.stroke, width: box.width, height: box.height };
        });
        assert.deepEqual([appearance.width, appearance.height], [20, 20], label);
        assert.equal(appearance.stroke, appearance.color, label);
        if (speechStyle === 'bubble') assert.equal(appearance.color, speechBackground === '#ffffff' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)', `${label}: speaker follows bubble ink`);
        assert.equal(await page.locator('#talk-controls #stage-volume-settings').count(), 1, 'volume control stays in the parent');
        assert.equal(await stage.locator('#stage-volume-settings').count(), 0, 'scene has no volume control');
        if (scene === 'preview') await editor.locator('#cancel-design').click();
      }
    }
    assert.deepEqual(errors, []);
  });
}
browserTest('talk renders at the output size and preserves preview geometry through window resizing', async t => {
  const { page, errors } = await fixture(t);
  // Opening before the saved size arrives through SSE would make the draft stale.
  await page.waitForFunction(() => {
    const frame = document.getElementById('talk-frame');
    return frame.contentWindow.innerWidth === 1080 && frame.contentWindow.innerHeight === 1920;
  });
  const editor = page.locator('#design-preview-editor');
  await page.locator('#stage-design-edit').dispatchEvent('click');
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  const preview = page.frameLocator('#design-preview-editor #design-preview-frame');
  const expected = await preview.locator('#talk-stage').evaluate(metrics);
  const live = await page.locator('#talk-frame').count() ? page.frameLocator('#talk-frame') : page;
  const actual = await live.locator('#talk-stage').evaluate(metrics);
  assert.equal(actual.width, expected.width, 'the talk viewport must use the applied output width');
  assert.equal(actual.height, expected.height, 'the talk viewport must use the applied output height');
  assert.equal(actual.titleFont, expected.titleFont, 'vw must use the same drawing viewport');
  for (const id of Object.keys(actual.panels)) actual.panels[id].forEach((value, i) => assert.ok(Math.abs(value - expected.panels[id][i]) < 1, `${id}[${i}] differs`));
  await editor.locator('#cancel-design').click();
  for (const viewport of [{ width: 640, height: 360 }, { width: 150, height: 700 }, { width: 2160, height: 3840 }]) {
    await page.setViewportSize(viewport);
    assert.deepEqual(await live.locator('#talk-stage').evaluate(metrics), actual, 'resizing only scales the completed scene');
    const box = await page.locator('#talk-frame').boundingBox();
    const scale = Math.min(viewport.width / 1080, viewport.height / 1920);
    assert.ok(Math.abs(box.width - 1080 * scale) < 1 && Math.abs(box.height - 1920 * scale) < 1);
  }
  assert.deepEqual(errors, []);
});

browserTest('parent operations remain usable while the scene stylesheet is pending', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page } = await fixture(t, { frameStyle: async route => { await pending; await route.continue(); } });
  await page.locator('#leave-talk').click();
  assert.equal(await page.locator('#talk-view').isHidden(), true);
  assert.equal(await page.locator('#enter-talk').evaluate(e => e === document.activeElement), true);
  release();
  await page.locator('#enter-talk').click();
  await page.frameLocator('#talk-frame').locator('#stage-chat-list').waitFor();
});

browserTest('a failed scene stylesheet leaves the parent exit and error message usable', async t => {
  const { page, errors } = await fixture(t, { frameStyle: route => route.fulfill({ status: 404, body: '' }) });
  await page.locator('#talk-view-error').waitFor();
  assert.match(await page.locator('#talk-view-error').textContent(), /スタイル.*読み込めません/);
  await page.locator('#leave-talk').click();
  assert.equal(await page.locator('#enter-talk').evaluate(e => e === document.activeElement), true);
  assert.deepEqual(errors, []);
});

browserTest('workspace-scoped viewport CSS and explicit settings apply equally to the whole talk scene and preview', async t => {
  const { page, url, errors } = await fixture(t);
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, commentGap: 12 },
    theme: '.pokome-workspace #talk-stage { padding: 4vw !important; background: rgb(255,0,0) !important; } .pokome-workspace .stage-speech { min-height: 15dvh; } @media (max-width: 1100px) { .pokome-workspace #stage-title { font-size: 4vw !important; } } .pokome-workspace .stage-comment { padding-top: 100px !important; }' }));
  await page.waitForFunction(() => document.getElementById('talk-frame').contentDocument.getElementById('pokome-user-theme').textContent.includes('15dvh'));
  await page.locator('#stage-design-edit').click();
  const editor = page.locator('#design-preview-editor'); await editor.locator('#apply-design:not(:disabled)').waitFor();
  const look = stage => {
    const css = e => e.ownerDocument.defaultView.getComputedStyle(e);
    return [css(stage).padding, css(stage).backgroundColor, css(stage.querySelector('#stage-title')).fontSize,
      css(stage.querySelector('.stage-speech')).minHeight, css(stage.querySelector('.stage-comment')).paddingTop];
  };
  const expected = await page.frameLocator('#design-preview-editor #design-preview-frame').locator('#talk-stage').evaluate(look);
  const actual = await page.frameLocator('#talk-frame').locator('#talk-stage').evaluate(look);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, ['43.2px','rgb(255, 0, 0)','43.2px','288px','6px']);
  assert.deepEqual(errors, []);
});

browserTest('parent controls, dialogs, frame Escape and focus work at every operation window size', async t => {
  const { page, errors } = await fixture(t);
  const frame = page.frameLocator('#talk-frame');
  for (const [width, height] of [[1440,900],[1280,720],[640,360],[500,600],[300,600],[150,700]]) {
    await page.setViewportSize({ width, height });
    const before = await frame.locator('#talk-stage').evaluate(metrics);
    await page.locator('#leave-talk').focus();
    for (const selector of ['#leave-talk','#stage-auto-speech','#stage-design-edit','#stage-connection','#stage-volume-settings','[data-stage-platform="kick"]']) {
      const control = page.locator(selector); await control.focus(); await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1, `${selector} fits ${width}x${height}`);
      assert.ok(box.height >= 44, `${selector} stays operable`);
    }
    assert.deepEqual(await frame.locator('#talk-stage').evaluate(metrics), before, 'revealing controls never moves the scene');
    await page.locator('#stage-connection').click();
    const dialog = page.locator('#stage-connection-dialog');
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth), true, 'connection dialog does not overflow horizontally');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('#stage-connection').evaluate(e => e === document.activeElement), true);
    await page.locator('#stage-volume-settings').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#stage-volume-dialog').isVisible(), false);
    assert.equal(await page.locator('#stage-volume-settings').evaluate(e => e === document.activeElement), true);
    await page.locator('#stage-design-edit').click();
    const editor = page.locator('#design-preview-editor'); await editor.locator('#apply-design:not(:disabled)').waitFor();
    await editor.locator('#cancel-design').click();
    assert.equal(await page.locator('#stage-design-edit').evaluate(e => e === document.activeElement), true);
  }
  await frame.locator('#stage-chat-list').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#talk-view').isHidden(), true);
  assert.equal(await page.locator('#enter-talk').evaluate(e => e === document.activeElement), true);
  await page.locator('#enter-talk').click();
  await page.goBack();
  assert.equal(await page.locator('#talk-view').isHidden(), true);
  assert.deepEqual(errors, []);
});

browserTest('resizing writes nothing and applied output sizes keep the same scene and scrolled history', async t => {
  const { page, url, errors } = await fixture(t);
  const live = page.frameLocator('#talk-frame');
  await live.locator('#stage-chat-list').evaluate(e => { e.ownerDocument.defaultView.originalScene = e.closest('#talk-stage'); });
  const writes = [];
  page.on('request', request => { if (request.method() === 'PUT') writes.push(request.url()); });
  const stored = await readDesign(url);
  for (const viewport of [{width:300,height:600},{width:1440,height:900}]) await page.setViewportSize(viewport);
  assert.deepEqual(await readDesign(url), stored);
  assert.deepEqual(writes, []);
  await live.locator('#stage-chat-list').evaluate(e => { e.scrollTop = 20; });
  const scroll = await live.locator('#stage-chat-list').evaluate(e => e.scrollTop);
  for (const outputSize of ['1280x720','1920x1080','1440x1080','1080x1920']) {
    await saveDesign(url, design => ({ ...design, outputSize }));
    const [width,height] = outputSize.split('x').map(Number);
    await page.waitForFunction(({width,height}) => { const f = document.getElementById('talk-frame'); return f.contentWindow.innerWidth === width && f.contentWindow.innerHeight === height; }, {width,height});
    assert.equal(await live.locator('#talk-stage').evaluate(e => e === e.ownerDocument.defaultView.originalScene), true);
    assert.equal(await live.locator('.stage-comment').count(), 12);
  }
  await live.locator('#stage-chat-list').evaluate((e, scroll) => { e.scrollTop = scroll; }, scroll);
  await page.setViewportSize({ width: 640, height: 360 });
  assert.equal(await live.locator('#stage-chat-list').evaluate(e => e.scrollTop), scroll);
  assert.deepEqual(errors, []);
});
