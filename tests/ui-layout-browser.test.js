import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, closeBrowser, appReady, blockExternalFonts } from './browser-support.js';

async function fixture(t) {
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

