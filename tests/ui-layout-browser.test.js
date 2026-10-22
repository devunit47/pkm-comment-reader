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
