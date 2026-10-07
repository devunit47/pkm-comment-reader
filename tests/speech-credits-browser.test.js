import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, readDesign, saveTalk, waitForDesign, appReady, blockExternalFonts, applyInEditor, editorTarget, editorThemeCSS, temporaryDataDirectory } from './browser-support.js';

const speechStyle = (page, style) => applyInEditor(page, async editor => { await editorTarget(editor, 'speech'); await editor.locator('#draft-speechStyle').selectOption(style); });
const themeCSS = (page, css) => applyInEditor(page, async editor => { await editorThemeCSS(editor); await editor.locator('#draft-css').fill(css); });

async function canvasSize(page, editor, size) {
  await editor.locator('#preview-width').selectOption(size);
  await page.waitForFunction(value => document.querySelector('#design-preview-editor').shadowRoot.getElementById('design-preview-frame').contentWindow.innerHeight === Number(value.split('x')[1]), size);
}
async function openSpeechCanvas(page) {
  await page.locator('[data-page="studio"]').click();
  const editor = page.locator('#design-preview-editor');
  await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await canvasSize(page, editor, '1280x720'); await editorTarget(editor, 'speech');
  return editor;
}
async function applyCanvas(editor) {
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
}
const speechBox = page => page.frameLocator('#design-preview-editor #design-preview-frame').locator('.stage-speech').evaluate(element => {
  const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
});
// The talk (stream) layout is saved in customization/current, not in the browser.
const savedSpeech = async base => (await readDesign(base)).ratios['16:9']?.layout?.panels.speech;
const speechWhere = (base, predicate) => waitForDesign(base, design => { const p = design.ratios['16:9']?.layout?.panels.speech; return !!p && predicate(p); })
  .then(design => design.ratios['16:9'].layout.panels.speech);

const uuid = '3c37646f-3881-5374-2a83-149267990abc';
async function editorScreenshot(page, name) {
  const directory = process.env.EDITOR_QA_DIRECTORY;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name + '.png') });
}
const voicevoxSpeakers = () => [
  { name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }, { id: 1, name: 'あまあま' }] },
  { name: '四国めたん', styles: [{ id: 2, name: 'ノーマル' }] },
];
async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function local(t) {
  const state = { speakers: voicevoxSpeakers(), fail: false };
  const base = await serve(t, createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: await temporary(t, 'pokome-credit-'), fetchImpl: async url => {
    if (url.endsWith('/speakers')) {
      if (state.fail) return new Response('', { status: 503 });
      return Response.json(url.includes(':50021/') ? state.speakers : [{ speakerName: 'つくよみちゃん', speakerUuid: uuid, styles: [{ styleId: 0, styleName: 'れいせい' }] }]);
    }
    if (state.failSynthesis) return new Response('', { status: 503 });
    if (url.includes('/audio_query?')) return Response.json({ speedScale: 1 });
    return new Response(Buffer.from('RIFF0000WAVEdata'));
  } }));
  return { base, state };
}
async function open(t, url, storage = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
  page.setDefaultTimeout(8000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(values => {
    if (!sessionStorage.getItem('credit-test-initialized')) {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('credit-test-initialized', 'true');
    }
    window.creditAudio = [];
    window.Audio = class {
      play() { window.creditAudio.push(this); this.onplaying?.(); return Promise.resolve(); }
      pause() { this.paused = true; }
      removeAttribute() {}
    };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], addEventListener() {}, cancel() {}, speak(utterance) { utterance.onstart?.(); },
    } });
  }, storage);
  await page.goto(url);
  await page.locator('#appearance-recovery #open-reset').waitFor();
  return { page, errors, requests };
}
async function credits(page, expected) {
  await page.waitForFunction(value => ['preview-speech-credit', 'stage-speech-credit'].every(id => {
    const element = document.getElementById(id);
    return element.textContent === value && element.hidden === !value;
  }), expected);
}
async function choose(page, engine) {
  await page.locator('#speech-engine').selectOption(engine);
  if (engine !== 'browser') await page.waitForFunction(() => !document.querySelector('#voice').disabled);
}
async function refresh(page) {
  const response = page.waitForResponse('**/api/speech/voicevox/voices');
  await page.locator('#refresh-voices').click();
  await (await response).finished();
  await page.waitForFunction(() => !document.querySelector('#engine-status').textContent.includes('接続中'));
}

