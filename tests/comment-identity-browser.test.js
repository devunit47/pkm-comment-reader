import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, temporaryDataDirectory, appReady, saveStudio, editorTarget, closeEditor, applyInEditor } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, studio = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-identity-'));
  const server = createServer({ customizationDirectory: directory, dataDirectory: await temporaryDataDirectory() });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await saveStudio(base, studio);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(context);
  const requests = [], errors = [];
  const png = await readFile(new URL('fixtures/presets/actor.png', import.meta.url));
  await context.route('https://static-cdn.jtvnw.net/**', route => {
    requests.push(route.request().url());
    return route.request().url().includes('/broken/') ? route.abort() : route.fulfill({ contentType: 'image/png', body: png });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    window.testSockets = []; window.spoken = [];
    window.WebSocket = class { constructor() { window.testSockets.push(this); } send() {} close() {} };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: '確認用音声', voiceURI: 'qa-voice', lang: 'ja-JP' }], addEventListener() {}, cancel() {},
      speak(utterance) { window.spoken.push(utterance.text); utterance.onstart?.(); utterance.onend?.(); },
    } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.goto(base); await appReady(page);
  await page.evaluate(() => {
    document.querySelector('#read-name').checked = true; document.querySelector('#read-name').dispatchEvent(new Event('change'));
    document.querySelector('#twitch-channel').value = 'qa_channel';
    document.querySelector('#twitch-connect-form').requestSubmit();
  });
  await page.waitForFunction(() => window.testSockets.length === 1);
  await page.evaluate(() => { const socket = window.testSockets[0]; socket.onopen(); socket.onmessage({ data: ':server 366 anon #qa_channel :End\r\n' }); });
  await page.locator('#twitch-status').filter({ hasText: '接続済み' }).waitFor({ state: 'attached' });
  return { context, page, base, requests, errors };
}
async function receive(page, text, tags = 'color=#ffffff;badges=vip/1;emotes=25:2-6') {
  await page.evaluate(({ text, tags }) => window.testSockets[0].onmessage({ data: `@${tags} :viewer!viewer@host PRIVMSG #qa_channel :${text}\r\n` }), { text, tags });
}

browserTest('Twitch emotes and service colors reach live, preview and output; failed images become text and speech excludes emotes', async t => {
  const { context, page, base, requests, errors } = await fixture(t, { commentAuthorColor: 'service', commentPanel: 'light' });
  await receive(page, '😀 Kappa hello');
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  const output = await context.newPage(); await output.goto(`${base}/output.html`);
  await output.locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
  const color = locator => locator.evaluate(element => getComputedStyle(element).color);
  const liveColor = await color(page.locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong'));
  assert.equal(await color(output.locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong')), liveColor);
  assert.equal(await color(frame.locator('.stage-comment').first().locator('strong')), liveColor);
  assert.ok(requests.every(url => /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[A-Za-z0-9_]+\/default\/dark\/2\.0$/.test(url)));
  await closeEditor(page);
  assert.deepEqual(await page.evaluate(() => window.spoken), ['viewerさん。😀 hello']);
  await receive(page, 'Kappa', 'emotes=25:0-4');
  assert.equal(await page.evaluate(() => window.spoken.length), 1);
  await receive(page, 'Broken', 'emotes=broken:0-5');
  await page.waitForFunction(() => [...document.querySelectorAll('#stage-chat-list .pokome-comment__body')].some(element => element.textContent === 'Broken' && !element.querySelector('img')));
  assert.equal(await page.locator('#comment-list img').count(), 0);
  await applyInEditor(page, async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-commentEmotes').selectOption('text'); });
  await output.waitForFunction(() => !document.querySelector('#stage-chat-list img.pokome-comment__emote'));
  const count = requests.length;
  await receive(page, '😀 Kappa hello');
  await page.locator('#open-design-preview').click();
  await frame.locator('.stage-comment').nth(9).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('img.pokome-comment__emote').count(), 0);
  await page.waitForTimeout(150);
  assert.equal(requests.length, count, 'text mode never requests the CDN, including preview and new comments');
  assert.deepEqual(errors, []);
});
