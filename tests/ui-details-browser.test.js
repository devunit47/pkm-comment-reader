import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { chromium, executablePath, browserAvailable, closeBrowser, appReady, blockExternalFonts, saveSetting, waitForSettings, openSettings, saveDesign, editorTarget } from './browser-support.js';

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
  await page.addInitScript(() => {
    window.qaSockets = [];
    window.WebSocket = class { constructor() { window.qaSockets.push(this); } send() {} close() {} };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await appReady(page);
  return page;
}

test('U3 comment filter buttons preserve search, service state and keyboard selection without saving', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  const buttons = page.locator('#comment-filters button');
  assert.equal(await buttons.count(), 2);
  assert.equal(await page.locator('#home-page .filters select').count(), 0);
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
  await page.locator('[data-comment-filter=first]').click();
  await page.locator('#search').fill('再読み込みで消す検索語');
  await page.reload(); await appReady(page);
  assert.equal(await page.locator('[data-comment-filter=all]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#search').inputValue(), '');
});

test('U3 applied name compares normalized standard content after editing, presets, reset and external updates', { skip: !browserAvailable }, async t => {
  const page = await fixture(t), base = new URL(page.url()).origin;
  await page.locator('[data-page=studio]').click();
  const name = page.locator('#current-design-name'), editor = page.locator('#design-preview-editor'), presets = page.locator('#design-presets');
  await name.waitFor();
  assert.equal(await name.textContent(), '標準のデザイン');
  await saveDesign(base, { ...defaultDesign(), name: '標準の別名', savedAt: 'ignored' });
  // The visible standard label stays the same; reload to observe the new metadata.
  await page.reload(); await appReady(page); await page.locator('[data-page=studio]').click();
  await name.filter({ hasText: /^標準のデザイン$/ }).waitFor();
  await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editorTarget(editor, 'header');
  await editor.locator('#draft-title').fill('編集後の見出し');
  assert.equal(await name.textContent(), '標準のデザイン', 'draft does not rename the applied design');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal(await name.textContent(), '標準の別名');
  await saveDesign(base, design => ({ ...design, name: '' }));
  await name.filter({ hasText: /^名前なしのデザイン$/ }).waitFor();
  await presets.locator('#preset-save').click(); await presets.locator('#preset-name').fill('保存した見た目');
  await presets.locator('#preset-name-submit').click(); await presets.locator('#preset-status').filter({ hasText: 'プリセットに保存しました' }).waitFor();
  await presets.locator('#preset-reset').click(); await presets.locator('#preset-confirm').click();
  await name.filter({ hasText: /^標準のデザイン$/ }).waitFor();
  await presets.locator('#preset-load').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await name.textContent(), '標準のデザイン', 'preset preview is not applied');
  await editor.locator('#apply-design').click(); await presets.locator('#preset-confirm').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  await name.filter({ hasText: /^保存した見た目$/ }).waitFor();
  for (const change of [
    { outputSize: '1080x1920' }, { theme: '.pokome-workspace { --pk-accent-color: red; }' },
    { ratios: { ...defaultDesign().ratios, '9:16': { overlays: { version: 1, items: [{ id: 'text1', type: 'text', text: '縦だけの文字' }], assets: {} } } } },
  ]) {
    await saveDesign(base, { ...defaultDesign(), ...change });
    await name.filter({ hasText: /^名前なしのデザイン$/ }).waitFor();
    await saveDesign(base, defaultDesign()); await name.filter({ hasText: /^標準のデザイン$/ }).waitFor();
  }
});