test('credits follow voice, style, engine and platform, survive reload and appearance reset, and remain visible in talk styles', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const { page, errors } = await open(t, base);
  await credits(page, '');
  await choose(page, 'voicevox'); await credits(page, 'VOICEVOX:ずんだもん');
  await page.locator('#voice').selectOption('1'); await credits(page, 'VOICEVOX:ずんだもん');
  await page.locator('#voice').selectOption('2'); await credits(page, 'VOICEVOX:四国めたん');
  await page.reload(); await appReady(page); await credits(page, 'VOICEVOX:四国めたん');
  assert.equal(await page.locator('#voice').inputValue(), '2');
  for (const style of ['panel', 'bubble', 'image']) {
    await speechStyle(page, style);
    await page.locator('#enter-talk').click();
    assert.equal(await page.locator('#stage-speech-credit').isVisible(), true);
    assert.equal(await page.locator('#stage-speech-credit').evaluate(element => {
      const credit = element.getBoundingClientRect(), panel = element.closest('.stage-speech').getBoundingClientRect();
      return credit.left >= panel.left && credit.right <= panel.right && credit.top >= panel.top && credit.bottom <= panel.bottom + 1;
    }), true, style);
    assert.equal(await page.locator('.stage-speech-content #stage-speech-credit').count(), 0);
    await page.locator('#leave-talk').click();
  }
  await page.locator('#appearance-recovery #open-reset').click();
  await page.locator('#appearance-recovery #confirm-reset').click();
  await credits(page, 'VOICEVOX:四国めたん');
  await page.locator('[data-page="home"]').click();
  assert.equal(await page.locator('#speech-engine').inputValue(), 'voicevox');
  await choose(page, 'coeiroink'); await credits(page, 'COEIROINK:つくよみちゃん');
  await page.locator('[data-platform="kick"]').click(); await credits(page, '');
  await choose(page, 'voicevox'); await credits(page, 'VOICEVOX:ずんだもん');
  await page.locator('[data-platform="twitch"]').click(); await credits(page, 'COEIROINK:つくよみちゃん');
  await choose(page, 'browser'); await credits(page, '');
  assert.deepEqual(errors, []);
});

