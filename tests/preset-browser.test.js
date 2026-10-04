import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { defaultDesign } from '../src/shared/design-model.js';
import { fixtureDesign, fixtureFiles, actorRef } from './fixtures/preset-design.js';
import { chromium, executablePath, browserAvailable, saveDesign, readDesign, uploadDesignImage, waitForDesign, appReady, blockExternalFonts } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const panel = '#design-presets', preview = '#design-preview-editor';
async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath });
  let server, directory;
  t.after(async () => { await browser.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); if (directory) await rm(directory, { recursive: true, force: true }); });
  directory = await mkdtemp(join(tmpdir(), 'pokome-presets-browser-'));
  server = createServer({ customizationDirectory: directory }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const bytes of Object.values(fixtureFiles)) await uploadDesignImage(url, bytes);
  await saveDesign(url, fixtureDesign());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  page.setDefaultTimeout(8000); await blockExternalFonts(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await appReady(page); await page.locator('.nav[data-page="studio"]').click();
  await page.waitForFunction(() => !document.querySelector('#design-presets')?.shadowRoot?.getElementById('preset-refresh').disabled);
  return { browser, context, page, url, directory, errors, ui: page.locator(panel), editor: page.locator(preview) };
}
async function create(ui, name) {
  await ui.locator('#preset-save').click(); await ui.locator('#preset-name').fill(name); await ui.locator('#preset-name-submit').click();
  await ui.locator('#preset-name-dialog').waitFor({ state: 'hidden' });
  await ui.locator('#preset-status').filter({ hasText: 'プリセットに保存しました' }).waitFor();
  return ui.locator('#preset-select').inputValue();
}
async function confirmation(ui, accepted = true) { await ui.locator(accepted ? '#preset-confirm' : '#preset-confirm-cancel').click(); await ui.locator('#preset-confirm-dialog').waitFor({ state: 'hidden' }); }
async function openRead(ui, editor) { await ui.locator('#preset-load').click(); await editor.locator('#design-dialog').waitFor({ state: 'visible' }); await editor.locator('#apply-design:not(:disabled)').waitFor(); }
const current = async url => (await (await fetch(`${url}/api/design/current`)).json());

browserTest('presets save complete scenes, readonly ratios never leak, cancel preserves current and apply reaches isolated output by SSE', async t => {
  const { browser, page, url, ui, editor, errors } = await fixture(t);
  const id = await create(ui, '全比率の画面例');
  const outputContext = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
  const output = await outputContext.newPage(); await blockExternalFonts(output); await output.goto(`${url}/output.html`);
  await output.locator('#stage-title').filter({ hasText: '画面例の確認' }).waitFor();
  await ui.locator('#preset-reset').click(); await confirmation(ui); await waitForDesign(url, design => design.studio.image === '');
  assert.deepEqual(await readDesign(url), defaultDesign());
  await output.locator('#stage-title').filter({ hasText: defaultDesign().studio.title }).waitFor();
  const before = await current(url), beforeStorage = await page.evaluate(() => JSON.stringify(localStorage));
  await openRead(ui, editor);
  assert.equal(await editor.locator('.controls').isVisible(), false);
  const frame = page.frameLocator(`${preview} #design-preview-frame`);
  for (const [value, ratio] of [['1280x720', '16:9'], ['1080x1920', '9:16'], ['1440x1080', '4:3']]) {
    await editor.locator('#preview-width').selectOption(value);
    await frame.locator('.pokome-overlay').filter({ hasText: `小さな画面例 ${ratio}` }).waitFor();
    assert.equal(await frame.locator('.overlay-hit').count(), 0);
    assert.equal(await frame.locator('#actor-image').getAttribute('src'), `/api/design/presets/${id}/images/${actorRef.slice(7)}`);
    assert.match(await frame.locator('#preview-theme').textContent(), /border-radius/);
    assert.deepEqual(await current(url), before, 'checking a different ratio never writes current');
  }
  await editor.locator('#cancel-design').click(); assert.deepEqual(await current(url), before);
  await openRead(ui, editor); await editor.locator('#apply-design').click();
  assert.match(await ui.locator('#preset-confirm-message').textContent(), /今のデザイン全体/);
  assert.deepEqual(await current(url), before, 'confirmation precedes the current write');
  await confirmation(ui, false); assert.equal(await editor.locator('#design-dialog').isVisible(), true);
  await editor.locator('#apply-design').click(); await confirmation(ui); await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await readDesign(url), { ...fixtureDesign(), name: '全比率の画面例' });
  await output.locator('#stage-title').filter({ hasText: '画面例の確認' }).waitFor();
  await output.waitForFunction(() => document.getElementById('actor-image').src.includes('/api/design/current/images/'));
  assert.match(await output.locator('#pokome-user-theme').textContent(), /border-radius/);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), beforeStorage);
  assert.deepEqual(errors, []);
});

