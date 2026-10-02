import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../server.js';
import { buildPages } from '../build-pages.js';
import { createPreviewServer } from '../preview-pages.js';
import { chromium, executablePath, browserAvailable } from './browser-support.js';

const uuid = '3c37646f-3881-5374-2a83-149267990abc';
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
  const base = await serve(t, createServer({ customizationDirectory: await temporary(t, 'pokome-credit-'), fetchImpl: async url => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
  await page.reload(); await credits(page, 'VOICEVOX:四国めたん');
  assert.equal(await page.locator('#voice').inputValue(), '2');
  for (const style of ['panel', 'bubble', 'image']) {
    await page.locator('[data-page="studio"]').click();
    await page.locator('#studio-speech-style').selectOption(style);
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
  await page.reload(); await credits(page, 'VOICEVOX:音声名未取得');
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

test('Pages forces browser speech and hides local credits even with restored local preferences', { skip: !browserAvailable }, async t => {
  const destination = pathToFileURL((await temporary(t, 'pokome-credit-pages-')) + '/');
  await buildPages(destination);
  const base = await serve(t, createPreviewServer(destination));
  const { page, errors, requests } = await open(t, base + '/preview/', {
    'pokome-speech-engines': { twitch: { engine: 'voicevox', voicevox: '3', speakerName: 'stale' } },
  });
  await credits(page, '');
  assert.equal(await page.locator('#speech-engine').inputValue(), 'browser');
  await page.locator('#test-voice').click(); await credits(page, '');
  await page.locator('#enter-talk').click();
  assert.equal(await page.locator('#stage-speech-credit').isVisible(), false);
  assert.deepEqual(requests.filter(url => /\/api\//.test(new URL(url).pathname)), []);
  assert.deepEqual(errors, []);
});