test('short and resized speech panels keep readable text and visible credits for both engines', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const { page, errors } = await open(t, base);
  for (const engine of ['voicevox', 'coeiroink']) {
    await choose(page, engine);
    for (const style of ['panel', 'bubble', 'image']) {
      await speechStyle(page, style);
      await page.locator('#enter-talk').click();
      for (const viewport of [{ width: 640, height: 360 }, { width: 960, height: 540 }]) {
        await page.setViewportSize(viewport);
        const geometry = await page.locator('.stage-speech').evaluate(panel => {
          const bounds = panel.getBoundingClientRect();
          const credit = panel.querySelector('#stage-speech-credit');
          const attribution = credit.getBoundingClientRect();
          const content = panel.querySelector('.stage-speech-content');
          const speech = panel.querySelector('#stage-speech-text');
          const box = content.getBoundingClientRect();
          const css = getComputedStyle(content);
          const readableHeight = content.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
          return {
            visible: !credit.hidden && attribution.top >= 0 && attribution.bottom <= innerHeight && attribution.left >= 0 && attribution.right <= innerWidth,
            unscrolled: document.querySelector('#talk-stage').scrollTop === 0,
            exposed: document.elementFromPoint(attribution.left + attribution.width / 2, attribution.top + attribution.height / 2)?.closest('#stage-speech-credit') === credit,
            contained: attribution.left >= bounds.left && attribution.right <= bounds.right + 1 && attribution.top >= bounds.top && attribution.bottom <= bounds.bottom + 1,
            separate: attribution.top >= box.bottom,
            readable: readableHeight >= parseFloat(getComputedStyle(speech).lineHeight),
            fontSize: getComputedStyle(speech).fontSize,
          };
        });
        const label = `${engine}/${style}/${viewport.width}x${viewport.height}`;
        assert.equal(geometry.visible, true, label + ' visible attribution');
        assert.equal(geometry.unscrolled, true, label + ' no canvas scrolling');
        assert.equal(geometry.exposed, true, label + ' unobscured attribution');
        assert.equal(geometry.contained, true, label + ' contained attribution');
        assert.equal(geometry.separate, true, label + ' attribution outside text');
        assert.equal(geometry.readable, true, label + ' at least one readable text line');
        assert.equal(geometry.fontSize, '22px', label + ' preserves speech typography');
        await page.locator('#stage-speech-text').evaluate(text => { text.textContent = 'Long speech remains readable without moving the credit. '.repeat(100); });
        const longSpeech = await page.locator('#stage-speech-credit').evaluate(credit => {
          const c = credit.getBoundingClientRect();
          const body = document.querySelector('.stage-speech-content');
          return { visible: !credit.hidden && c.top >= 0 && c.bottom <= innerHeight,
            unscrolled: document.querySelector('#talk-stage').scrollTop === 0,
            overflow: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto' };
        });
        assert.equal(longSpeech.visible, true, label + ' long speech keeps credit in viewport');
        assert.equal(longSpeech.unscrolled, true, label + ' long speech does not scroll canvas');
        assert.equal(longSpeech.overflow, true, label + ' long speech scrolls independently');
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#leave-talk').click();
    }
    await page.locator('[data-page="home"]').click();
  }
  // Resize through the canvas handle; apply before checking the live credit.
  const canvas = await openSpeechCanvas(page);
  const resize = canvas.locator('.canvas-target[data-target-id="speech"] .canvas-handle[data-edge="s"]');
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 160, { steps: 8 });
  await page.mouse.up(); await applyCanvas(canvas);
  await speechWhere(base, p => p.h < 20);
  await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
  for (const viewport of [{ width: 640, height: 360 }, { width: 960, height: 540 }]) {
    await page.setViewportSize(viewport);
    const contained = await page.locator('#stage-speech-credit').evaluate(credit => {
      const c = credit.getBoundingClientRect(), p = credit.closest('.stage-speech').getBoundingClientRect();
      return p.height >= 220 && c.top >= p.top && c.bottom <= p.bottom + 1 && c.left >= p.left && c.right <= p.right + 1 && c.top >= 0 && c.bottom <= innerHeight && document.querySelector('#talk-stage').scrollTop === 0;
    });
    assert.equal(contained, true, `drag-resized speech/${viewport.width}x${viewport.height}`);
  }
  assert.deepEqual(errors, []);
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

test('saved bottom-aligned speech stays in the unscrolled viewport after reload and resize', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const panels = bottomAlignedPanels();
  await saveTalk(base, { layout: { panels } });
  const { page, errors } = await open(t, base);
  for (const engine of ['voicevox', 'coeiroink']) {
    await choose(page, engine);
    await page.reload(); await appReady(page);
    await page.waitForFunction(() => !document.querySelector('#voice').disabled);
    await page.locator('#enter-talk').click();
    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 360 }, { width: 960, height: 540 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.locator('#stage-speech-credit').evaluate(credit => {
        const c = credit.getBoundingClientRect(), p = credit.closest('.stage-speech').getBoundingClientRect();
        return { visible: !credit.hidden && c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth,
          contained: c.top >= p.top && c.bottom <= p.bottom + 1,
          unscrolled: document.querySelector('#talk-stage').scrollTop === 0 };
      });
      assert.deepEqual(geometry, { visible: true, contained: true, unscrolled: true }, `${engine}/${viewport.width}x${viewport.height}`);
    }
    assert.deepEqual(await savedSpeech(base), panels.speech);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#leave-talk').click();
  }
  assert.deepEqual(errors, []);
});

