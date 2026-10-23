import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { openSettings, closeBrowser, chromium, executablePath, browserAvailable, appReady, blockExternalFonts, saveSetting, saveDesign, matrixCases } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, options = {}, ports = 1) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-login-browser-'));
  const servers = Array.from({ length: ports }, () => createServer({ ...options,
    dataDirectory: join(folder, 'data'), customizationDirectory: join(folder, 'customization') }));
  let browser;
  t.after(async () => {
    await closeBrowser(browser);
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    await rm(folder, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const bases = [];
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    bases.push(`http://127.0.0.1:${server.address().port}`);
  }
  const errors = [];
  async function open(base = bases[0], prepare) {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      window.testSockets = [];
      window.testStreams = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) { super(url, options); window.testStreams.push(url); }
      };
      window.WebSocket = class {
        constructor(url) { this.url = url; this.sent = []; window.testSockets.push(this); }
        send(text) { this.sent.push(text); }
        close() { this.closed = true; }
      };
    });
    await blockExternalFonts(page);
    page.on('pageerror', error => errors.push(error.message));
    await prepare?.(page);
    await page.goto(base); await appReady(page); await openSettings(page);
    return page;
  }
  async function restart() {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    const server = createServer({ ...options, dataDirectory: join(folder, 'data'), customizationDirectory: join(folder, 'customization') });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  return { bases, open, errors, restart };
}
const stateIs = (page, status) => page.locator(`#twitch-login[data-status="${status}"]`).waitFor();
async function snapshot(page, name) {
  if (!process.env.LOGIN_QA_DIRECTORY) return;
  await mkdir(process.env.LOGIN_QA_DIRECTORY, { recursive: true });
  await page.screenshot({ path: join(process.env.LOGIN_QA_DIRECTORY, `${name}.png`), fullPage: true });
  await page.locator('#twitch-login').screenshot({ path: join(process.env.LOGIN_QA_DIRECTORY, `${name}-login.png`) });
}