browserTest('names keep whole emoji, permit duplicates and render markup as text; rename, overwrite and deletion confirm', async t => {
  const { page, url, ui, errors } = await fixture(t), emoji = '👩‍👩‍👧‍👦';
  await ui.locator('#preset-save').click(); assert.equal(await ui.locator('#preset-name').getAttribute('maxlength'), null);
  await ui.locator('#preset-name').fill(emoji.repeat(41)); await ui.locator('#preset-name-submit').click();
  assert.match(await ui.locator('#preset-name-error').textContent(), /1〜40/); assert.equal(await ui.locator('#preset-name-dialog').isVisible(), true);
  await ui.locator('#preset-name').fill(emoji.repeat(40)); await ui.locator('#preset-name-submit').click();
  await ui.locator('#preset-status').filter({ hasText: 'プリセットに保存しました' }).waitFor();
  const first = await ui.locator('#preset-select').inputValue(); assert.ok(first);
  const second = await create(ui, emoji.repeat(40)); assert.notEqual(second, first);
  assert.equal(await ui.locator('#preset-select option:not([value=""])').count(), 2);
  await ui.locator('#preset-rename').click(); await ui.locator('#preset-name').fill('<b>名前</b>'); await ui.locator('#preset-name-submit').click();
  await ui.locator('#preset-status').filter({ hasText: '名前を変更しました' }).waitFor();
  assert.match(await ui.locator('#preset-select option:checked').textContent(), /<b>名前<\/b>/); assert.equal(await ui.locator('b').count(), 0);
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, title: '上書き後の画面' } }));
  await page.locator('#stage-title').filter({ hasText: '上書き後の画面' }).waitFor({ state: 'attached' });
  await ui.locator('#preset-overwrite').click(); await confirmation(ui, false);
  const old = await (await fetch(`${url}/api/design/presets/${second}`)).json(); assert.equal(old.design.studio.title, '画面例の確認');
  await ui.locator('#preset-overwrite').click(); await confirmation(ui);
  await ui.locator('#preset-status').filter({ hasText: '上書き保存しました' }).waitFor();
  assert.equal((await (await fetch(`${url}/api/design/presets/${second}`)).json()).design.studio.title, '上書き後の画面');
  await ui.locator('#preset-delete').click(); await confirmation(ui, false); assert.equal((await fetch(`${url}/api/design/presets/${second}`)).status, 200);
  await ui.locator('#preset-delete').click(); await confirmation(ui); await ui.locator('#preset-status').filter({ hasText: '削除しました' }).waitFor();
  assert.equal((await fetch(`${url}/api/design/presets/${second}`)).status, 404); assert.equal((await fetch(`${url}/api/design/presets/${first}`)).status, 200);
  assert.deepEqual(errors, []);
});

browserTest('manual folder refresh disables invalid entries with reasons and stale readonly drafts cannot replace another change', async t => {
  const { page, url, directory, ui, editor, errors } = await fixture(t);
  const id = await create(ui, '競合の確認');
  const broken = join(directory, 'presets', 'broken'); await mkdir(join(broken, 'images'), { recursive: true }); await writeFile(join(broken, 'design.json'), '{broken');
  await ui.locator('#preset-refresh').click(); await ui.locator('#preset-status').filter({ hasText: '一覧を更新しました' }).waitFor();
  assert.equal(await ui.locator('#preset-select option[value="broken"]').evaluate(element => element.disabled), true); assert.match(await ui.locator('#preset-errors').textContent(), /broken.*design.json/);
  await ui.locator('#preset-select').selectOption(id); await openRead(ui, editor);
  await saveDesign(url, design => ({ ...design, studio: { ...design.studio, title: '別の画面の内容' } }));
  await editor.locator('#design-status').filter({ hasText: '別の画面' }).waitFor();
  await editor.locator('#apply-design').click(); await editor.locator('#design-status').filter({ hasText: '適用できませんでした' }).waitFor();
  assert.equal(await ui.locator('#preset-confirm-dialog').isVisible(), false); assert.equal((await readDesign(url)).studio.title, '別の画面の内容');
  await editor.locator('#cancel-design').click(); assert.deepEqual(errors, []);
});

browserTest('preset controls and confirmation fit PC and mobile widths in light and dark modes', async t => {
  const { page, ui, editor, errors } = await fixture(t);
  await create(ui, '幅と配色の確認');
  for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const bounds = await ui.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await ui.locator('#preset-reset').click();
    const dialog = await ui.locator('#preset-confirm-dialog').boundingBox(); assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width + 1);
    await confirmation(ui, false);
    await openRead(ui, editor);
    const previewBounds = await editor.locator('#design-dialog').boundingBox(); assert.ok(previewBounds.x >= 0 && previewBounds.x + previewBounds.width <= width + 1);
    assert.equal(await editor.locator('#design-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await editor.locator('#cancel-design').click();
  }
  assert.deepEqual(errors, []);
});