for (const action of ['drag', 'keyboard']) {
  test(`clamped saved speech responds to the first upward ${action} and retains desktop sizing`, { skip: !browserAvailable }, async t => {
    const { base } = await local(t);
    const panels = bottomAlignedPanels();
    await saveTalk(base, { layout: { panels } });
  const { page, errors } = await open(t, base);
    await choose(page, 'voicevox');
    await page.setViewportSize({ width: 1280, height: 720 });
    const canvas = await openSpeechCanvas(page);
    const desktop = await speechBox(page);
    await canvasSize(page, canvas, '640x360');
    const compact = await speechBox(page);
    assert.equal(compact.y, 140);
    await canvasSize(page, canvas, '1280x720');
    assert.deepEqual(await speechBox(page), desktop, 'resize alone restores desktop geometry');
    assert.deepEqual(await savedSpeech(base), panels.speech, 'resize alone preserves saved percentages');
    await canvasSize(page, canvas, '640x360');
    const move = canvas.locator('.canvas-target[data-target-id="speech"]');
    await editorScreenshot(page, `speech-editor-${action}-before-640x360`);
    if (action === 'drag') {
      const handle = await move.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 50, { steps: 6 });
      await page.mouse.up();
    } else {
      await move.press('ArrowUp');
    }
    const changed = await speechBox(page);
    const distance = compact.y - changed.y;
    const scale = (await canvas.locator('#design-preview-frame').boundingBox()).width / 640;
    assert.ok(action === 'drag' ? Math.abs(distance - 50 / scale) <= 7.3 : Math.abs(distance - 7.2) < 1, `first ${action} moves from visible position; observed ${distance}px`);
    const stored = { ...panels.speech, y: Number(await canvas.locator('#panel-y').inputValue()) };
    assert.equal(Number(await canvas.locator('#panel-h').inputValue()), panels.speech.h);
    assert.equal(Number(await canvas.locator('#panel-w').inputValue()), panels.speech.w);
    assert.equal(stored.h, panels.speech.h, 'moving does not rewrite saved height');
    assert.equal(stored.w, panels.speech.w, 'moving does not rewrite saved width');
    t.diagnostic(JSON.stringify({ action, initialY: compact.y, changedY: changed.y, distance, storedY: stored.y }));
    await editorScreenshot(page, `speech-editor-${action}-after-640x360`);
    await canvasSize(page, canvas, '1280x720');
    const returned = await speechBox(page);
    assert.ok(Math.abs(returned.y - stored.y / 100 * 720) < 1, 'desktop position follows the explicit edit');
    assert.equal(returned.height, desktop.height, 'desktop speech sizing is preserved');
    await editorScreenshot(page, `speech-editor-${action}-desktop-1280x720`);
    await applyCanvas(canvas);
    await speechWhere(base, p => p.y !== panels.speech.y);
    assert.deepEqual(errors, []);
  });
}