test('U3 user search and counted filters show both states, distinguish empty results and keep rule saving', { skip: !browserAvailable }, async t => {
  const page = await fixture(t), base = new URL(page.url()).origin;
  await page.locator('#twitch-channel').fill('qa_users'); await page.locator('#twitch-connection-toggle').click();
  await openSettings(page, 'users');
  assert.equal(await page.locator('#users-search').count(), 1);
  assert.match(await page.locator('#user-list').textContent(), /コメントを受信すると/);
  await saveSetting(base, 'users', { twitch: { Alpha: { hidden: true }, beta: { muted: true }, Both: { hidden: true, muted: true }, '<img src=x>': {} }, kick: { KickOnly: { hidden: true } } });
  await page.locator('#user-list .user-row').nth(3).waitFor();
  assert.deepEqual(await page.locator('#user-filters button').allTextContents(), ['すべて（4）', '非表示（2）', '読み上げ除外（2）']);
  const both = page.locator('.user-row').filter({ has: page.getByText('Both', { exact: true }) });
  assert.deepEqual(await both.locator('.user-state').allTextContents(), ['非表示', '読み上げ除外']);
  assert.equal(await page.locator('#user-list img').count(), 0);
  const plain = page.locator('.user-row').filter({ has: page.getByText('<img src=x>', { exact: true }) });
  assert.equal(await plain.locator('.user-state').count(), 0);
  await page.locator('#users-search').fill('aLP');
  assert.deepEqual(await page.locator('.user-row strong').allTextContents(), ['Alpha']);
  await page.locator('[data-user-filter=hidden]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-user-filter=hidden]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('.user-row strong').allTextContents(), ['Alpha']);
  await page.locator('[data-user-filter=muted]').click();
  assert.equal(await page.locator('.user-row').count(), 0);
  assert.equal(await page.locator('#user-list .empty').textContent(), '条件に合うユーザーはいません。');
  assert.equal(await page.locator('[data-user-filter=all]').textContent(), 'すべて（4）');
  await page.locator('#users-search').fill('');
  await both.getByRole('button', { name: '読み上げ除外を解除', exact: true }).click();
  await waitForSettings(base, value => value.users.twitch.Both.muted === false);
  assert.deepEqual(await page.locator('.user-row strong').allTextContents(), ['beta']);
  assert.equal(await page.locator('[data-user-filter=muted]').textContent(), '読み上げ除外（1）');
  await page.locator('#settings-platform').selectOption('kick');
  assert.deepEqual(await page.locator('#user-filters button').allTextContents(), ['すべて（4）', '非表示（1）', '読み上げ除外（0）']);
  assert.equal(await page.locator('[data-user-filter=muted]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-user-filter=all]').click();
  assert.deepEqual(await page.locator('.user-row strong').allTextContents(), ['kick_viewer', 'green_leaf', 'minto_0123', 'KickOnly']);
  await page.locator('[data-user-filter=hidden]').click(); await page.locator('#users-search').fill('KickOnly');
  await page.reload(); await appReady(page); await openSettings(page, 'users');
  assert.equal(await page.locator('#users-search').inputValue(), '');
  assert.equal(await page.locator('[data-user-filter=all]').getAttribute('aria-pressed'), 'true');
});

test('U3 home volume label occupies one line at desktop and intermediate widths', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  for (const width of [800, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const lines = await page.locator('#home-speech .range-label').evaluate(label => {
      const range = document.createRange(); range.selectNodeContents(label.firstChild);
      return range.getClientRects().length;
    });
    assert.equal(lines, 1, `${width}px volume label`);
  }
});

test('U3 narrow setup and menu keep usable text widths and operation targets', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  for (const width of [150, 300]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('[data-page=home]').click();
    await page.locator('#open-setup').click();
    const textWidth = await page.locator('#setup-dialog li').first().evaluate(node => node.getBoundingClientRect().width);
    assert.ok(textWidth >= 60, `${width}px setup text width ${textWidth}`);
    for (const id of ['setup-connect', 'setup-voice', 'setup-test-voice', 'close-setup']) {
      assert.ok((await page.locator('#' + id).boundingBox()).height >= 44, `${width}px #${id}`);
    }
    await page.locator('#close-setup').click();
    for (const id of ['start-setup', 'stop-speech', 'clear', 'read-selected']) {
      assert.ok((await page.locator('#' + id).boundingBox()).height >= 44, `${width}px #${id}`);
    }
    await page.locator('#comment-list .username').first().click();
    const menuWidth = await page.locator('#user-actions').evaluate(node => node.clientWidth - parseFloat(getComputedStyle(node).paddingLeft) - parseFloat(getComputedStyle(node).paddingRight));
    assert.ok(menuWidth >= 100, `${width}px menu text width ${menuWidth}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-page=studio]').click();
    assert.ok((await page.locator('#open-design-preview').boundingBox()).height >= 44, `${width}px design entry target`);
  }
});

test('U3 release guidance stays in the v0.11.0 update and preserves the setup instructions', { skip: !browserAvailable }, async t => {
  const page = await fixture(t);
  await page.locator('[data-page=updates]').click();
  const update = page.locator('#updates-page .update-entry').filter({ has: page.getByRole('heading', { name: '2026年10月23日 — 操作画面のデザインを見直しました', exact: true }) });
  assert.match(await update.textContent(), /ユーザー管理に検索/);
  assert.match(await update.textContent(), /コメントの絞り込みを切り替えボタン/);
  assert.match(await update.textContent(), /標準のデザイン/);
  assert.equal(await page.locator('#setup-dialog > p').textContent(), '3つの手順で、コメントの表示と読み上げを確認できます。');
});
