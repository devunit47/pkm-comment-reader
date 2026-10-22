import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { fakeClock } from './auth-support.js';
import { defaultTalkLayout, withTalk } from '../src/shared/design-model.js';
import { openSettings, saveDesign, waitForDesign } from './browser-support.js';
import { closeBrowser, blockExternalFonts, chromium, executablePath, browserAvailable, temporaryDataDirectory, appReady, saveStudio, editorTarget, closeEditor, applyInEditor, talkStage, matrixCases } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, studio = {}, options = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-identity-'));
  const server = createServer({ customizationDirectory: directory, dataDirectory: await temporaryDataDirectory(), ...options });
  t.after(async () => { await closeBrowser(browser); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await saveStudio(base, studio);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(context);
  if (options.browserClock) await context.clock.install();
  await options.prepare?.(context);
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
  await openSettings(page, 'speech');
  await page.locator('#read-name').check();
  await page.locator('[data-page="home"]').click();
  await page.locator('#twitch-channel').fill('qa_channel');
  await page.locator('#twitch-connection-toggle').click();
  await page.waitForFunction(() => window.testSockets.length === 1);
  await page.evaluate(() => { const socket = window.testSockets[0]; socket.onopen(); socket.onmessage({ data: ':server 366 anon #qa_channel :End\r\n' }); });
  await page.locator('#twitch-tab-status').filter({ hasText: '接続済み' }).waitFor({ state: 'attached' });
  return { context, page, base, requests, errors };
}
async function receive(page, text, tags = 'color=#ffffff;badges=vip/1;emotes=25:2-6') {
  await page.evaluate(({ text, tags }) => window.testSockets[0].onmessage({ data: `@${tags} :viewer!viewer@host PRIVMSG #qa_channel :${text}\r\n` }), { text, tags });
}

browserTest('badge images follow hidden panels across talk, preview and output ratio changes without another comment', async t => {
  const badgeUrl = 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/3';
  const { context, page, base, requests, errors } = await fixture(t, { commentBadges: true, commentEmotes: 'text' }, { async prepare(context) {
    await context.route('**/api/auth/twitch', route => route.fulfill({ json: { status: 'signed-in', login: 'viewer' } }));
    await context.route('**/api/twitch/badges?*', route => route.fulfill({ json: {
      broadcasterId: '123', badges: [{ set: 'vip', version: '1', url: badgeUrl, title: 'VIP' }], nextRefreshAt: Date.now() + 3600000,
    } }));
  } });
  const hidden = defaultTalkLayout('9:16'); hidden.panels.chat.hidden = true; hidden.panels.pinned.hidden = true;
  await saveDesign(base, design => withTalk(withTalk(design, '16:9', { layout: hidden }), '9:16', { layout: defaultTalkLayout('9:16') }));
  const live = talkStage(page);
  await page.waitForFunction(() => document.getElementById('talk-frame').contentDocument.querySelector('.stage-chat').style.display === 'none');
  await page.locator('#twitch-login[data-status="signed-in"]').waitFor({ state: 'attached' });
  const catalog = page.waitForResponse(response => response.url().includes('/api/twitch/badges?'));
  await receive(page, '比率の切り替え', 'room-id=123;badges=vip/1'); await catalog;
  await page.locator('#comment-list .message').last().click(); await page.locator('#pin-comment').click();
  await page.locator('#enter-talk').click();
  assert.equal(await live.locator('.pokome-comment__badge-image').count(), 0);
  const output = await context.newPage(); await output.setViewportSize({ width: 1280, height: 720 }); await output.goto(base + '/output.html');
  await output.locator('#stage-pinned-list').filter({ hasText: '比率の切り替え' }).waitFor({ state: 'attached' });
  await output.waitForFunction(() => document.querySelector('.stage-chat').style.display === 'none');
  assert.equal(await output.locator('.pokome-comment__badge-image').count(), 0);
  const before = requests.length;
  await page.setViewportSize({ width: 600, height: 1000 });
  assert.equal(await live.locator('body').getAttribute('data-ratio'), '16:9', 'talk ratio follows output size, not window size');
  await saveDesign(base, design => ({ ...design, outputSize: '1080x1920' }));
  for (const list of ['#stage-chat-list', '#stage-pinned-list']) await live.locator(`${list} .pokome-comment__badge-image`).waitFor();
  await output.setViewportSize({ width: 600, height: 1000 });
  for (const list of ['#stage-chat-list', '#stage-pinned-list']) await output.locator(`${list} .pokome-comment__badge-image`).waitFor();
  assert.ok(requests.length > before);
  await saveDesign(base, design => ({ ...design, outputSize: '1280x720' }));
  await live.locator('.stage-chat').waitFor({ state: 'hidden' });
  await output.setViewportSize({ width: 1280, height: 720 });
  await output.locator('.stage-chat').waitFor({ state: 'hidden' });
  assert.equal(await live.locator('.pokome-comment__badge-image').count(), 0);
  assert.equal(await output.locator('.pokome-comment__badge-image').count(), 0);
  const hiddenRequests = requests.length;
  await page.locator('#stage-design-edit').click();
  const editor = page.locator('#design-preview-editor');
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  const preview = page.frameLocator('#design-preview-editor #design-preview-frame');
  await preview.locator('#stage-chat-list .stage-comment').first().waitFor({ state: 'attached' });
  assert.equal(await preview.locator('.pokome-comment__badge-image').count(), 0);
  assert.equal(requests.length, hiddenRequests, 'hidden panels do not request badge images');
  await editor.locator('#preview-ratio').selectOption('9:16');
  await preview.locator('#stage-chat-list .pokome-comment__badge-image').last().waitFor();
  await editorTarget(editor, 'chat'); await editor.locator('#panel-hidden').check();
  assert.equal(await preview.locator('#stage-chat-list .pokome-comment__badge-image').count(), 0);
  await editor.locator('#panel-hidden').uncheck();
  await preview.locator('#stage-chat-list .pokome-comment__badge-image').last().waitFor();
  await editor.locator('#preview-ratio').selectOption('16:9');
  await preview.locator('.stage-chat').waitFor({ state: 'hidden' });
  assert.equal(await preview.locator('.pokome-comment__badge-image').count(), 0);
  assert.equal(await talkStage(page).locator('#stage-count').textContent(), '1 COMMENTS', 'no additional reception is needed');
  assert.deepEqual(errors, []);
});

browserTest('badge arrival preserves the playing speech preview while a different comment stays selected', async t => {
  let badgeRequest;
  const { page, errors } = await fixture(t, { commentBadges: true, commentEmotes: 'text' }, { async prepare(context) {
    await context.route('**/api/auth/twitch', route => route.fulfill({ json: { status: 'signed-in', login: 'viewer', displayName: 'Viewer' } }));
    await context.route('**/api/twitch/badges?*', route => { badgeRequest = route; });
  } });
  await page.locator('#twitch-login[data-status="signed-in"]').waitFor({ state: 'attached' });
  await page.evaluate(() => { window.speechSynthesis.speak = utterance => { window.spoken.push(utterance.text); utterance.onstart?.(); }; });
  await receive(page, '選択中のコメント', 'room-id=123;badges=vip/1');
  await page.locator('#comment-list .message').last().click();
  await receive(page, '読み上げ中のコメント', 'room-id=123;badges=vip/1');
  await page.locator('#preview-text').filter({ hasText: '読み上げ中のコメント' }).waitFor();
  assert.ok(badgeRequest);
  await badgeRequest.fulfill({ json: { broadcasterId: '123', badges: [{ set: 'vip', version: '1', title: 'VIP', url: 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/3' }], nextRefreshAt: Date.now() + 3600000 } });
  await page.locator('#enter-talk').click();
  await talkStage(page).locator('.pokome-comment__badge-image').first().waitFor({ state: 'attached' });
  assert.match(await page.locator('#preview-text').textContent(), /読み上げ中のコメント/);
  assert.deepEqual(await page.evaluate(() => window.spoken), ['viewerさん。選択中のコメント', 'viewerさん。読み上げ中のコメント']);
  assert.deepEqual(errors, []);
});

browserTest('logout removes badges from the initiating tab, another tab and output before revoke finishes', async t => {
  const clock = fakeClock(), revokeStarted = Promise.withResolvers(), revoke = Promise.withResolvers();
  const postStarted = Promise.withResolvers(), sendPost = Promise.withResolvers();
  const badgeUrl = 'https://static-cdn.jtvnw.net/badges/v1/eb4a8a4c-eacd-4f5e-b9f2-394348310442/3';
  const catalog = { data: ['broadcaster', 'moderator', 'vip', 'subscriber', 'bits'].map(set => ({
    set_id: set, versions: [{ id: set === 'subscriber' ? '0' : set === 'bits' ? '100' : '1', image_url_4x: badgeUrl, title: set }],
  })) };
  const { context, page, base, errors } = await fixture(t, { commentBadges: true, commentEmotes: 'text' }, {
    twitchClientId: 'test-client', authPlatform: 'linux', authClock: clock,
    fetchImpl: async url => {
      if (url.endsWith('/revoke')) { revokeStarted.resolve(); return revoke.promise; }
      const data = url.endsWith('/device') ? { device_code: 'private-device', user_code: 'TEST-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 }
        : url.endsWith('/token') ? { access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 14400 }
        : url.endsWith('/validate') ? { client_id: 'test-client', user_id: '1', login: 'viewer', scopes: null, expires_in: 14400 }
        : url.endsWith('/badges/global') ? catalog : url.includes('/chat/badges?') ? { data: [] }
        : { data: [{ id: '1', login: 'viewer', display_name: '確認アカウント' }] };
      return new Response(JSON.stringify(data));
    },
  });
  const other = await context.newPage(); other.setDefaultTimeout(8000);
  const output = await context.newPage(); output.setDefaultTimeout(8000);
  try {
    await page.locator('#twitch-login[data-status="signed-out"]').waitFor({ state: 'attached' });
    await openSettings(page);
    await page.locator('#twitch-login-start').click(); await page.locator('#twitch-login[data-status="pending"]').waitFor({ state: 'attached' });
    await clock.tick(5000); await page.locator('#twitch-login[data-status="signed-in"]').waitFor({ state: 'attached' });
    await page.locator('[data-page="home"]').click();
    await other.goto(base); await appReady(other); await other.locator('#twitch-login[data-status="signed-in"]').waitFor({ state: 'attached' });
    await other.locator('#twitch-connection-toggle').click();
    await other.waitForFunction(() => window.testSockets.length === 1);
    await other.evaluate(() => { const socket = window.testSockets[0]; socket.onopen(); socket.onmessage({ data: ':server 366 anon #qa_channel :End\r\n' }); });
    for (const owner of [page, other]) {
      await receive(owner, 'ログアウト中も保持する本文', 'room-id=123;badges=broadcaster/1,moderator/1,vip/1,subscriber/0,bits/100');
      await owner.locator('#comment-list .message').last().click(); await owner.locator('#pin-comment').click();
      await owner.locator('#enter-talk').click();
      for (const list of ['#stage-chat-list', '#stage-pinned-list']) {
        await talkStage(owner).locator(`${list} .pokome-comment__badge-image`).nth(4).waitFor({ state: 'attached' });
      }
      await owner.locator('#leave-talk').click();
    }
    await output.goto(base + '/output.html');
    for (const list of ['#stage-chat-list', '#stage-pinned-list']) await output.locator(`${list} .pokome-comment__badge-image`).nth(4).waitFor();
    const fallback = async owner => {
      await owner.waitForFunction(() => {
        const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
        return ['#stage-chat-list', '#stage-pinned-list'].every(selector => {
          const list = doc.querySelector(selector);
          return list?.textContent.includes('ログアウト中も保持する本文') && list.querySelectorAll('.pokome-comment__badge').length === 4 && !list.querySelector('img');
        });
      });
    };
    await page.route('**/api/auth/twitch', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'logout') {
        postStarted.resolve(); await sendPost.promise;
      }
      await route.continue();
    });
    await openSettings(page); await page.locator('#twitch-login-logout').click();
    await page.locator('#twitch-login[data-status="signing-out"]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.getElementById('talk-frame').contentDocument.querySelector('.pokome-comment__badge-image'));
    await page.locator('#enter-talk').click(); await fallback(page);
    await postStarted.promise; sendPost.resolve(); await revokeStarted.promise;
    await other.locator('#twitch-login[data-status="signing-out"]').waitFor({ state: 'attached' });
    await other.locator('#enter-talk').click();
    await fallback(other); await fallback(output);
    for (const owner of [page, other]) {
      assert.equal(await owner.locator('#twitch-login-status').textContent(), 'ログアウトしています…');
      assert.equal(await owner.locator('#twitch-login-logout').isDisabled(), true);
      assert.equal(await talkStage(owner).locator('#stage-count').textContent(), '1 COMMENTS');
      assert.equal(await owner.locator('#twitch-tab-status').textContent(), '接続済み');
    }
    revoke.resolve(new Response('{}'));
    for (const owner of [page, other]) await owner.locator('#twitch-login[data-status="signed-out"]').waitFor({ state: 'attached' });
    await fallback(output); assert.deepEqual(errors, []);
  } finally { sendPost.resolve(); revoke.resolve(new Response('{}')); await output.close(); await other.close(); }
});

browserTest('L2 delayed Helix lists update live and output pins without replay and badge images match preview across representative scenes', async t => {
  const clock = fakeClock(), pending = [], calls = [];
  let nextLookup;
  let badgeUrl = 'https://static-cdn.jtvnw.net/badges/v1/eb4a8a4c-eacd-4f5e-b9f2-394348310442/3';
  const { context, page, base, requests, errors } = await fixture(t, { commentBadges: true, commentEmotes: 'text' }, {
    twitchClientId: 'test-client', authPlatform: 'linux', authClock: clock, browserClock: true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes('/chat/badges')) return new Promise(resolve => { pending.push(resolve); if (pending.length === 4) nextLookup?.(); });
      const data = url.endsWith('/device') ? { device_code: 'private-device', user_code: 'TEST-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 }
        : url.endsWith('/token') ? { access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 14400 }
        : url.endsWith('/validate') ? { client_id: 'test-client', user_id: '1', login: 'viewer', scopes: null, expires_in: 14400 }
        : url.endsWith('/revoke') ? {} : { data: [{ id: '1', login: 'viewer', display_name: '確認アカウント' }] };
      return new Response(JSON.stringify(data), { status: 200 });
    },
  });
  assert.equal(calls.length, 0, 'startup and anonymous connection do not call Helix');
  await openSettings(page);
  await page.locator('#twitch-login-start:not(:disabled)').waitFor(); await page.locator('#twitch-login-start').click();
  await page.locator('#twitch-login[data-status="pending"]').waitFor({ state: 'attached' }); await clock.tick(5000);
  await page.locator('#twitch-login[data-status="signed-in"]').waitFor({ state: 'attached' });
  await page.locator('[data-page="home"]').click();
  await page.evaluate(() => window.testSockets[0].onmessage({ data: '@room-id=123 :server ROOMSTATE #qa_channel\r\n' }));
  await receive(page, '長い本文を折り返して確認します。'.repeat(8), 'room-id=123;display-name=表示の折り返しを確認する長い名前の投稿者;badges=subscriber/0,vip/1,bits/100;badge-info=subscriber/30');
  await page.locator('#comment-list .message').last().click(); await page.locator('#pin-comment').click();
  const output = await context.newPage(); await output.goto(base + '/output.html');
  await output.locator('#stage-pinned-list .stage-comment').waitFor({ state: 'attached' });
  await page.locator('#enter-talk').click();
  assert.equal(await output.locator('.pokome-comment__badge-image').count(), 0);
  assert.equal(await output.locator('#stage-pinned-list .pokome-comment__badge').count(), 2);
  assert.equal(await talkStage(page).locator('#stage-count').textContent(), '1 COMMENTS');
  const before = await page.evaluate(() => ({ speech: window.spoken, count: document.getElementById('talk-frame').contentDocument.querySelector('#stage-count').textContent }));
  const catalog = set => ({ data: [{ set_id: set, versions: [{ id: set === 'subscriber' ? '0' : '1', image_url_1x: badgeUrl.slice(0, -1) + '1', image_url_2x: badgeUrl.slice(0, -1) + '2', image_url_4x: badgeUrl, title: set }] }] });
  await page.waitForFunction(() => document.querySelector('#twitch-tab-status').textContent.includes('接続済み'));
  assert.equal(pending.length, 2);
  pending[0](new Response(JSON.stringify(catalog('vip')))); pending[1](new Response(JSON.stringify(catalog('subscriber'))));
  for (const owner of [page, output]) await owner.waitForFunction(() => {
    const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
    return doc.querySelectorAll('#stage-pinned-list .pokome-comment__badge-image').length === 2;
  });
  assert.deepEqual(await page.evaluate(() => ({ speech: window.spoken, count: document.getElementById('talk-frame').contentDocument.querySelector('#stage-count').textContent })), before);
  await page.evaluate(() => window.testSockets[0].onmessage({ data: '@room-id=123;msg-id=resub;login=viewer;display-name=長い名前の投稿者;badges=subscriber/0,vip/1;msg-param-cumulative-months=30 :server USERNOTICE #qa_channel :特別なカードの本文\r\n' }));
  await output.locator('[data-event="resub"] .pokome-comment__badge-image').first().waitFor({ state: 'attached' });
  const cases = matrixCases({ theme: ['mint', 'rose', 'violet', 'paper'], scheme: ['light', 'dark'], font: [16, 64],
    ratio: [['16:9', '1280x720', 1280, 720], ['9:16', '1080x1920', 1080, 1920], ['4:3', '1440x1080', 1440, 1080]] });
  const results = [];
  for (const { theme, scheme, font, ratio: [ratio, size, width, height] } of cases) {
    await page.emulateMedia({ colorScheme: scheme }); await output.emulateMedia({ colorScheme: scheme });
    await output.setViewportSize({ width, height });
    await saveDesign(base, design => ({ ...design, outputSize: size, studio: { ...design.studio, theme, fontSize: font } }));
    await waitForDesign(base, design => design.studio.theme === theme && design.studio.fontSize === font);
    for (const owner of [page, output]) await owner.waitForFunction(({ theme, font }) => {
      const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
      return doc.querySelector('#talk-stage').dataset.theme === theme && parseFloat(getComputedStyle(doc.querySelector('.pokome-comment__body')).fontSize) === font;
    }, { theme, font });
    await page.locator('#stage-design-edit').click(); await editorTarget(page, 'chat'); await page.locator('#preview-ratio').selectOption(ratio);
    await page.locator('#preview-comment-sample').selectOption('resub');
    const preview = page.frameLocator('#design-preview-frame');
    await preview.locator('.pokome-comment__badge-image').first().waitFor({ state: 'attached' });
    const dims = [];
    for (const scene of [talkStage(page), preview, output]) {
      for (const selector of ['#stage-chat-list', '#stage-pinned-list']) {
        const list = scene.locator(selector);
        await list.locator('.pokome-comment__badge-image').first().waitFor({ state: 'attached' });
        const boxes = await list.evaluate(async list => {
          await Promise.all([...list.querySelectorAll('.pokome-comment__badge-image')].map(image => image.decode()));
          // Redraws during decoding can replace the nodes whose styles we measure.
          return [...list.querySelectorAll('.pokome-comment__badge-image')].map(image => {
            const r = image.getBoundingClientRect(), css = getComputedStyle(image);
            return { width: r.width, height: r.height, font: parseFloat(css.fontSize), authorFont: parseFloat(getComputedStyle(image.closest('strong')).fontSize), square: Math.abs(r.width - r.height) < .1 };
          });
        });
        assert.ok(boxes.length > 0, `${theme}/${scheme}/${ratio}/${font}: current images exist`);
        assert.ok(boxes.every(box => box.square && box.font === box.authorFont), `${theme}/${scheme}/${ratio}/${font}: ${JSON.stringify(boxes)}`);
        dims.push(boxes.length);
      }
    }
    results.push({ theme, scheme, ratio, font, images: dims });
    if (process.env.BADGE_QA_DIRECTORY) {
      const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.BADGE_QA_DIRECTORY, { recursive: true });
      await page.locator('#design-preview-frame').screenshot({ path: join(process.env.BADGE_QA_DIRECTORY, `${theme}-${scheme}-${ratio.replace(':', '-')}-${font}.png`) });
    }
    await closeEditor(page);
  }
  let failures = 0;
  await context.route('https://static-cdn.jtvnw.net/badges/**', route => { failures++; return route.abort(); });
  badgeUrl = 'https://static-cdn.jtvnw.net/badges/v1/743a0f3b-84b3-450b-96a0-503d7f4a9764/3';
  await clock.tick(3600000); await context.clock.fastForward(3600000);
  const nextStarted = new Promise(resolve => { nextLookup = resolve; });
  await receive(page, '一覧の更新', 'room-id=123;badges=subscriber/0,vip/1'); await nextStarted;
  pending[2](new Response(JSON.stringify(catalog('vip')))); pending[3](new Response(JSON.stringify(catalog('subscriber'))));
  for (const owner of [page, output]) await owner.waitForFunction(() => {
    const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
    const pin = doc.querySelector('#stage-pinned-list');
    return pin?.querySelectorAll('.pokome-comment__badge').length === 2 && !pin.querySelector('img');
  });
  const failedRequests = failures;
  await receive(page, '画像の読込失敗後', 'room-id=123;badges=subscriber/0,vip/1');
  await output.locator('.pokome-comment__body').filter({ hasText: '画像の読込失敗後' }).waitFor();
  assert.equal(failures, failedRequests, 'failed URLs are not requested again on redraw');
  const failedContext = await context.browser().newContext(); await blockExternalFonts(failedContext);
  await failedContext.route('https://static-cdn.jtvnw.net/badges/**', route => route.abort());
  const failedPage = await failedContext.newPage(); await failedPage.goto(base); await appReady(failedPage);
  await failedPage.locator('.nav[data-page="studio"]').click(); await failedPage.locator('#open-design-preview').click(); await editorTarget(failedPage, 'chat');
  const failedPreview = failedPage.frameLocator('#design-preview-frame');
  await failedPage.waitForFunction(() => {
    const doc = document.getElementById('design-preview-editor')?.shadowRoot.getElementById('design-preview-frame')?.contentDocument;
    return doc?.querySelectorAll('#stage-chat-list .pokome-comment__badge').length >= 4 && !doc.querySelector('.pokome-comment__badge-image');
  });
  assert.equal(await failedPreview.locator('.pokome-comment__badge-image').count(), 0); await failedContext.close();
  await saveStudio(base, { commentStyle: 'anonymous' });
  await output.waitForFunction(() => !document.querySelector('.pokome-comment__badge-image'));
  const badgeRequests = () => requests.filter(url => url.includes('/badges/')).length;
  const requestsBefore = badgeRequests(); await receive(page, '名前なし', 'room-id=123;badges=subscriber/0');
  assert.equal(badgeRequests(), requestsBefore);
  await saveStudio(base, { commentBadges: false });
  await page.locator('#leave-talk').click(); await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat'); await page.setViewportSize({ width: 150, height: 900 });
  await editorTarget(page, 'chat');
  const overflow = await page.locator('#design-dialog').evaluate(element => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false); assert.equal(await page.frameLocator('#design-preview-frame').locator('.pokome-comment__badge-image').count(), 0);
  await closeEditor(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('.nav[data-page="home"]').click();
  await openSettings(page); await page.locator('#twitch-login-logout').click(); await page.locator('#twitch-login[data-status="signed-out"]').waitFor({ state: 'attached' });
  assert.equal(calls.filter(url => url.includes('/chat/badges')).length, 4);
  assert.deepEqual(errors, []);
  if (process.env.BADGE_QA_DIRECTORY) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(process.env.BADGE_QA_DIRECTORY, 'results.json'), JSON.stringify({ cases: results, errors, helixRequests: 4 }, null, 2));
  }
  t.diagnostic(`Edge: ${cases.length} badge theme/scheme/ratio/font combinations, normal/resub/pinned in three scenes, delayed lookup and 150px editor`);
});

browserTest('pinned raw comments share identity, anonymous styles, emote fallback and line limits across all three scenes', async t => {
  const { page, context, base, errors } = await fixture(t, { commentBadges: true, commentAuthorColor: 'service', commentPanel: 'light', commentMaxLines: 2 });
  const { saveDesign } = await import('./browser-support.js');
  await page.evaluate(() => { window.speechSynthesis.speak = utterance => { window.spoken.push(utterance.text); utterance.onstart?.(); }; });
  const raw = 'Kappa Kappa Broken https://example.test/private-marker ' + '固定の本文は短縮しません。'.repeat(70);
  await receive(page, raw, 'color=#ffffff;badges=broadcaster/1,moderator/1,vip/1,subscriber/12;emotes=25:0-4,6-10/broken:12-17');
  await page.locator('#comment-list .message').last().click(); await page.locator('#pin-comment').click();
  const output = await context.newPage(); await output.goto(base + '/output.html');
  await output.locator('#stage-pinned-list .stage-comment').waitFor({ state: 'attached' });
  await page.locator('#enter-talk').click();
  const live = talkStage(page);
  const ready = owner => owner.waitForFunction(() => {
    const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
    const list = doc.querySelector('#stage-pinned-list');
    return list?.textContent.includes('Broken') && list.querySelectorAll('img').length === 2 && [...list.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0);
  });
  await ready(page); await ready(output);
  const inspect = list => list.evaluate(element => {
    const card = element.querySelector('.stage-comment'), author = card.querySelector('strong'), body = card.querySelector('p'), css = getComputedStyle(body);
    return { title: card.title, color: getComputedStyle(author).color, nameDisplay: getComputedStyle(author).display,
      font: css.fontSize, line: css.lineHeight, clamp: css.webkitLineClamp, badges: author.querySelectorAll('.pokome-comment__badge').length,
      images: [...body.querySelectorAll('img')].map(image => [getComputedStyle(image).height, image.naturalWidth > 0]),
      broken: body.textContent.includes('Broken'), pieces: body.querySelectorAll('.pokome-comment__emote-piece').length };
  });
  const actual = await inspect(live.locator('#stage-pinned-list'));
  assert.deepEqual(await inspect(output.locator('#stage-pinned-list')), actual);
  assert.equal(actual.title, 'viewer: ' + raw);
  assert.equal(actual.badges, 4); assert.equal(actual.pieces, 2); assert.equal(actual.broken, true); assert.equal(actual.clamp, '2');
  assert.ok(actual.images.every(([height, loaded]) => parseFloat(height) === parseFloat(actual.font) * 2 && loaded));
  assert.ok((await page.evaluate(() => window.spoken.at(-1))).length < raw.length);
  assert.equal(await live.locator('.stage-speech').getAttribute('data-speaking'), 'true');
  await page.locator('#stage-design-edit').click(); await editorTarget(page, 'pinned');
  const preview = page.frameLocator('#design-preview-frame');
  await preview.locator('#stage-pinned-list img').first().waitFor({ state: 'attached' });
  await preview.locator('#stage-pinned-list img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  const sample = await inspect(preview.locator('#stage-pinned-list'));
  for (const key of ['color', 'nameDisplay', 'font', 'line', 'clamp', 'badges']) assert.equal(sample[key], actual[key], key);
  assert.equal(sample.title.includes('private-marker'), false, 'preview uses fictional content');
  await closeEditor(page);
  await saveDesign(base, design => ({ ...design, studio: { ...design.studio, commentStyle: 'anonymous', commentEmotes: 'text', commentMaxLines: 0 } }));
  for (const owner of [page, output]) await owner.waitForFunction(() => {
    const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
    return doc.querySelector('#stage-pinned-list').dataset.commentStyle === 'anonymous' && !doc.querySelector('#stage-pinned-list img');
  });
  for (const list of [live.locator('#stage-pinned-list'), output.locator('#stage-pinned-list')]) {
    const result = await inspect(list);
    assert.equal(result.nameDisplay, 'none'); assert.equal(result.clamp, 'none'); assert.equal(await list.locator('p').textContent(), raw);
  }
  await page.locator('#stage-design-edit').click();
  await preview.locator('#stage-pinned-list .stage-comment').waitFor({ state: 'attached' });
  const anonymous = await inspect(preview.locator('#stage-pinned-list'));
  assert.equal(anonymous.nameDisplay, 'none'); assert.equal(anonymous.clamp, 'none'); assert.equal(anonymous.images.length, 0);
  await closeEditor(page);
  assert.deepEqual(errors, []);
});

browserTest('Twitch emotes and service colors reach live, preview and output; failed images become text and speech excludes emotes', async t => {
  const { context, page, base, requests, errors } = await fixture(t, { commentAuthorColor: 'service', commentPanel: 'light' });
  await receive(page, '😀 Kappa hello');
  await page.locator('.nav[data-page="studio"]').click();
  await talkStage(page).locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  const output = await context.newPage(); await output.goto(`${base}/output.html`);
  await output.locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
  const color = locator => locator.evaluate(element => getComputedStyle(element).color);
  const liveColor = await color(talkStage(page).locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong'));
  assert.equal(await color(output.locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong')), liveColor);
  assert.equal(await color(frame.locator('#stage-chat-list .stage-comment').first().locator('strong')), liveColor);
  assert.ok(requests.every(url => /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[A-Za-z0-9_]+\/default\/dark\/3\.0$/.test(url)));
  await closeEditor(page);
  assert.deepEqual(await page.evaluate(() => window.spoken), ['viewerさん。😀 hello']);
  await receive(page, 'Kappa', 'emotes=25:0-4');
  assert.equal(await page.evaluate(() => window.spoken.length), 1);
  await receive(page, 'Broken', 'emotes=broken:0-5');
  await page.waitForFunction(() => [...document.getElementById('talk-frame').contentDocument.querySelectorAll('#stage-chat-list .pokome-comment__body')].some(element => element.textContent === 'Broken' && !element.querySelector('img')));
  assert.equal(await talkStage(page).locator('#stage-chat-list .stage-comment').filter({ hasText: 'Broken' }).locator('.pokome-comment__emote-piece').count(), 0, 'failed images use normal text spacing');
  assert.equal(await page.locator('#comment-list img').count(), 0);
  await applyInEditor(page, async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-commentEmotes').selectOption('text'); });
  await output.waitForFunction(() => !document.querySelector('#stage-chat-list img.pokome-comment__emote'));
  const count = requests.length;
  await receive(page, '😀 Kappa hello');
  await page.locator('#open-design-preview').click();
  await frame.locator('#stage-chat-list .stage-comment').nth(9).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('img.pokome-comment__emote').count(), 0);
  await page.waitForTimeout(150);
  assert.equal(requests.length, count, 'text mode never requests the CDN, including preview and new comments');
  assert.deepEqual(errors, []);
});

browserTest('identity rendering preserves line limits and clipping across six presets, four themes, two schemes and three ratios', async t => {
  const { normalizeStudio, applyCommentPreset, COMMENT_PRESETS } = await import('../src/shared/studio.js');
  const { saveDesign } = await import('./browser-support.js');
  const { context, page, base, errors } = await fixture(t, { commentBadges: true, commentAuthorColor: 'service' });
  await receive(page, '😀 Kappa hello', 'color=#ffffff;badges=broadcaster/1,moderator/1,vip/1,subscriber/12;emotes=25:2-6');
  await receive(page, 'Kappa '.repeat(12).trimEnd(), 'color=#000000;badges=vip/1;emotes=25:' + Array.from({ length: 12 }, (_, i) => `${i * 6}-${i * 6 + 4}`).join(','));
  await receive(page, 'Broken', 'emotes=broken:0-5');
  await receive(page, '😀 Kappa ' + '長めの文章を折り返して確認します。'.repeat(35));
  const output = await context.newPage(); await output.goto(`${base}/output.html`);
  await output.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
  await page.locator('#enter-talk').click();
  const inspect = (list, maxLines) => list.evaluate((element, maxLines) => {
    const bounds = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll('.stage-comment')];
    return {
      viewportHeight: bounds.height,
      overflow: cards.flatMap((card, index) => {
        const body = card.querySelector('p'), style = getComputedStyle(body);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const rowHeight = body.querySelector('img') ? Math.max(parseFloat(style.lineHeight), parseFloat(style.fontSize) * 2) : parseFloat(style.lineHeight);
        return body.scrollWidth > body.clientWidth + 1 || (maxLines > 0 && (body.clientHeight - padding > rowHeight * maxLines + 1 || Number(style.webkitLineClamp) !== maxLines)) ? [index] : [];
      }),
      clipping: cards.flatMap((card, index) => {
        const rect = card.getBoundingClientRect();
        const expected = rect.height <= bounds.height && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        return expected !== card.classList.contains('stage-comment-clipped') ? [index] : [];
      }),
      badges: cards[0]?.querySelectorAll('.pokome-comment__badge').length,
      color: getComputedStyle(cards[0].querySelector('strong')).color,
      emoteHeight: getComputedStyle(element.querySelector('img.pokome-comment__emote')).height,
      fontSize: getComputedStyle(cards[0].querySelector('p')).fontSize,
      partialImages: cards.flatMap((card, index) => {
        const body = card.querySelector('p'), bounds = body.getBoundingClientRect();
        return [...body.querySelectorAll('img')].some(image => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1 && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        }) ? [index] : [];
      }),
      imageBounds: cards.flatMap((card, index) => {
        const rect = card.getBoundingClientRect(), body = card.querySelector('p').getBoundingClientRect();
        return [...card.querySelectorAll('img')].some(image => {
          const imageRect = image.getBoundingClientRect();
          if (imageRect.bottom <= body.top + 1 || imageRect.top >= body.bottom - 1) return false;
          return imageRect.top < rect.top - 1 || imageRect.bottom > rect.bottom + 1 || imageRect.left < rect.left - 1 || imageRect.right > rect.right + 1
            || (!card.classList.contains('stage-comment-clipped') && (imageRect.left < bounds.left - 1 || imageRect.right > bounds.right + 1));
        }) ? [index] : [];
      }),
      imageOverlap: cards.flatMap((card, index) => {
        const images = [...card.querySelectorAll('img')].map(image => image.getBoundingClientRect());
        return images.some((a, i) => images.slice(i + 1).some(b => Math.abs(a.top - b.top) > 1 && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1)) ? [index] : [];
      }),
    };
  }, maxLines);
  let combinations = 0;
  const cases = matrixCases({ scheme: ['light', 'dark'], theme: ['mint', 'rose', 'violet', 'paper'], preset: Object.keys(COMMENT_PRESETS), fontSize: [16, 64],
    ratio: [['16:9', '1280x720', 1280, 720], ['9:16', '1080x1920', 1080, 1920], ['4:3', '1440x1080', 1440, 1080]] });
  for (const { scheme, theme, preset, fontSize, ratio: [ratio, size, width, height] } of cases) {
    await page.emulateMedia({ colorScheme: scheme }); await output.emulateMedia({ colorScheme: scheme });
    const studio = { ...applyCommentPreset(normalizeStudio({ theme }), preset), fontSize, commentAuthorColor: 'service', commentBadges: true, commentEmotes: 'image' };
    const label = `${scheme}/${theme}/${preset}/${ratio}/${fontSize}px`;
    await output.setViewportSize({ width, height });
    await saveDesign(base, design => ({ ...design, outputSize: size, studio }));
    for (const target of [page, output]) await target.waitForFunction(({ theme, ratio, style, panel, fontSize }) => {
      const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
      const stage = doc.querySelector('#talk-stage');
      return stage.dataset.theme === theme && (stage.dataset.ratio || doc.body.dataset.ratio) === ratio && doc.querySelector('#stage-chat-list').dataset.commentStyle === style && (stage.dataset.commentPanel || 'theme') === panel && parseFloat(getComputedStyle(stage.querySelector('.pokome-comment__body')).fontSize) === fontSize;
    }, { theme, ratio, style: studio.commentStyle, panel: studio.commentPanel, fontSize });
    await page.bringToFront();
    await page.locator('#stage-design-edit').click(); await editorTarget(page, 'chat');
    await page.locator('#preview-ratio').selectOption(ratio);
    const preview = page.frameLocator('#design-preview-frame');
    await preview.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
    const results = [];
    for (const [owner, list] of [[page, talkStage(page).locator('#stage-chat-list')], [page, preview.locator('#stage-chat-list')], [output, output.locator('#stage-chat-list')]]) {
      await owner.bringToFront();
      await owner.waitForTimeout(50);
      await list.evaluate(element => Promise.all([...element.querySelectorAll('img')].map(image => image.decode().catch(() => {}))));
      results.push(await inspect(list, studio.commentMaxLines));
    }
    for (const result of results) {
      assert.ok(result.viewportHeight > 0, `${label}: visible viewport`);
      assert.deepEqual(result.overflow, [], `${label}: overflow/line clamp`);
      assert.deepEqual(result.clipping, [], `${label}: clipping`);
      assert.equal(result.badges, studio.commentStyle === 'anonymous' ? 0 : 4, `${label}: badges only with names`);
      assert.deepEqual(result.partialImages, [], `${label}: whole emotes inside line clamp`);
      assert.deepEqual(result.imageBounds, [], `${label}: images inside chips and panel width`);
      assert.equal(parseFloat(result.fontSize), fontSize, `${label}: requested font size`);
      assert.deepEqual(result.imageOverlap, [], `${label}: wrapped emotes do not cover each other`);
      assert.equal(parseFloat(result.emoteHeight), parseFloat(result.fontSize) * 2, `${label}: emote height`);
    }
    assert.ok(results.every(result => result.color === results[0].color), `${label}: same name color`);
    await page.bringToFront();
    await closeEditor(page);
    combinations++;
  }
  assert.equal(combinations, cases.length);
  t.diagnostic(`Edge: ${cases.length} preset/theme/scheme/ratio/font combinations (FULL_MATRIX=1 runs all 288), each compared across live, preview and output`);
  assert.deepEqual(errors, []);
});

browserTest('one-comment previews retain role and emote samples in both newest positions', async t => {
  const { page } = await fixture(t, { maxVisible: 1, commentBadges: true, commentAuthorColor: 'service' });
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  for (const position of ['bottom', 'top']) {
    await page.locator('#draft-newestPosition').selectOption(position);
    await frame.locator('#stage-chat-list .stage-comment').waitFor({ state: 'attached' });
    assert.equal(await frame.locator('#stage-chat-list .stage-comment').count(), 1);
    assert.equal(await frame.locator('#stage-chat-list img.pokome-comment__emote').count(), 1, `${position}: emote sample`);
    assert.equal(await frame.locator('#stage-chat-list .pokome-comment__badge').count(), 4, `${position}: role samples`);
  }
});
browserTest('emotes are twice the text height, preserve their image ratio and remain whole inside clamped chips', async t => {
  const { page } = await fixture(t, { fontSize: 64, commentMaxLines: 2, commentLineHeight: 1.2, commentItemBackground: 'light' });
  await receive(page, 'Kappa Kappa', 'emotes=25:0-4,6-10');
  await page.locator('#enter-talk').click();
  await page.waitForFunction(() => [...document.getElementById('talk-frame').contentDocument.querySelectorAll('#stage-chat-list img')].every(image => image.complete && image.naturalHeight));
  const measured = await talkStage(page).locator('#stage-chat-list .stage-comment').first().evaluate(card => {
    const body = card.querySelector('p'), bounds = body.getBoundingClientRect(), cardBounds = card.getBoundingClientRect();
    return { font: parseFloat(getComputedStyle(body).fontSize), images: [...body.querySelectorAll('img')].map(image => {
      const rect = image.getBoundingClientRect(), style = getComputedStyle(image);
      return { height: parseFloat(style.height), width: parseFloat(style.width), ratio: image.naturalWidth / image.naturalHeight, src: image.getAttribute('src'),
        inBody: rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
        inCard: rect.top >= cardBounds.top - 1 && rect.bottom <= cardBounds.bottom + 1 && rect.left >= cardBounds.left - 1 && rect.right <= cardBounds.right + 1 };
    }) };
  });
  assert.equal(measured.font, 64);
  assert.equal(measured.images.length, 2);
  for (const image of measured.images) {
    assert.equal(image.height, measured.font * 2, 'Twitch-sized emote');
    assert.ok(Math.abs(image.width / image.height - image.ratio) < .01, 'intrinsic aspect ratio');
    assert.ok(image.src.endsWith('/3.0'), 'high-resolution image');
    assert.ok(image.inBody, 'line clamp preserves the full image');
    assert.ok(image.inCard, 'image stays inside the chip');
  }
});
