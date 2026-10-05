import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, editorThemeCSS, editorTarget, closeEditor } from './browser-support.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-folder-editor-'));
  await mkdir(join(directory, 'styles'));
  await writeFile(join(directory, 'styles/test.css'), '.pokome-workspace .pokome-panel { border-radius: 7px; }');
  await mkdir(join(directory, 'images')); await writeFile(join(directory, 'images/test.png'), PNG);
  const server = createServer({ customizationDirectory: directory });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage(); page.setDefaultTimeout(8000); await blockExternalFonts(page);
  await page.goto(base); await appReady(page);
  const before = await readDesign(base), editor = page.locator('#design-preview-editor');
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  return { directory, base, page, before, editor };
}
test('folder CSS enters the draft and undo history without saving before Apply', { skip: !browserAvailable }, async t => {
  const { base, page, before, editor } = await fixture(t);
  await editorThemeCSS(editor);
  await editor.locator('#local-css details').locator('summary').click();
  await editor.locator('#local-css-select option[value="test.css"]').waitFor({ state: 'attached', timeout: 1500 });
  await editor.locator('#local-css-select').selectOption('test.css');
  await editor.locator('#local-css-load').click();
  await editor.locator('#design-status').filter({ hasText: '下書きに読み込みました' }).waitFor();
  assert.match(await editor.locator('#draft-css').inputValue(), /7px/);
  assert.deepEqual(await readDesign(base), before);
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#draft-css').inputValue(), '');
  await editor.locator('#redo-design').click();
  await editor.locator('#apply-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.match((await readDesign(base)).theme, /7px/);
  assert.equal(await page.locator('#local-customization').count(), 0);
});

test('all three folder image destinations are draft operations and persist only on Apply', { skip: !browserAvailable }, async t => {
  const { base, before, editor } = await fixture(t);
  for (const [id, target] of [['actor', 'actor'], ['speech', 'speech'], ['overlay', 'screen']]) {
    await editorTarget(editor, target);
    await editor.locator(`#local-${id} summary`).click();
    await editor.locator(`#local-${id}-select option[value="test.png"]`).waitFor({ state: 'attached' });
    await editor.locator(`#local-${id}-select`).selectOption('test.png');
    await editor.locator(`#local-${id}-load`).click();
    await editor.locator('#design-status').filter({ hasText: id === 'overlay' ? '画像を追加しました' : '画像を下書きに入れました' }).waitFor();
    assert.equal(await editor.locator('#apply-design').isDisabled(), false);
    assert.deepEqual(await readDesign(base), before);
  }
  await editor.locator('#undo-design').click();
  assert.equal(await editor.locator('#target-select option').count(), 6);
  await editor.locator('#redo-design').click();
  await editor.locator('#apply-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
  const saved = await readDesign(base);
  assert.match(saved.studio.image, /^images\/[0-9a-f]{64}\.png$/);
  assert.equal(saved.studio.speechImage, saved.studio.image);
  assert.equal(saved.ratios['16:9'].overlays.items.length, 1);
});

test('pending folder CSS blocks Apply and a new choice or closing invalidates its late response', { skip: !browserAvailable }, async t => {
  const { base, page, before, editor } = await fixture(t);
  await editorThemeCSS(editor); await editor.locator('#local-css summary').click();
  await editor.locator('#local-css-select option[value="test.css"]').waitFor({ state: 'attached' });
  for (const action of ['choice', 'close']) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    await page.route('**/api/customizations/styles/test.css', async route => { started(); await gate; await route.fulfill({ contentType: 'text/css', body: '.pokome-workspace { color: red; }' }); }, { times: 1 });
    await editor.locator('#local-css-select').selectOption('test.css'); await editor.locator('#local-css-load').click(); await began;
    assert.equal(await editor.locator('#apply-design').isDisabled(), true);
    if (action === 'choice') await editor.locator('#local-css-select').selectOption('');
    else await closeEditor(editor);
    const response = page.waitForResponse('**/api/customizations/styles/test.css'); release(); await (await response).finished();
    if (action === 'choice') {
      await editor.locator('#apply-design:not(:disabled)').waitFor();
      assert.equal(await editor.locator('#draft-css').inputValue(), '');
    }
    assert.deepEqual(await readDesign(base), before);
  }
});

test('folder errors retain the draft, invalid CSS blocks Apply, and unavailable lists can be refreshed', { skip: !browserAvailable }, async t => {
  const { base, page, before, editor } = await fixture(t);
  await editorThemeCSS(editor); await editor.locator('#local-css summary').click();
  await editor.locator('#local-css-select option[value="test.css"]').waitFor({ state: 'attached' });
  await page.route('**/api/customizations/styles/test.css', route => route.fulfill({ contentType: 'text/css', body: 'body { display:none; }' }), { times: 1 });
  await editor.locator('#local-css-select').selectOption('test.css'); await editor.locator('#local-css-load').click();
  await editor.locator('#design-status').filter({ hasText: '入力したCSSは未反映' }).waitFor();
  assert.equal(await editor.locator('#apply-design').isDisabled(), true);
  assert.deepEqual(await readDesign(base), before);
  await editor.locator('#draft-css-clear').click();
  await page.route('**/api/customizations/styles/test.css', route => route.fulfill({ status: 404, json: { error: 'ファイルが見つかりません' } }), { times: 1 });
  await editor.locator('#local-css-load').click();
  await editor.locator('#design-status').filter({ hasText: '見つかりません' }).waitFor();
  assert.equal(await editor.locator('#draft-css').inputValue(), '');
  await editorTarget(editor, 'actor'); await editor.locator('#local-actor summary').click();
  await page.route('**/api/customizations/images/test.png', route => route.fulfill({ contentType: 'image/png', body: PNG.subarray(0, 33) }), { times: 1 });
  await editor.locator('#local-actor-select').selectOption('test.png'); await editor.locator('#local-actor-load').click();
  await editor.locator('#design-status').filter({ hasText: '画像が壊れている' }).waitFor();
  assert.deepEqual(await readDesign(base), before);
  await page.route('**/api/customizations', route => route.fulfill({ status: 503, json: { error: '一時的なエラー' } }), { times: 1 });
  await editor.locator('#local-actor .local-refresh').click();
  await editor.locator('#local-actor .local-status').filter({ hasText: '再試行' }).waitFor();
  assert.equal(await editor.locator('#local-actor-select').isDisabled(), true);
  await editor.locator('#local-actor .local-refresh').click();
  await editor.locator('#local-actor-select option[value="test.png"]').waitFor({ state: 'attached' });
  assert.equal(await editor.locator('#local-actor-select').isDisabled(), false);
});
