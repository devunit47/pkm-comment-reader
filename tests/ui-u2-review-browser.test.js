import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, closeBrowser, appReady, blockExternalFonts, openSettings, readSettings, waitForSettings } from './browser-support.js';

// Layout changes must preserve U1 parts and the behaviour of moved controls.
const browserTest = (name, run, options = {}) => test(name, { skip: !browserAvailable, ...options }, run);
let masterCSS = null;
try { masterCSS = execFileSync('git', ['show', 'master:style.css'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { /* No master ref. */ }

async function fixture(t, { viewport = { width: 1440, height: 1000 }, init } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-u2-review-'));
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data') });
  let browser;
  t.after(async () => { await closeBrowser(browser); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await blockExternalFonts(page);
  await page.addInitScript(() => {
    window.qaSockets = [];
    window.WebSocket = class { constructor(url) { this.url = url; window.qaSockets.push(this); } send() {} close() { this.closed = true; } };
  });
  if (init) await init(page);
  await page.goto(base); await appReady(page);
  return { page, base, errors, browser };
}

// U1 built the button, menu, input and badge parts; U2 must not restyle them.
browserTest('U1 operating parts keep the master computed styles', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => closeBrowser(browser));
  const branchCSS = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  const markup = `<main><section class="panel"><div class="panel-heading"><h2>見出し</h2></div>
    <button class="button" id="plain">ふつう</button><button class="button primary" id="primary">主</button>
    <button class="button full" id="stop-speech">止める</button><button class="text-button" id="text">文字</button>
    <button class="platform-tab" id="service">サービス</button><button class="platform-tab active" id="service-active">選択中</button><button class="platform-tab kick active" id="kick-active">Kick</button>
    <input id="field"><select id="choice"><option>a</option></select>
    <label class="setting-row">切替<input id="switch" type="checkbox" role="switch"></label>
    <span id="badge" class="connection-badge" data-state="connected">接続済み</span><p class="muted" id="muted">補助</p><div class="comment selected" id="selected-row"><span class="time" id="time">21:00</span></div></section>
    <div id="user-actions"><strong id="selected-user">名前</strong><div class="mod-buttons">
    <button id="hide-user" class="danger">非表示</button><button id="pin-comment" class="warning" type="button">固定</button>
    <button id="hide-comment" class="danger">コメント非表示</button><button id="mute-user" class="warning">除外</button></div></div></main>`;
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderRadius', 'fontWeight'];
  const ids = ['plain', 'primary', 'stop-speech', 'text', 'service', 'service-active', 'kick-active', 'field', 'choice', 'switch', 'badge', 'muted', 'hide-user', 'pin-comment', 'hide-comment', 'mute-user', 'user-actions', 'selected-row', 'time'];
  const differences = [];
  for (const colorScheme of ['dark', 'light']) {
    const results = {};
    for (const [variant, css] of [['master', masterCSS], ['branch', branchCSS]]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      // Transitions are disabled so the hover colour can be read without waiting.
      await page.setContent(`<!doctype html><html lang="ja"><head><style>${css.replace(/^@import[^\r\n]*/gm, '')}</style><style>*{transition:none!important}</style></head><body>${markup}</body></html>`);
      results[variant] = await page.evaluate(({ ids, props }) => Object.fromEntries(ids.map(id => {
        const style = getComputedStyle(document.getElementById(id));
        return [id, Object.fromEntries(props.map(prop => [prop, style[prop]]))];
      })), { ids, props });
      for (const id of ['plain', 'primary', 'stop-speech', 'text', 'hide-user', 'pin-comment', 'hide-comment', 'mute-user']) {
        await page.hover('#' + id);
        results[variant][id + ':hover'] = { backgroundColor: await page.locator('#' + id).evaluate(element => getComputedStyle(element).backgroundColor) };
      }
      await page.close();
    }
    for (const [id, style] of Object.entries(results.master)) {
      for (const [prop, value] of Object.entries(style)) {
        if (results.branch[id][prop] !== value) differences.push(`${colorScheme} #${id} ${prop}: master=${value} branch=${results.branch[id][prop]}`);
      }
    }
  }
  assert.deepEqual(differences, []);
}, { skip: (!browserAvailable || !masterCSS) && 'browser or master stylesheet unavailable' });

browserTest('home card connects with Enter, hides the input while connected and restores it after disconnect', async t => {
  const { page, base, errors } = await fixture(t);
  assert.equal(await page.locator('#preferences-page #twitch-channel, #preferences-page #kick-channel').count(), 0, 'no channel input outside home');
  await page.locator('#twitch-channel').fill('qa_enter');
  await page.locator('#twitch-channel').press('Enter');
  await page.waitForFunction(() => window.qaSockets.length === 1);
  await page.evaluate(() => window.qaSockets[0].onmessage({ data: ':server 366 user #qa_enter :End of names' }));
  await page.locator('#twitch-tab-status').filter({ hasText: '接続済み' }).waitFor();
  assert.equal(await page.locator('#twitch-channel').isVisible(), false, 'connected card hides the channel input');
  assert.equal(await page.locator('#twitch-tab-channel').textContent(), '#qa_enter');
  assert.equal(await page.locator('#twitch-connection-toggle').textContent(), '切断');
  assert.equal(await page.locator('#demo').isVisible(), false, 'demo button only while disconnected');
  await waitForSettings(base, settings => settings.connections.twitch === 'qa_enter');
  await page.locator('#twitch-connection-toggle').click();
  assert.equal(await page.evaluate(() => window.qaSockets[0].closed), true);
  assert.equal(await page.locator('#twitch-channel').isVisible(), true);
  assert.equal(await page.locator('#twitch-channel').inputValue(), 'qa_enter', 'the saved channel stays in the input');
  assert.equal(await page.locator('#twitch-connection-toggle').textContent(), '接続する');
  // The saved channel comes back after a reload too (existing behaviour).
  await page.reload(); await appReady(page);
  assert.equal(await page.locator('#twitch-channel').inputValue(), 'qa_enter');
  assert.deepEqual(errors, []);
});

browserTest('talk mode connection dialog borrows the home card and puts it back in order', async t => {
  const { page, errors } = await fixture(t);
  const order = () => page.locator('#home-connections > *').evaluateAll(items => items.map(item => item.id || item.querySelector('form')?.id || item.className));
  const before = await order();
  await page.locator('#enter-talk').click();
  await page.locator('#talk-controls').hover();
  await page.locator('#stage-connection').click();
  await page.locator('#stage-connection-dialog #twitch-connect-form').waitFor();
  assert.equal(await page.locator('#twitch-channel').evaluate(element => element === document.activeElement), true);
  await page.locator('#close-stage-connection').click();
  // The dialog's close event is queued, so wait for the card to come back.
  await page.locator('#home-connections #twitch-connect-form').waitFor({ state: 'attached' });
  assert.deepEqual(await order(), before);
  await page.locator('#leave-talk').click();
  assert.equal(await page.locator('#home-connections #twitch-connect-form').isVisible(), true);
  assert.deepEqual(errors, []);
});

browserTest('signed-in Twitch account appears on the home card while login controls live in settings', async t => {
  const { page, errors } = await fixture(t, { init: page => page.route('**/api/auth/twitch', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { status: 'signed-in', displayName: 'QA表示名', login: 'qa_login' } }) : route.continue()) });
  await page.locator('#twitch-account').filter({ hasText: 'QA表示名' }).waitFor();
  assert.equal(await page.locator('#home-connections #twitch-account').isVisible(), true);
  assert.equal(await page.locator('#home-page #twitch-login-logout').count(), 0);
  await openSettings(page, 'connection');
  assert.equal(await page.locator('#settings-connection #twitch-login-logout').isVisible(), true);
  assert.deepEqual(errors, []);
});

browserTest('settings service switch appears only for per-service sections and keeps options per service', async t => {
  const { page, base, errors } = await fixture(t);
  for (const [section, shown] of [['connection', false], ['speech', true], ['users', true], ['backup', false]]) {
    await openSettings(page, section);
    assert.equal(await page.locator('#settings-platform-control').isVisible(), shown, section);
  }
  await openSettings(page, 'speech');
  await page.locator('#settings-platform').selectOption('kick');
  assert.equal(await page.locator('#chat-platform').textContent(), 'Kick', 'switching in settings switches the home service');
  await page.locator('#max-length').fill('77'); await page.locator('#max-length').dispatchEvent('change');
  await waitForSettings(base, settings => settings.speechOptions?.kick?.maxLength === 77);
  await page.locator('#settings-platform').selectOption('twitch');
  assert.equal(await page.locator('#max-length').inputValue(), '100');
  // Switching on home is reflected in the settings selector.
  await page.locator('[data-page="home"]').click();
  await page.locator('[data-platform="kick"]').click();
  await openSettings(page, 'users');
  assert.equal(await page.locator('#settings-platform').inputValue(), 'kick');
  assert.equal(await page.locator('#users-platform').textContent(), 'Kick');
  // Reopening settings returns to the connection section.
  await page.locator('[data-page="home"]').click();
  await page.locator('[data-page="settings"]').click();
  assert.equal(await page.locator('#settings-connection').isVisible(), true);
  assert.equal(await page.locator('#settings-users').isVisible(), false);
  assert.equal((await readSettings(base)).speechOptions.kick.maxLength, 77);
  assert.deepEqual(errors, []);
});

function pageIssues() {
  const width = document.documentElement.clientWidth;
  const overflow = document.documentElement.scrollWidth > width + 1;
  const outside = [...document.querySelectorAll('#app-header *, #setup-reminder *, main *, dialog[open] *')].filter(node => {
    if (!node.checkVisibility() || !node.matches('button,input,select,label,p,h2,h3,a,summary')) return false;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX) && parent !== document.body && parent !== document.documentElement) {
        const clip = parent.getBoundingClientRect(); if (clip.right <= width + 1 && clip.left >= -1) return false;
      }
    }
    return box.left < -1 || box.right > width + 1;
  }).map(node => node.id || `${node.tagName}.${node.className}`);
  return { overflow, outside };
}

