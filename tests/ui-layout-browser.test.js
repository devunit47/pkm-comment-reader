import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, closeBrowser, appReady, blockExternalFonts, applyInEditor, saveDesign, saveSetting } from './browser-support.js';

async function fixture(t, { initScript } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-layout-'));
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data') });
  let browser;
  t.after(async () => { await closeBrowser(browser); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => process.stderr.write(error.stack + '\n'));
  page.setDefaultTimeout(5000);
  await blockExternalFonts(page);
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`http://127.0.0.1:${server.address().port}`); await appReady(page);
  return page;
}

test('U2 header exposes five destinations and talk from every page', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  assert.deepEqual(await page.locator('#app-header nav button').allTextContents(), ['ホーム', '配信デザイン', '設定', 'はじめての設定', '更新情報']);
  assert.equal(await page.locator('.sidebar,.side-art,.side-bottom').count(), 0);
  for (const name of ['studio', 'settings', 'updates', 'home']) {
    await page.locator(`[data-page="${name}"]`).click();
    assert.equal(await page.locator(`[data-page="${name}"]`).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#app-header #enter-talk').isVisible(), true);
  }
});

test('U2 settings groups existing controls and setup shortcuts open their new home', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  await page.locator('[data-page=settings]').click();
  assert.deepEqual(await page.locator('[data-settings-section]').allTextContents(), ['接続', '読み上げ', 'ユーザー管理', 'バックアップ']);
  assert.equal(await page.locator('#settings-connection #twitch-login').isVisible(), true);
  assert.equal(await page.locator('#preferences-page [id$="-channel"]').count(), 0);
  await page.locator('[data-settings-section=speech]').click();
  assert.equal(await page.locator('#settings-speech #voice').isVisible(), true);
  assert.equal(await page.locator('#settings-speech #max-length').isVisible(), true);
  await page.locator('[data-settings-section=users]').click();
  assert.equal(await page.locator('#settings-users #user-list').isVisible(), true);
  await page.locator('[data-settings-section=backup]').click();
  assert.equal(await page.locator('#settings-backup .restore-warning #restore-settings').isVisible(), true);
  await page.locator('#open-setup').click();
  await page.locator('#setup-voice').click();
  assert.equal(await page.locator('#voice').evaluate(el => el === document.activeElement), true);
  await page.locator('#open-setup').click();
  await page.locator('#setup-connect').click();
  assert.equal(await page.locator('#home-page #twitch-channel').evaluate(el => el === document.activeElement), true);
});

test('U2 home keeps connection and quick speech beside comments and current selection', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  const columns = await page.locator('#home-page .workspace > *').evaluateAll(items => items.map(item => item.getBoundingClientRect().x));
  assert.equal(columns.length, 3);
  assert.ok(columns[0] < columns[1] && columns[1] < columns[2]);
  assert.equal(await page.locator('#home-connections #twitch-channel').isVisible(), true);
  assert.equal(await page.locator('#home-connections #home-speech #volume').isVisible(), true);
  assert.equal(await page.locator('.stats,.reading,#count,#user-count,#speech-stat,[data-connection-settings],#twitch-disconnect').count(), 0);
  assert.equal(await page.locator('#comment-list #demo').isVisible(), true);
});

test('U2 design puts the applied scene beside OBS and presets below without registering an output', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  await page.locator('[data-page=studio]').click();
  assert.equal(await page.locator('#studio-top > #design-preview-editor').count(), 1);
  assert.equal(await page.locator('#studio-top > #stream-output-panel').count(), 1);
  const sample = page.frameLocator('#current-design-frame');
  await sample.locator('#talk-stage').waitFor({ state: 'attached' });
  assert.equal((await page.locator('#current-design-name').textContent()).trim().length > 0, true);
  assert.equal(await page.locator('#current-design-frame').getAttribute('tabindex'), '-1');
  assert.equal(await page.locator('#output-connection-count').textContent(), '0個');
  await page.getByRole('tab', { name: 'ウィンドウキャプチャ', exact: true }).click();
  assert.equal(await page.locator('#output-background').isVisible(), true);
  await page.getByRole('tab', { name: 'ブラウザソース（おすすめ）', exact: true }).click();
  assert.equal(await page.locator('#output-source-url').isVisible(), true);
  assert.equal(await page.locator('#output-background').isVisible(), false);
  const top = await page.locator('#studio-top').boundingBox(), presets = await page.locator('#design-presets').boundingBox();
  assert.ok(presets.y >= top.y + top.height);
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1080x1920'));
  await sample.locator('#talk-stage').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#output-connection-count').textContent(), '0個');
});

test('U2 setup keeps a compact reminder and edition guidance in the dialog', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('body > #setup-reminder').isVisible(), true);
  assert.equal(await page.locator('#setup-welcome,#settings-connection #edition-capabilities').count(), 0);
  await page.locator('#open-setup').click();
  assert.equal(await page.locator('#setup-dialog #edition-capabilities').isVisible(), true);
  await page.locator('#complete-setup').click();
  assert.equal(await page.locator('#setup-reminder').isVisible(), false);
});

test('applied design sample rejects stored invalid CSS without breaking design updates', { skip: !browserAvailable }, async t => {
  const page = await fixture(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-page=studio]').click();
  await page.frameLocator('#current-design-frame').locator('#talk-stage').waitFor({ state: 'attached' });
  await saveDesign(new URL(page.url()).origin, design => ({ ...design, theme: '@layer blocked {}' }));
  await page.locator('#current-design-error').waitFor({ state: 'visible' });
  await saveDesign(new URL(page.url()).origin, design => ({ ...design, theme: '', name: '更新したデザイン' }));
  await page.locator('#current-design-name').filter({ hasText: '更新したデザイン' }).waitFor();
  assert.equal(await page.locator('#current-design-error').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('home disconnect still works when another screen clears the saved channel', { skip: !browserAvailable }, async t => {
  const page = await fixture(t, { initScript: () => {
    window.WebSocket = class { constructor() { window.qaSocket = this; } send() {} close() { this.closed = true; } };
  } });
  await page.locator('#twitch-channel').fill('qa_channel');
  await page.locator('#twitch-connection-toggle').click();
  await page.evaluate(() => window.qaSocket.onmessage({ data: ':server 366 user #qa_channel :End of names' }));
  await page.locator('#twitch-tab-status').filter({ hasText: '接続済み' }).waitFor();
  await saveSetting(new URL(page.url()).origin, 'connections', { twitch: '', kick: '' });
  await page.waitForFunction(() => document.getElementById('twitch-channel').value === '');
  await page.locator('#twitch-connection-toggle').click();
  assert.equal(await page.evaluate(() => window.qaSocket.closed), true);
});