browserTest('Twitch login states stay in settings and fit regular and 150px dock widths', async t => {
  const { bases, open, errors } = await fixture(t);
  const states = {
    disabled: { status: 'disabled' },
    'signed-out': { status: 'signed-out' },
    pending: { status: 'pending', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD-EFGH', expiresAt: Date.now() + 600000 },
    'signed-in': { status: 'signed-in', displayName: '<img src=x onerror=alert(1)>長い表示名', login: 'a_long_twitch_account_name' },
    'signing-out': { status: 'signing-out' },
    reauth: { status: 'reauth', reason: '保存したログイン情報を読めません。別の PC や Windows ユーザーでは再ログインしてください。' },
  };
  let state = states.disabled;
  const page = await open(undefined, async page => {
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) { super(url, options); if (url === '/api/settings/events') window.loginEvents = this; }
      };
    });
    await page.route('**/api/auth/twitch', route => route.fulfill({ json: state }));
  });
  await stateIs(page, 'disabled');
  for (const { status, width, colorScheme } of matrixCases({ status: Object.keys(states), width: [1440, 150], colorScheme: ['dark', 'light'] })) {
    state = states[status];
    await page.evaluate(() => window.loginEvents.dispatchEvent(new MessageEvent('auth', { data: '{"revision":0}' })));
    await stateIs(page, status);
    await page.emulateMedia({ colorScheme });
    await page.emulateMedia({ colorScheme });
    const appearance = () => page.locator(['main', '#app-header', '.workspace', '#twitch-login', '#twitch-login-status'].join(',')).evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return { id: element.id || element.className, color: style.color, background: style.backgroundColor, border: style.borderColor, visible: element.checkVisibility() };
    }));
    await saveDesign(bases[0], design => ({ ...design, theme: '' }));
    await page.waitForFunction(() => !document.getElementById('pokome-user-theme').textContent);
    const before = await appearance();
    for (const css of [
      '.pokome-workspace { --ui-text: red; --ui-bg: blue; --ui-surface: lime; color: red !important; background: blue !important; } .pokome-workspace button, .pokome-workspace input { color: red !important; background: lime !important; }',
      '.pokome-workspace { display: none !important; } .pokome-workspace .pokome-panel { visibility: hidden !important; }',
    ]) {
      await saveDesign(bases[0], design => ({ ...design, theme: css }));
      await page.waitForFunction(css => {
        const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
        return document.getElementById('pokome-user-theme').textContent === [...sheet.cssRules].map(rule => rule.cssText).join('\n');
      }, css);
      assert.deepEqual(await appearance(), before, colorScheme + ' theme CSS leaves operating colors and visibility unchanged');
    }
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('#twitch-login').isVisible(), true, 'login is directly visible in settings connection');
    assert.match(await page.locator('#twitch-login').textContent(), /バッジ画像を使うため。コメントの受信には不要/);
    if (status === 'disabled') {
      assert.match(await page.locator('#twitch-login-status').textContent(), /このビルドでは Twitch のログインを使えません/);
      assert.equal(await page.locator('#twitch-login-start').isDisabled(), true);
    }
    if (status === 'pending') {
      assert.equal(await page.locator('#twitch-login-code').textContent(), 'ABCD-EFGH');
      assert.equal(await page.locator('#twitch-login-link').getAttribute('href'), states.pending.verification_uri);
      assert.equal(await page.locator('#twitch-login-link').getAttribute('target'), '_blank');
      assert.equal(await page.locator('#twitch-login-link').getAttribute('rel'), 'noopener noreferrer');
      assert.match(await page.locator('#twitch-login-remaining').textContent(), /残り/);
      assert.match(await page.locator('#twitch-login').textContent(), /OBS.*通常のブラウザ/);
      await page.locator('#twitch-login-cancel').click({ trial: true });
    }
    if (status === 'signed-in') {
      assert.match(await page.locator('#twitch-login-status').textContent(), /<img src=x onerror=alert\(1\)>/);
      assert.equal(await page.locator('#twitch-login img').count(), 0);
      assert.equal(await page.locator('#twitch-login-logout').isVisible(), true);
    }
    if (status === 'reauth') {
      assert.match(await page.locator('#twitch-login-status').textContent(), /別の PC/);
      assert.equal(await page.locator('#twitch-login-start').textContent(), '再ログイン');
    }
    if (status === 'signing-out') {
      assert.equal(await page.locator('#twitch-login-status').textContent(), 'ログアウトしています…');
      assert.equal(await page.locator('#twitch-login-start').isVisible(), false);
      assert.equal(await page.locator('#twitch-login-logout').isDisabled(), true);
    }
    const issues = await page.locator('#twitch-login').evaluate(root => [root, ...root.querySelectorAll('*')]
      .filter(node => node.checkVisibility()).flatMap(node => {
        const box = node.getBoundingClientRect();
        return box.left < -1 || box.right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1
          ? [node.id || node.tagName] : [];
      }));
    assert.deepEqual(issues, [], `${status} ${width}px ${colorScheme}`);
    await snapshot(page, `${status}-${width}-${colorScheme}`);
  }
  assert.deepEqual(errors, []);
});