function contrastFailures() {
  const rgb = value => { const match = value.match(/rgba?\(([^)]+)\)/); if (!match) return null; const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }; };
  const channel = value => { const c = value / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  const luminance = color => .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
  const background = element => {
    for (let node = element; node; node = node.parentElement || node.getRootNode().host) {
      const color = rgb(getComputedStyle(node).backgroundColor); if (color && color.a > .5) return color;
    }
    return rgb(getComputedStyle(document.body).backgroundColor);
  };
  const failures = [];
  for (const element of document.querySelectorAll('#app-header *, #setup-reminder *, dialog[open] *, #user-actions:popover-open *, .connection-card *')) {
    if (!element.matches('h2,h3,p,small,strong,label,button,a,span,li,summary') || !element.checkVisibility() || element.matches(':disabled')) continue;
    if (![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) continue;
    const view = getComputedStyle(element), color = rgb(view.color), bg = background(element);
    const ratio = (Math.max(luminance(color), luminance(bg)) + .05) / (Math.min(luminance(color), luminance(bg)) + .05);
    const large = parseFloat(view.fontSize) >= 24;
    if (ratio < (large ? 3 : 4.5)) failures.push(`${element.id || element.tagName}:${element.textContent.trim().slice(0, 12)} ${ratio.toFixed(2)}`);
    if (parseFloat(view.fontSize) < 12) failures.push(`${element.id || element.tagName}:${element.textContent.trim().slice(0, 12)} font ${view.fontSize}`);
  }
  return failures;
}

browserTest('connected cards, setup dialog and user menu fit narrow docks and stay readable in both schemes', async t => {
  const { page, errors } = await fixture(t);
  // A connected card and a comment make the connected badge and the menu reachable.
  await page.locator('#twitch-channel').fill('qa_narrow'); await page.locator('#twitch-connection-toggle').click();
  await page.waitForFunction(() => window.qaSockets.length === 1);
  await page.evaluate(() => {
    window.qaSockets[0].onmessage({ data: ':server 366 user #qa_narrow :End of names' });
    window.qaSockets[0].onmessage({ data: '@display-name=QA;user-id=1;id=m1;tmi-sent-ts=1 :qa!qa@qa.tmi.twitch.tv PRIVMSG #qa_narrow :こんにちは' });
  });
  await page.locator('#twitch-tab-status').filter({ hasText: '接続済み' }).waitFor();
  const problems = [];
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 300, 150]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['home', 'setup', 'menu']) {
        if (view === 'setup') { await page.locator('[data-page="home"]').click(); await page.locator('#open-setup').click(); await page.locator('#setup-dialog #edition-capabilities').waitFor(); }
        else if (view === 'menu') { await page.locator('[data-page="home"]').click(); await page.locator('#comment-list .username').first().click(); await page.locator('#user-actions').waitFor(); }
        else await page.locator(`[data-page="${view}"]`).click();
        // Colour-scheme switches start background transitions; measure settled colours.
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
        const issues = await page.evaluate(pageIssues);
        if (issues.overflow || issues.outside.length) problems.push(`${colorScheme} ${width}px ${view} overflow=${issues.overflow} outside=${issues.outside.join(',')}`);
        if (width === 1440) for (const failure of await page.evaluate(contrastFailures)) problems.push(`${colorScheme} ${view} contrast ${failure}`);
        if (view === 'setup') await page.locator('#close-setup').click();
        if (view === 'menu') await page.keyboard.press('Escape');
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(errors, []);
});
