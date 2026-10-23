import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, closeBrowser, appReady, blockExternalFonts } from './browser-support.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-details-'));
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

test('U3 comment filter buttons preserve search, service state and keyboard selection without saving', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  const buttons = page.locator('#comment-filters button');
  assert.equal(await buttons.count(), 2);
  assert.equal(await page.locator('select#filter').count(), 0);
  assert.deepEqual(await buttons.allTextContents(), ['すべてのコメント', '初コメント']);
  await page.locator('#demo').click();
  const allCount = await page.locator('#comment-list .comment').count();
  await page.locator('[data-comment-filter=first]').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('[data-comment-filter=first]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-comment-filter=all]').getAttribute('aria-pressed'), 'false');
  const firstCount = await page.locator('#comment-list .comment').count();
  assert.ok(firstCount > 0 && firstCount <= allCount);
  await page.locator('#search').fill('存在しない検索語');
  assert.equal(await page.locator('#comment-list .comment').count(), 0);
  await page.locator('[data-platform=kick]').click();
  assert.equal(await page.locator('[data-comment-filter=all]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-platform=twitch]').click();
  assert.equal(await page.locator('[data-comment-filter=first]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#search').inputValue(), '存在しない検索語');
  await page.locator('#search').fill('');
  assert.equal(await page.locator('#comment-list .comment').count(), firstCount);
  await page.locator('[data-comment-filter=all]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#comment-list .comment').count(), allCount);
  await page.reload(); await appReady(page);
  assert.equal(await page.locator('[data-comment-filter=all]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#search').inputValue(), '');
});