test('custom CSS minimum height updates saved speech bounds on apply, clear and appearance reset', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const panels = bottomAlignedPanels();
  await saveTalk(base, { layout: { panels } });
  const { page, errors } = await open(t, base);
  await choose(page, 'voicevox');
  await page.setViewportSize({ width: 1280, height: 720 });
  const check = async height => {
    await page.locator('#enter-talk').click();
    await page.waitForFunction(expected => {
      const panel = document.querySelector('.stage-speech').getBoundingClientRect();
      const credit = document.querySelector('#stage-speech-credit').getBoundingClientRect();
      return panel.height === expected && panel.bottom <= innerHeight && credit.bottom <= innerHeight && document.querySelector('#talk-stage').scrollTop === 0;
    }, height);
    await editorScreenshot(page, `speech-custom-css-${height}px-1280x720`);
    assert.deepEqual(await savedSpeech(base), panels.speech, 'CSS does not rewrite saved layout');
    await page.locator('#leave-talk').click();
  };
  await themeCSS(page, '.pokome-workspace .stage-speech { min-height: 300px; }');
  await check(300);
  await applyInEditor(page, async editor => { await editorThemeCSS(editor); await editor.locator('#draft-css-clear').click(); });
  await check(220);
  await themeCSS(page, '.pokome-workspace .stage-speech { min-height: 300px; }');
  await check(300);
  await page.locator('#appearance-recovery #open-reset').click();
  await page.locator('#appearance-recovery #confirm-reset').click();
  await waitForDesign(base, design => design.ratios['16:9'] === null);
  assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), null);
  assert.equal(await page.locator('#pokome-user-theme').textContent(), '');
  await page.locator('#enter-talk').click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.stage-speech');
    const bounds = panel.getBoundingClientRect(), credit = document.querySelector('#stage-speech-credit').getBoundingClientRect();
    return panel.style.top === '' && bounds.bottom <= innerHeight && credit.bottom <= innerHeight && document.querySelector('#talk-stage').scrollTop === 0;
  });
  assert.deepEqual(errors, []);
});

test('compact chat stays bounded and follows new demo messages while credit remains initially visible', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const { page, errors } = await open(t, base);
  await choose(page, 'voicevox');
  for (let i = 0; i < 20; i++) await page.locator('#demo').click();
  await page.setViewportSize({ width: 960, height: 540 });
  await page.locator('#enter-talk').click();
  const measure = () => page.locator('#stage-chat-list').evaluate(list => {
    const last = list.lastElementChild.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    const credit = document.querySelector('#stage-speech-credit').getBoundingClientRect();
    return { count: list.children.length,
      gridBounded: document.querySelector('.stage-grid').getBoundingClientRect().height <= innerHeight,
      innerScroll: list.scrollHeight > list.clientHeight,
      atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 2,
      newestVisible: last.top >= bounds.top && last.bottom <= Math.min(innerHeight, bounds.bottom),
      creditVisible: credit.top >= 0 && credit.bottom <= innerHeight,
      unscrolled: document.querySelector('#talk-stage').scrollTop === 0 };
  });
  const initial = await measure();
  assert.equal(initial.count, 32);
  for (const field of ['gridBounded', 'innerScroll', 'atBottom', 'newestVisible', 'creditVisible', 'unscrolled']) assert.equal(initial[field], true, field);
  // Deliver another demo message through the application's normal click handler
  // while talk mode is active, without leaving and re-entering (which scrolls).
  await page.locator('#demo').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('#stage-chat-list').children.length === 33);
  const updated = await measure();
  assert.equal(updated.count, 33);
  for (const field of ['gridBounded', 'innerScroll', 'atBottom', 'newestVisible', 'creditVisible', 'unscrolled']) assert.equal(updated[field], true, field + ' after new message');
  assert.deepEqual(errors, []);
});

test('missing or failed metadata cannot retain an old name and markup remains literal text', { skip: !browserAvailable }, async t => {
  const { base, state } = await local(t);
  const { page, errors } = await open(t, base);
  state.speakers = [{ name: '<img src=x onerror=alert(1)> / 別名', styles: [{ id: 3, name: '通常' }] }];
  await choose(page, 'voicevox'); await credits(page, 'VOICEVOX:<img src=x onerror=alert(1)> / 別名');
  assert.equal(await page.locator('.speech-credit img').count(), 0);
  state.speakers = [{ styles: [{ id: 3, name: '通常' }] }];
  await refresh(page); await credits(page, 'VOICEVOX:音声名未取得');
  assert.match(await page.locator('#engine-status').textContent(), /音声名を取得できない/);
  state.speakers = voicevoxSpeakers(); await refresh(page); await credits(page, 'VOICEVOX:ずんだもん');
  state.fail = true; await refresh(page); await credits(page, 'VOICEVOX:音声名未取得');
  assert.equal(await page.locator('#voice').isDisabled(), true);
  await page.reload(); await appReady(page); await credits(page, 'VOICEVOX:音声名未取得');
  state.fail = false; await refresh(page); await credits(page, 'VOICEVOX:ずんだもん');
  await choose(page, 'browser'); await credits(page, '');
  assert.deepEqual(errors, []);
});