browserTest('login commands handle busy, cancel, failed operations, countdown and unsafe activation URLs', async t => {
  const { open, errors } = await fixture(t);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let state = { status: 'signed-out' }, failed = true;
  const actions = [];
  const page = await open(undefined, async page => {
    const fixedTime = new Date('2026-10-12T00:00:00Z');
    await page.clock.install({ time: fixedTime }); await page.clock.pauseAt(fixedTime);
    await page.route('**/api/auth/twitch', async route => {
      if (route.request().method() === 'POST') {
        const { action } = route.request().postDataJSON(); actions.push(action);
        if (action === 'start' && failed) { started.resolve(); await release.promise; return route.fulfill({ status: 502, json: { error: 'private-upstream-secret' } }); }
        state = action === 'start' ? { status: 'pending', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate', expiresAt: await page.evaluate(() => Date.now() + 60000) } : { status: 'signed-out' };
      }
      await route.fulfill({ json: state });
    });
  });
  await stateIs(page, 'signed-out');
  await page.locator('#twitch-login-start').click(); await started.promise;
  assert.equal(await page.locator('#twitch-login-start').isDisabled(), true);
  release.resolve();
  await page.locator('#twitch-login-error').filter({ hasText: '完了できません' }).waitFor();
  assert.doesNotMatch(await page.locator('#twitch-login').textContent(), /private-upstream-secret/);
  await page.locator('#twitch-login-start:not(:disabled)').waitFor();
  await page.locator('#twitch-login-retry').click();
  await page.locator('#twitch-login-error').waitFor({ state: 'hidden' });
  failed = false;
  await page.locator('#twitch-login-start').click(); await stateIs(page, 'pending');
  await page.clock.runFor(1000);
  assert.match(await page.locator('#twitch-login-remaining').textContent(), /残り 0分59秒/);
  await page.locator('#twitch-login-cancel').click(); await stateIs(page, 'signed-out');
  state = { status: 'pending', user_code: 'ABCD-EFGH', verification_uri: 'javascript:alert(1)', expiresAt: Date.now() + 60000 };
  await page.reload(); await appReady(page); await openSettings(page);
  await page.locator('#twitch-login-error').filter({ hasText: '状態を確認できません' }).waitFor();
  assert.equal(await page.locator('#twitch-login-link').getAttribute('href'), null);
  assert.deepEqual(actions, ['start', 'start', 'cancel']);
  assert.deepEqual(errors, []);
});

browserTest('queued stale reads cannot undo optimistic logout and failed POST restores the actual state', async t => {
  const { open, errors } = await fixture(t);
  const readStarted = Promise.withResolvers(), staleRead = Promise.withResolvers();
  const postStarted = Promise.withResolvers(), failedPost = Promise.withResolvers();
  let reads = 0;
  const page = await open(undefined, async page => {
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) { super(url, options); if (url === '/api/settings/events') window.loginEvents = this; }
      };
    });
    await page.route('**/api/auth/twitch', async route => {
      if (route.request().method() === 'POST') {
        postStarted.resolve(); await failedPost.promise;
        return route.fulfill({ status: 503, json: { error: 'private-failure' } });
      }
      if (++reads === 2) { readStarted.resolve(); await staleRead.promise; }
      return route.fulfill({ json: { status: 'signed-in', login: 'viewer', displayName: '確認アカウント' } });
    });
  });
  try {
    await stateIs(page, 'signed-in');
    await page.evaluate(() => window.loginEvents.dispatchEvent(new MessageEvent('auth', { data: '{"revision":0}' })));
    await readStarted.promise;
    await page.locator('#twitch-login-logout').click();
    await stateIs(page, 'signing-out');
    staleRead.resolve(); await postStarted.promise;
    assert.equal(await page.locator('#twitch-login').getAttribute('data-status'), 'signing-out');
    assert.equal(await page.locator('#twitch-login-logout').isDisabled(), true);
    failedPost.resolve(); await stateIs(page, 'signed-in');
    await page.locator('#twitch-login-error').filter({ hasText: '完了できません' }).waitFor();
    assert.equal(await page.locator('#twitch-login-logout').isDisabled(), false);
    assert.doesNotMatch(await page.locator('#twitch-login').textContent(), /private-failure/);
    assert.deepEqual(errors, []);
  } finally { staleRead.resolve(); failedPost.resolve(); }
});

browserTest('stalled or failed login requests leave app startup and anonymous Twitch reception working', async t => {
  const { bases, open, errors } = await fixture(t);
  await saveSetting(bases[0], 'connections', { twitch: 'anonymous_channel', kick: '' });
  const release = Promise.withResolvers();
  const page = await open(undefined, page => page.route('**/api/auth/twitch', async route => {
    await release.promise; await route.fulfill({ status: 503, json: { error: 'private-upstream-secret' } });
  }));
  await page.locator('[data-page="home"]').click();
  await page.locator('#twitch-connection-toggle').click();
  await page.evaluate(() => {
    const socket = window.testSockets[0]; socket.onopen();
    socket.onmessage({ data: ':server 366 user #anonymous_channel :End of names' });
    socket.onmessage({ data: '@display-name=視聴者 :viewer!viewer@host PRIVMSG #anonymous_channel :ログインの応答待ちでも受信' });
  });
  await page.locator('#comment-list .message').filter({ hasText: 'ログインの応答待ちでも受信' }).waitFor();
  assert.ok((await page.evaluate(() => window.testSockets[0].sent)).some(line => /^NICK justinfan/.test(line)));
  release.resolve();
  await openSettings(page);
  await page.locator('#twitch-login-error').filter({ hasText: '状態を確認できません' }).waitFor();
  await page.locator('[data-page="home"]').click();
  await page.evaluate(() => window.testSockets[0].onmessage({ data: '@display-name=視聴者 :viewer!viewer@host PRIVMSG #anonymous_channel :ログインが失敗しても受信' }));
  await page.locator('#comment-list .message').filter({ hasText: 'ログインが失敗しても受信' }).waitFor();
  assert.equal(await page.evaluate(() => !!window.testSockets[0].closed), false);
  assert.deepEqual(errors, []);
});

