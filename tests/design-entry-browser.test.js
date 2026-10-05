import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, editorTarget, closeEditor } from './browser-support.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-entry-'));
  const server = createServer({ customizationDirectory: directory });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage(); page.setDefaultTimeout(3000); await blockExternalFonts(page);
  await page.goto(base); await appReady(page);
  return { base, page, editor: page.locator('#design-preview-editor') };
}

test('talk editing opens the unified draft and returns focus after Apply or discard', { skip: !browserAvailable }, async t => {
  const { base, page, editor } = await fixture(t);
  await page.locator('#enter-talk').click();
  assert.equal(await page.locator('#stage-font-plus,#stage-comment-settings,.stage-edit-pencil,.stage-text-dialog').count(), 0);
  await page.locator('#stage-design-edit').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('talk-mode')), true);
  await editorTarget(editor, 'header'); await editor.locator('#draft-title').fill('エディタからの題名');
  const before = await readDesign(base);
  await editor.locator('#discard-design').click(); await editor.locator('#editor-confirm-accept').click();
  assert.deepEqual(await readDesign(base), before);
  await closeEditor(editor);
  assert.equal(await page.locator('#stage-design-edit').evaluate(button => button === document.activeElement), true);
  await page.locator('#stage-design-edit').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  await editorTarget(editor, 'header'); await editor.locator('#draft-title').fill('エディタからの題名');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#stage-title').textContent(), 'エディタからの題名');
  assert.equal(await page.locator('#talk-stage').isVisible(), true);
  assert.equal(await page.locator('#stage-design-edit').evaluate(button => button === document.activeElement), true);
  await page.locator('#talk-stage').focus(); await page.mouse.move(1, 1);
  assert.equal(await page.locator('#stage-design-edit').evaluate(button => getComputedStyle(button.closest('.stage-controls')).opacity), '0');
});

test('output size is applied text and its editor changes the size only on Apply', { skip: !browserAvailable }, async t => {
  const { base, page, editor } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  assert.equal(await page.locator('#output-size').count(), 0);
  assert.match(await page.locator('#output-size-value').textContent(), /1280.*720/);
  await page.locator('#edit-output-size').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(await editor.locator('#target-select').inputValue(), 'screen');
  await editor.locator('#draft-outputSize').selectOption('1080x1920');
  assert.equal((await readDesign(base)).outputSize, '1280x720');
  await editor.locator('#apply-design').click(); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#output-size-value').textContent(), /1080.*1920/);
  assert.equal((await readDesign(base)).outputSize, '1080x1920');
});

test('design page orders final entries, shows the applied design and keeps preset confirmation read-only', { skip: !browserAvailable }, async t => {
  const { page, editor } = await fixture(t);
  await page.locator('[data-page="studio"]').click();
  assert.deepEqual(await page.locator('#studio-page').evaluate(section => [...section.children].map(child => child.id)), ['design-presets', 'design-preview-editor', 'stream-output-panel', 'appearance-recovery-guide']);
  assert.match(await editor.locator('#applied-design-summary').textContent(), /ミント.*1280.*720/);
  assert.doesNotMatch(await editor.locator('.entry').textContent(), /ホームの配置|すぐに保存/);
  const presets = page.locator('#design-presets');
  await presets.locator('#preset-save').click(); await presets.locator('#preset-name').fill('確認用'); await presets.locator('#preset-name-submit').click();
  await presets.locator('#preset-status').filter({ hasText: '保存しました' }).waitFor();
  await presets.locator('#preset-load').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
  for (const selector of ['#canvas-snap', '#copy-ratio', '#draft-reset', '#local-css', '#local-actor', '#local-speech', '#local-overlay', '.side']) assert.equal(await editor.locator(selector).first().isVisible(), false, selector);
  assert.equal(await editor.locator('.view select:visible').count(), 2);
  assert.equal(await editor.locator('.view input:visible').count(), 1);
  assert.equal(await editor.locator('#cancel-design').textContent(), 'キャンセル');
  await editor.locator('#cancel-design').click();
  await page.locator('#recovery-guide-open').click();
  assert.match(await page.locator('#appearance-recovery dialog').textContent(), /出力の大きさ/);
  assert.match(await page.locator('#appearance-recovery dialog').textContent(), /下書き.*適用できなく/);
  await page.locator('#appearance-recovery #cancel-reset').click();
});

test('150px standard home keeps content within the effective dock width', { skip: !browserAvailable }, async t => {
  const { page } = await fixture(t); await page.setViewportSize({ width: 150, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const selector of ['.workspace','.comments','.stats','#filter','#enter-talk']) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 150, selector);
  }
});

test('150px talk controls remain reachable outside the short ratio frame', { skip: !browserAvailable }, async t => {
  const { page } = await fixture(t); await page.setViewportSize({ width: 150, height: 700 });
  await page.locator('#enter-talk').click(); await page.locator('#stage-design-edit').focus();
  for (const id of ['leave-talk','stage-auto-speech','stage-design-edit']) {
    const button = page.locator('#'+id), box = await button.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 150 && box.y + box.height <= 700, id);
    await button.click({ trial: true });
  }
  await page.locator('#stage-design-edit').click(); await page.locator('#design-preview-editor #cancel-design').click();
  await page.locator('#leave-talk').click(); assert.equal(await page.locator('#home-page').isVisible(), true);
});