test('playing, queued and retained speech keep original attribution across metadata refresh, then clear on stop or expiry', { skip: !browserAvailable }, async t => {
  const { base, state } = await local(t);
  const { page, errors } = await open(t, base);
  await choose(page, 'voicevox');
  const selectedPreview = await page.locator('#preview-text').textContent();
  await page.locator('#test-voice').click();
  await page.waitForFunction(() => window.creditAudio.length === 1);
  await page.locator('#test-voice').click();
  state.speakers = [{ name: '更新後の音声名', styles: [{ id: 3, name: '通常' }] }];
  await refresh(page); await credits(page, 'VOICEVOX:ずんだもん');
  await page.evaluate(() => window.creditAudio[0].onended());
  await page.waitForFunction(() => window.creditAudio.length === 2);
  await credits(page, 'VOICEVOX:ずんだもん');
  await page.evaluate(() => window.creditAudio[1].onended());
  await credits(page, 'VOICEVOX:ずんだもん');
  await page.waitForFunction(() => document.querySelector('#stage-speech-text').textContent === '次のコメントを待っています。');
  await credits(page, 'VOICEVOX:更新後の音声名');
  assert.equal(await page.locator('#preview-text').textContent(), selectedPreview);
  await page.locator('#test-voice').click();
  await page.waitForFunction(() => window.creditAudio.length === 3);
  await choose(page, 'coeiroink'); await credits(page, 'COEIROINK:つくよみちゃん');
  assert.equal(await page.evaluate(() => window.creditAudio[2].paused), true);
  assert.equal(await page.locator('#stage-speech-text').textContent(), '次のコメントを待っています。');
  state.failSynthesis = true;
  await page.locator('#test-voice').click();
  await page.waitForFunction(() => document.querySelector('#engine-status').textContent.includes('生成に失敗'));
  await credits(page, 'COEIROINK:つくよみちゃん');
  assert.equal(await page.locator('#stage-speech-text').textContent(), '次のコメントを待っています。');
  assert.equal(await page.locator('#speech-status').textContent(), '待機中');
  await choose(page, 'browser'); await credits(page, '');
  assert.deepEqual(errors, []);
});

test('a late voice-list response cannot overwrite another engine or platform credit', { skip: !browserAvailable }, async t => {
  const { base } = await local(t);
  const { page, errors } = await open(t, base);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  await page.route('**/api/speech/voicevox/voices', async route => {
    started(); await gate;
    await route.fulfill({ status: 200, json: { voices: [{ id: '3', speakerName: '古い応答', styleName: '通常' }] } });
  }, { times: 1 });
  await page.locator('#speech-engine').selectOption('voicevox'); await received;
  await credits(page, 'VOICEVOX:音声名未取得');
  await choose(page, 'coeiroink'); await credits(page, 'COEIROINK:つくよみちゃん');
  const finished = page.waitForResponse('**/api/speech/voicevox/voices');
  release(); await (await finished).finished();
  await page.waitForTimeout(100); await credits(page, 'COEIROINK:つくよみちゃん');
  await page.locator('[data-platform="kick"]').click(); await credits(page, '');
  await choose(page, 'voicevox'); await credits(page, 'VOICEVOX:ずんだもん');
  assert.deepEqual(errors, []);
});