browserTest('fake Twitch login, cancellation, reauthentication and logout synchronize two tabs and another port', async t => {
  let now = Date.now(), next = 0, authorized = false, invalid = false;
  const timers = new Map(), calls = [];
  const clock = { now: () => now, setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    async tick(ms) { const end = now + ms; for (;;) { const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; timers.delete(entry[0]); now = entry[1].at; await entry[1].fn(); } now = end; } };
  const json = (status, data) => new Response(JSON.stringify(data), { status });
  const { bases, open, errors } = await fixture(t, { twitchClientId: 'browser-test-client', authClock: clock, authPlatform: 'linux',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/device')) return json(200, { device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
      if (url.endsWith('/token')) return invalid ? json(400, { message: 'invalid refresh token' }) : authorized ? json(200, { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 14400, scope: [], token_type: 'bearer' }) : json(400, { message: 'authorization_pending' });
      if (url.endsWith('/validate')) return invalid ? json(401, { message: 'invalid access token' }) : json(200, { client_id: 'browser-test-client', login: 'test_login', user_id: '123', scopes: [], expires_in: 14400 });
      if (url.endsWith('/users')) return json(200, { data: [{ id: '123', login: 'test_login', display_name: '確認アカウント' }] });
      if (url.endsWith('/revoke')) return json(503, { error: 'temporary failure' });
      throw new Error('Unexpected fake Twitch endpoint');
    } }, 2);
  const pages = [await open(bases[0]), await open(bases[0]), await open(bases[1])];
  const all = status => Promise.all(pages.map(page => stateIs(page, status)));
  await all('signed-out');
  for (const page of pages) assert.deepEqual((await page.evaluate(() => window.testStreams)).sort(), ['/api/design/events', '/api/settings/events']);
  await pages[0].locator('#twitch-login-start').click(); await all('pending');
  await pages[1].locator('#twitch-login-cancel').click(); await all('signed-out');
  await pages[0].locator('#twitch-login-start').click(); await all('pending');
  authorized = true; await clock.tick(5000); await all('signed-in');
  for (const page of pages) assert.match(await page.locator('#twitch-login-status').textContent(), /確認アカウント/);
  invalid = true; await clock.tick(3600000); await all('reauth');
  invalid = false; await pages[2].locator('#twitch-login-start').click(); await all('pending');
  await clock.tick(5000); await all('signed-in');
  await pages[1].locator('#twitch-login-logout').click(); await all('signed-out');
  assert.equal(calls.filter(call => call.url.endsWith('/revoke')).length, 1);
  for (const page of pages) assert.doesNotMatch(await page.locator('#twitch-login').textContent(), /private-(access|refresh|device)/);
  assert.deepEqual(errors, []);
});

