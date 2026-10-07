import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readDesign, editorThemeCSS, editorTarget, closeEditor, temporaryDataDirectory } from './browser-support.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-folder-editor-'));
  await mkdir(join(directory, 'styles'));
  await writeFile(join(directory, 'styles/test.css'), '.pokome-workspace .pokome-panel { border-radius: 7px; }');
  await mkdir(join(directory, 'images')); await writeFile(join(directory, 'images/test.png'), PNG);
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
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
for (const id of ['css', 'actor', 'speech', 'overlay']) {
  test(`${id} folder candidates preserve pending PC files until a new load starts`, { skip: !browserAvailable }, async t => {
    const { base, page, before, editor } = await fixture(t);
    let uploads = 0, folderReads = 0;
    page.on('request', request => {
      if (request.url().endsWith('/api/design/images') && request.method() === 'PUT') uploads++;
      if (/\/api\/customizations\/(styles|images)\//.test(request.url())) folderReads++;
    });
    await page.evaluate(() => {
      const text = Blob.prototype.text, decode = HTMLImageElement.prototype.decode;
      window.pcReadStarted = 0; window.pcReadFinished = 0;
      Blob.prototype.text = async function () {
        const held = this instanceof File && this.name === 'pc.css' && window.holdPCRead;
        if (held) { window.holdPCRead = false; window.pcReadStarted++; await new Promise(resolve => { window.releasePCRead = resolve; }); }
        const result = await text.call(this);
        if (held) window.pcReadFinished++;
        return result;
      };
      HTMLImageElement.prototype.decode = async function () {
        const held = this.src.startsWith('blob:') && window.holdPCRead;
        if (held) { window.holdPCRead = false; window.pcReadStarted++; await new Promise(resolve => { window.releasePCRead = resolve; }); }
        await decode.call(this);
        if (held) window.pcReadFinished++;
      };
    });
    const target = id === 'css' || id === 'overlay' ? 'screen' : id;
    const input = { css: '#draft-css-file', actor: '#draft-image', speech: '#draft-speechImage', overlay: '#overlay-image' }[id];
    const file = id === 'css' ? { name: 'pc.css', mimeType: 'text/css', buffer: Buffer.from('.pokome-workspace .pokome-panel { border-radius: 29px; }') }
      : { name: 'pc.png', mimeType: 'image/png', buffer: PNG };
    const name = id === 'css' ? 'test.css' : 'test.png';
    const completion = id === 'css' ? '下書きに読み込みました' : id === 'overlay' ? '画像を追加しました' : '画像を下書きに入れました';
    async function prepare() {
      if (id === 'css') await editorThemeCSS(editor); else await editorTarget(editor, target);
      if (!await editor.locator(`#local-${id}-select`).isVisible()) await editor.locator(`#local-${id} summary`).click();
      await editor.locator(`#local-${id}-select option[value="${name}"]`).waitFor({ state: 'attached' });
    }
    async function startPC(number) {
      await page.evaluate(() => { window.holdPCRead = true; });
      await editor.locator(input).setInputFiles(file);
      await page.waitForFunction(count => window.pcReadStarted === count, number);
      await editor.locator('#design-status').filter({ hasText: id === 'css' ? 'CSSを読み込んでいます' : '画像を確認しています' }).waitFor();
      assert.equal(await editor.locator('#apply-design').isDisabled(), true);
    }
    await prepare(); await startPC(1);
    await editor.locator(`#local-${id}-select`).selectOption(name);
    assert.equal(await editor.locator('#apply-design').isDisabled(), true, 'choosing a candidate must retain the pending PC read');
    assert.equal(folderReads, 0);
    assert.deepEqual(await readDesign(base), before);
    await page.evaluate(() => window.releasePCRead());
    await editor.locator('#design-status').filter({ hasText: completion }).waitFor();
    await editor.locator('#apply-design:not(:disabled)').waitFor();
    if (id === 'css') assert.match(await editor.locator('#draft-css').inputValue(), /29px/);
    else assert.equal(uploads, 1);
    await editor.locator('#apply-design').click();
    await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
    const saved = await readDesign(base);
    if (id === 'css') assert.match(saved.theme, /29px/);
    else if (id === 'overlay') assert.equal(saved.ratios['16:9'].overlays.items.length, 1);
    else assert.match(saved.studio[id === 'actor' ? 'image' : 'speechImage'], /^images\/[0-9a-f]{64}\.png$/);

    await editor.locator('#open-design-preview').click();
    await editor.locator('#apply-design:not(:disabled)').waitFor();
    await prepare(); await startPC(2);
    await editor.locator(`#local-${id}-select`).selectOption('');
    await editor.locator(`#local-${id}-select`).selectOption(name);
    assert.equal(await editor.locator('#apply-design').isDisabled(), true);
    await editor.locator(`#local-${id}-load`).click();
    await editor.locator('#design-status').filter({ hasText: completion }).waitFor();
    await editor.locator('#apply-design:not(:disabled)').waitFor();
    assert.equal(folderReads, 1);
    const completedUploads = uploads;
    await page.evaluate(() => window.releasePCRead());
    await page.waitForFunction(() => window.pcReadFinished === 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(uploads, completedUploads, 'a superseded PC read must not register its late image');
    if (id === 'css') assert.match(await editor.locator('#draft-css').inputValue(), /7px/);
    if (id === 'overlay') assert.equal(await editor.locator('#target-select option').count(), 8);
    assert.deepEqual(await readDesign(base), saved);
    await closeEditor(editor);
  });
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

test('pending folder CSS survives a candidate change and a new load or closing invalidates its late response', { skip: !browserAvailable }, async t => {
  const { base, page, before, editor } = await fixture(t);
  await editorThemeCSS(editor); await editor.locator('#local-css summary').click();
  await editor.locator('#local-css-select option[value="test.css"]').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const native = Blob.prototype.text;
    window.oldCSSReadFinished = 0;
    Blob.prototype.text = async function () {
      const text = await native.call(this);
      if (text === '.pokome-workspace { color: red; }') window.oldCSSReadFinished++;
      return text;
    };
  });
  for (const action of ['load', 'close']) {
    const completed = await page.evaluate(() => window.oldCSSReadFinished);
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    await page.route('**/api/customizations/styles/test.css', async route => { started(); await gate; await route.fulfill({ contentType: 'text/css', body: '.pokome-workspace { color: red; }' }); }, { times: 1 });
    await editor.locator('#local-css-select').selectOption('test.css'); await editor.locator('#local-css-load').click(); await began;
    assert.equal(await editor.locator('#apply-design').isDisabled(), true);
    if (action === 'load') {
      await editor.locator('#local-css-select').selectOption('');
      assert.equal(await editor.locator('#apply-design').isDisabled(), true);
      await editor.locator('#local-css-select').selectOption('test.css');
      await editor.locator('#local-css-load').click();
      await editor.locator('#design-status').filter({ hasText: '下書きに読み込みました' }).waitFor();
    }
    else await closeEditor(editor);
    const response = page.waitForResponse('**/api/customizations/styles/test.css'); release(); await (await response).finished();
    await page.waitForFunction(count => window.oldCSSReadFinished > count, completed);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    if (action === 'load') {
      await editor.locator('#apply-design:not(:disabled)').waitFor();
      assert.match(await editor.locator('#draft-css').inputValue(), /7px/);
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


test('late folder images cannot change a discarded, closed, superseded or cleared draft', { skip: !browserAvailable }, async t => {
  const { base, page, before, editor } = await fixture(t);
  let uploads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/design/images') && request.method() === 'PUT') uploads++; });
  await page.evaluate(() => {
    const native = HTMLImageElement.prototype.decode;
    window.folderDecoded = 0;
    HTMLImageElement.prototype.decode = async function () {
      await native.call(this);
      if (this.src.startsWith('blob:')) window.folderDecoded++;
    };
  });
  const cases = ['actor', 'speech', 'overlay'].flatMap(id => ['load', 'discard', 'close'].map(action => [id, action]));
  cases.push(['actor', 'remove'], ['speech', 'standard']);
  for (const [id, action] of cases) {
    if (!await editor.locator('#design-dialog').isVisible()) {
      await editor.locator('#open-design-preview').click();
      await editor.locator('#apply-design:not(:disabled)').waitFor();
    }
    await editorTarget(editor, id === 'overlay' ? 'screen' : id);
    if (!await editor.locator('#local-' + id + '-select').isVisible()) await editor.locator('#local-' + id + ' summary').click();
    await editor.locator('#local-' + id + '-select option[value="test.png"]').waitFor({ state: 'attached' });
    if (action === 'remove' || action === 'standard') {
      await editor.locator('#local-' + id + '-select').selectOption('test.png');
      await editor.locator('#local-' + id + '-load').click();
      await editor.locator('#design-status').filter({ hasText: '画像を下書きに入れました' }).waitFor();
      await editor.locator('#apply-design:not(:disabled)').waitFor();
    }
    const uploadsBefore = uploads;
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    const decoded = await page.evaluate(() => window.folderDecoded);
    await page.route('**/api/customizations/images/test.png', async route => {
      started(); await gate; await route.fulfill({ contentType: 'image/png', body: PNG });
    }, { times: 1 });
    await editor.locator('#local-' + id + '-select').selectOption('test.png');
    await editor.locator('#local-' + id + '-load').click(); await began;
    assert.equal(await editor.locator('#apply-design').isDisabled(), true, id + ':' + action);
    if (action === 'load') {
      await editor.locator('#local-' + id + '-select').selectOption('');
      assert.equal(await editor.locator('#apply-design').isDisabled(), true, 'a candidate is not a new read');
      await editor.locator('#local-' + id + '-select').selectOption('test.png');
      await editor.locator('#local-' + id + '-load').click();
      await editor.locator('#design-status').filter({ hasText: id === 'overlay' ? '画像を追加しました' : '画像を下書きに入れました' }).waitFor();
    }
    else if (action === 'close') await closeEditor(editor);
    else if (action === 'discard') {
      await editorTarget(editor, 'screen'); await editor.locator('#draft-reset').click();
      await editor.locator('#editor-confirm-accept').click();
    } else await editor.locator(action === 'remove' ? '#draft-image-remove' : '#draft-speechImage-reset').click();
    const decodedBeforeRelease = action === 'load' ? await page.evaluate(() => window.folderDecoded) : decoded;
    const response = page.waitForResponse('**/api/customizations/images/test.png');
    release(); await (await response).finished();
    await page.waitForFunction(count => window.folderDecoded > count, decodedBeforeRelease);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(uploads, uploadsBefore + (action === 'load' ? 1 : 0), id + ':' + action + ' must invalidate the old image before upload');
    if (action === 'close') {
      await editor.locator('#open-design-preview').click();
      await editor.locator('#apply-design:not(:disabled)').waitFor();
    } else await editor.locator('#apply-design:not(:disabled)').waitFor();
    assert.equal(await editor.locator('#target-select option').count(), id === 'overlay' && action === 'load' ? 7 : 6, 'no late overlay is inserted');
    assert.deepEqual(await readDesign(base), before);
    await closeEditor(editor);
  }
});