function fakeTwitchSession() {
  let now = Date.now(), next = 0;
  const timers = new Map(), calls = [];
  const clock = { now: () => now, setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    async tick(ms) { const end = now + ms; for (;;) { const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; timers.delete(entry[0]); now = entry[1].at; await entry[1].fn(); } now = end; } };
  const json = (status, data) => new Response(JSON.stringify(data), { status });
  const fake = { clock, calls, validation: 'ok', devices: 0 };
  fake.options = { twitchClientId: 'browser-test-client', authClock: clock, authPlatform: 'win32',
    authProtect: async bytes => Buffer.from(bytes).map(byte => byte ^ 91),
    authUnprotect: async bytes => Buffer.from(bytes).map(byte => byte ^ 91),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/device')) return json(200, { device_code: `private-device-${++fake.devices}`, user_code: `CODE-000${fake.devices}`, verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
      if (url.endsWith('/token')) return json(200, { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 14400, scope: [], token_type: 'bearer' });
      if (url.endsWith('/validate')) {
        if (fake.validation === 'network') throw new Error('Simulated connection failure');
        if (fake.validation === '503') return json(503, { message: 'Temporary service failure' });
        return json(200, { client_id: 'browser-test-client', login: 'test_login', user_id: '123', scopes: [], expires_in: 14400 });
      }
      if (url.endsWith('/users')) return json(200, { data: [{ id: '123', login: 'test_login', display_name: '確認アカウント' }] });
      throw new Error('Unexpected fake Twitch endpoint');
    } };
  return fake;
}

browserTest('temporary Twitch validation failures keep the account logged in and recover after five minutes', async t => {
  const fake = fakeTwitchSession();
  const { bases, open, errors } = await fixture(t, fake.options);
  const page = await open();
  await stateIs(page, 'signed-out');
  await page.locator('#twitch-login-start').click(); await stateIs(page, 'pending');
  await fake.clock.tick(5000); await stateIs(page, 'signed-in');
  const validations = () => fake.calls.filter(call => call.url.endsWith('/validate')).length;
  for (const failure of ['503', 'network']) {
    fake.validation = failure;
    const before = validations();
    await fake.clock.tick(3600000);
    assert.equal(validations(), before + 1);
    assert.equal((await (await fetch(`${bases[0]}/api/auth/twitch`)).json()).status, 'signed-in', `${failure} retains the account`);
    await page.reload(); await appReady(page); await openSettings(page); await stateIs(page, 'signed-in');
    assert.match(await page.locator('#twitch-login-status').textContent(), /ログイン中：確認アカウント/);
    await fake.clock.tick(299999); assert.equal(validations(), before + 1);
    fake.validation = 'ok'; await fake.clock.tick(1);
    assert.equal(validations(), before + 2, 'validation retries once after five minutes');
    await stateIs(page, 'signed-in');
    assert.equal(await page.locator('#twitch-login-start').isVisible(), false);
  }
  assert.equal(fake.calls.filter(call => call.url.endsWith('/device')).length, 1);
  assert.equal(fake.calls.filter(call => call.url.endsWith('/token')).length, 1, 'temporary validation failures do not refresh tokens');
  assert.deepEqual(errors, []);
});

browserTest('restarting a server during device authorization clears the stale code and lets a new login start', async t => {
  const fake = fakeTwitchSession();
  const { bases, open, errors, restart } = await fixture(t, fake.options);
  const page = await open();
  await stateIs(page, 'signed-out');
  await page.locator('#twitch-login-start').click(); await stateIs(page, 'pending');
  assert.equal(await page.locator('#twitch-login-code').textContent(), 'CODE-0001');
  const base = await restart();
  assert.notEqual(base, bases[0], 'restart uses another port and the same private folders');
  await page.goto(base); await appReady(page); await openSettings(page);
  assert.equal((await (await fetch(`${base}/api/auth/twitch`)).json()).status, 'signed-out');
  await stateIs(page, 'signed-out');
  assert.equal(await page.locator('#twitch-login-start').isVisible(), true);
  assert.equal(await page.locator('#twitch-login-start').isDisabled(), false);
  assert.equal(await page.locator('#twitch-login-pending').isVisible(), false);
  assert.equal(await page.locator('#twitch-login-code').textContent(), '');
  await fake.clock.tick(5000);
  assert.equal(fake.calls.filter(call => call.url.endsWith('/token')).length, 0, 'old authorization is never resumed');
  await page.locator('#twitch-login-start').click(); await stateIs(page, 'pending');
  assert.equal(await page.locator('#twitch-login-code').textContent(), 'CODE-0002');
  assert.equal(fake.devices, 2);
  assert.deepEqual(errors, []);
});
