import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, saveStudio, readDesign, waitForDesign, appReady, editorTarget, editorThemeCSS, closeEditor, applyInEditor, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);

async function fixture(t, { viewport = { width: 1440, height: 1000 }, args = [], maxVisible = 30 } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath, args });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-output-browser-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport });
  await context.route('https://fonts.googleapis.com/**', route => route.abort());
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  if (maxVisible !== null) await saveStudio(url, { maxVisible });
  await page.goto(url); await appReady(page);
  return { context, page, url, errors };
}
// A same-origin page without output.js: a producer running the output itself
// could ask for a resync, and the test's reply would reset the observed output.
const producerPage = url => `${url}/speech-background.svg`;
const comments = output => output.locator('.stage-comment').evaluateAll(cards => cards.map(card => card.textContent));
const backgrounds = output => output.evaluate(() => ['html', 'body', 'main', '#talk-stage'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
const controls = output => output.evaluate(() => document.querySelectorAll('button,input,select,textarea,dialog,[popover],output').length);

browserTest('preview clipping follows direction, scrolling, frame size and CSS changes without hiding tall cards', async t => {
  const { page, errors } = await fixture(t, { maxVisible: null });
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  await page.locator('#preview-width').selectOption('640x360');
  const list = page.frameLocator('#design-preview-frame').locator('#stage-chat-list');
  await list.locator('.stage-comment').nth(9).waitFor({ state: 'attached' });
  const assertClipping = async reason => {
    await page.waitForTimeout(100);
    const result = await list.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const cards = [...element.querySelectorAll('.stage-comment')];
      return { height: element.clientHeight, clipped: cards.filter(card => card.classList.contains('stage-comment-clipped')).length,
        mismatches: cards.flatMap((card, i) => {
          const rect = card.getBoundingClientRect();
          const expected = rect.height <= element.clientHeight && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
          return expected !== card.classList.contains('stage-comment-clipped') ? [{ i, expected, height: rect.height }] : [];
        }) };
    });
    assert.ok(result.height > 0, reason);
    assert.deepEqual(result.mismatches, [], reason);
    return result;
  };
  assert.ok((await assertClipping('640x360 bottom clips short cards outside the list')).clipped > 0);
  await page.locator('#draft-newestPosition').selectOption('top');
  await assertClipping('top reclassifies the newest edge');
  await list.evaluate(element => { element.scrollTop = 50; element.dispatchEvent(new Event('scroll')); });
  await assertClipping('scroll reclassifies partial cards');
  await page.locator('#preview-width').selectOption('1280x720');
  await assertClipping('frame resize reclassifies cards');
  await page.locator('#preview-width').selectOption('640x360');
  await editorThemeCSS(page);
  await page.locator('#draft-css').fill('.pokome-workspace #stage-chat-list { height: 180px; flex: none; } .pokome-workspace .stage-comment { min-height: 90px; }');
  await assertClipping('CSS shortening the list reclassifies cards');
  await editorTarget(page, 'chat'); await page.locator('#draft-newestPosition').selectOption('bottom');
  await assertClipping('bottom after CSS changes preserves clipping');
  await editorThemeCSS(page); await page.locator('#draft-css').fill('.pokome-workspace #stage-chat-list { height: 180px; flex: none; } .pokome-workspace .stage-comment { min-height: 400px; }');
  const tall = await assertClipping('cards taller than the list remain scrollable');
  assert.equal(tall.clipped, 0);
  assert.deepEqual(errors, []);
});

browserTest('display count controls offer every integer from unlimited through thirty and cannot be blank', async t => {
  const { page, errors } = await fixture(t, { maxVisible: null });
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  for (const selector of ['#draft-maxVisible']) {
    const field = page.locator(selector);
    assert.equal(await field.evaluate(element => element.tagName), 'SELECT');
    assert.deepEqual(await field.locator('option').evaluateAll(options => options.map(option => option.value)), Array.from({ length: 31 }, (_, i) => String(i)));
    assert.match(await field.locator('option[value="0"]').textContent(), /制限なし/);
    assert.equal(await field.locator('option[value=""]').count(), 0);
  }
  assert.deepEqual(errors, []);
});

browserTest('preview has ten persistent samples and count and direction changes are visible before apply', async t => {
  const { page, url, errors } = await fixture(t, { maxVisible: null });
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('.stage-comment').first().waitFor({ state: 'attached' });
  assert.equal(await frame.locator('.stage-comment').count(), 10);
  const all = await frame.locator('.stage-comment').allTextContents();
  await page.locator('#draft-maxVisible').selectOption('8');
  assert.deepEqual(await frame.locator('.stage-comment').allTextContents(), all.slice(-8));
  await page.locator('#draft-maxVisible').selectOption('3');
  assert.deepEqual(await frame.locator('.stage-comment').allTextContents(), all.slice(-3));
  await page.locator('#draft-newestPosition').selectOption('top');
  assert.deepEqual(await frame.locator('.stage-comment').allTextContents(), all.slice(-3).reverse());
  await page.locator('#draft-maxVisible').selectOption('0');
  assert.deepEqual(await frame.locator('.stage-comment').allTextContents(), [...all].reverse());
  await page.locator('#draft-holdSeconds').selectOption('5');
  await page.waitForTimeout(5100);
  assert.equal(await frame.locator('.stage-comment').count(), 10);
  await page.locator('#draft-newestPosition').selectOption('bottom');
  assert.deepEqual(await frame.locator('.stage-comment').allTextContents(), all);
  await closeEditor(page);
  assert.equal((await readDesign(url)).studio.maxVisible, 0);
  assert.deepEqual(errors, []);
});

browserTest('output caches design reads and normalization across appends but follows saved settings and retained comments', async t => {
  const { context, page, url, errors } = await fixture(t);
  await page.close();
  await saveStudio(url, { maxVisible: 8, holdSeconds: 0 });
  const producer = await context.newPage();
  await producer.goto(producerPage(url));
  await producer.evaluate(() => {
    window.testChannel = new BroadcastChannel('pokome-output-v2');
    window.testChannel.onmessage = event => {
      if (event.data.type === 'hello') window.testChannel.postMessage({ v: 2, type: 'snapshot', controllerId: 'cache-controller', seq: 0, received: 0, messages: [] });
    };
  });
  const output = await context.newPage();
  output.setDefaultTimeout(8000);
  const signature = 'export function normalizeStudio(value = {}, { image = dataImage } = {}) {';
  await output.route('**/studio.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    assert.ok(source.includes(signature));
    await route.fulfill({ response, body: source.replace(signature, `${signature} globalThis.studioNormalizations = (globalThis.studioNormalizations || 0) + 1;`) });
  });
  let reads = 0;
  output.on('request', request => { if (new URL(request.url()).pathname === '/api/design/current') reads++; });
  await output.goto(`${url}/output.html`);
  await output.waitForFunction(() => document.querySelector('#stage-count')?.textContent === '0 COMMENTS');
  await output.waitForTimeout(100);
  const metrics = async () => ({ reads, normalizations: await output.evaluate(() => window.studioNormalizations) });
  const baseline = await metrics();
  await producer.evaluate(() => {
    for (let i = 1; i <= 40; i++) window.testChannel.postMessage({ v: 2, type: 'append', controllerId: 'cache-controller', seq: i, received: i,
      message: { id: String(i), user: `user${i}`, text: `body${i}`, receivedAt: Date.now() } });
  });
  await output.waitForFunction(() => document.querySelector('#stage-count').textContent === '40 COMMENTS');
  assert.equal((await comments(output)).length, 8);
  assert.deepEqual(await metrics(), baseline, 'appends neither reread nor renormalize the design');
  // A save from any page is announced by the server and reaches the output.
  await saveStudio(url, { maxVisible: 0, holdSeconds: 0, newestPosition: 'top' });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 40);
  assert.equal(await output.locator('.stage-comment strong').first().textContent(), 'user40');
  const updated = await metrics();
  assert.ok(updated.reads > baseline.reads);
  assert.ok(updated.normalizations > baseline.normalizations);
  await producer.evaluate(() => window.testChannel.postMessage({ v: 2, type: 'append', controllerId: 'cache-controller', seq: 41, received: 41,
    message: { id: '41', user: 'user41', text: 'body41', receivedAt: Date.now() } }));
  await output.waitForFunction(() => document.querySelector('.stage-comment strong').textContent === 'user41');
  assert.equal((await comments(output)).length, 41);
  assert.deepEqual(await metrics(), updated);
  await producer.evaluate(() => { window.testChannel.onmessage = null; });
  await saveStudio(url, { maxVisible: 3, holdSeconds: 5, newestPosition: 'bottom' });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 3);
  assert.equal(await output.locator('.stage-comment strong').last().textContent(), 'user41');
  await producer.evaluate(() => window.testChannel.postMessage({ v: 2, type: 'append', controllerId: 'cache-controller', seq: 42, received: 42,
    message: { id: '42', user: 'expired', text: 'expired body', receivedAt: Date.now() - 6000 } }));
  await output.waitForFunction(() => document.querySelector('#stage-count').textContent === '42 COMMENTS');
  assert.equal(await output.locator('.stage-comment strong').last().textContent(), 'user41');
  assert.deepEqual(errors, []);
});

browserTest('output defaults to unlimited comments and switching eight and unlimited persists without changing history', async t => {
  const { context, page, url, errors } = await fixture(t, { maxVisible: null });
  const output = await context.newPage();
  await output.goto(`${url}/output.html`);
  await output.waitForFunction(() => document.querySelector('#stage-count')?.textContent === '12 COMMENTS');
  assert.equal((await comments(output)).length, 12);
  assert.equal(await page.locator('#comment-list .username').count(), 12);
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  assert.deepEqual([await page.locator('#draft-maxVisible').inputValue(), await page.locator('#draft-holdSeconds').inputValue(), await page.locator('#draft-newestPosition').inputValue()], ['0', '0', 'bottom']);
  await page.locator('#draft-maxVisible').selectOption('8');
  await page.locator('#apply-design').click();
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 8);
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  await page.locator('#draft-maxVisible').selectOption('0');
  await page.locator('#apply-design').click();
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 12);
  assert.equal((await waitForDesign(url, design => design.studio.maxVisible === 0)).studio.maxVisible, 0);
  const chat = steps => applyInEditor(page, async editor => { await editorTarget(editor, 'chat'); await steps(editor); });
  await chat(editor => editor.locator('#draft-maxVisible').selectOption('3'));
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 3);
  const initialBottom = await comments(output);
  await chat(editor => editor.locator('#draft-newestPosition').selectOption('top'));
  await output.waitForFunction(first => document.querySelector('.stage-comment').textContent === first, initialBottom.at(-1));
  const bottom = await comments(output);
  await chat(editor => editor.locator('#draft-newestPosition').selectOption('bottom'));
  await output.waitForFunction(first => document.querySelector('.stage-comment').textContent !== first, bottom[0]);
  assert.deepEqual(await comments(output), bottom.reverse());
  await page.reload(); await appReady(page);
  assert.equal((await readDesign(url)).studio.maxVisible, 3);
  await page.locator('[data-page="settings"]').click();
  await page.locator('#studio-list-count').fill('2');
  await page.locator('#studio-list-count').dispatchEvent('change');
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 2);
  assert.deepEqual(errors, []);
});

browserTest('output expires without messages, preserves speech and restores retained history only when settings allow it', async t => {
  const { context, page, url, errors } = await fixture(t, { maxVisible: null });
  // Isolate a protocol producer so no application heartbeat can cause a redraw.
  await page.close();
  const producer = await context.newPage();
  await saveStudio(url, { maxVisible: 8, holdSeconds: 5 });
  await producer.goto(producerPage(url));
  await producer.evaluate(() => {
    window.testChannel = new BroadcastChannel('pokome-output-v2');
    window.testSnapshot = { v: 2, type: 'snapshot', controllerId: 'test-controller', seq: 0, received: 100,
      messages: [], speech: { user: 'speaker', text: 'keep speaking', speaking: true }, credit: 'test credit' };
    window.testChannel.onmessage = event => { if (event.data.type === 'hello') window.testChannel.postMessage(window.testSnapshot); };
  });
  const output = await context.newPage();
  await output.goto(`${url}/output.html`);
  await output.waitForFunction(() => document.querySelector('#stage-count')?.textContent === '100 COMMENTS');
  assert.deepEqual(await comments(output), []);
  await producer.evaluate(() => {
    const now = Date.now();
    window.testSnapshot.messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), user: `user${i}`, text: `body${i}`, receivedAt: now - 3500 }));
    window.testChannel.postMessage(window.testSnapshot);
  });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 8);
  assert.deepEqual(await output.locator('.stage-comment strong').allTextContents(), Array.from({ length: 8 }, (_, i) => `user${i + 92}`));
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 0);
  assert.equal(await output.locator('#stage-speech-text').textContent(), 'keep speaking');
  assert.equal(await output.locator('#stage-speech-credit').textContent(), 'test credit');
  await output.reload();
  await output.waitForFunction(() => document.querySelector('#stage-count')?.textContent === '100 COMMENTS');
  assert.deepEqual(await comments(output), []);
  await saveStudio(url, { maxVisible: 30, holdSeconds: 0, newestPosition: 'top' });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 30);
  assert.equal(await output.locator('.stage-comment strong').first().textContent(), 'user99');
  await producer.evaluate(() => window.testChannel.postMessage({ v: 2, type: 'remove', controllerId: 'test-controller', seq: 1, received: 100, ids: ['99', '98'] }));
  await output.waitForFunction(() => document.querySelector('.stage-comment strong').textContent === 'user97');
  // A replacement controller keeps original receive times rather than reviving expired cards.
  await saveStudio(url, { maxVisible: 8, holdSeconds: 5 });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length <= 8);
  await producer.evaluate(() => {
    window.testChannel.postMessage({ v: 2, type: 'bye', role: 'controller', id: 'test-controller' });
    window.testSnapshot.controllerId = 'replacement-controller';
    window.testChannel.postMessage(window.testSnapshot);
  });
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 0);
  assert.deepEqual(errors, []);
});

browserTest('top output keeps a long newest card scrollable and preview applies or cancels display settings', async t => {
  const { context, page, url, errors } = await fixture(t, { maxVisible: 8 });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  const output = await context.newPage();
  await output.goto(`${url}/output.html`);
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 8);
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  await page.locator('#draft-maxVisible').selectOption('1');
  await page.locator('#draft-holdSeconds').selectOption('5');
  await page.locator('#draft-newestPosition').selectOption('top');
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('.stage-comment').first().waitFor();
  assert.equal(await frame.locator('.stage-comment').count(), 1);
  await page.waitForTimeout(5100);
  assert.equal(await frame.locator('.stage-comment').count(), 1);
  assert.equal((await comments(output)).length, 8);
  await closeEditor(page);
  assert.equal((await readDesign(url)).studio.maxVisible, 8);
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  await page.locator('#draft-maxVisible').selectOption('1');
  await page.locator('#draft-holdSeconds').selectOption('15');
  await page.locator('#draft-newestPosition').selectOption('top');
  await page.locator('#apply-design').click();
  await output.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 1);
  const saved = (await waitForDesign(url, design => design.studio.maxVisible === 1)).studio;
  assert.deepEqual([saved.holdSeconds, saved.newestPosition], [15, 'top']);
  // Replace the producer to check a single card taller than its viewport.
  await page.close();
  await output.close();
  const producer = await context.newPage();
  await producer.goto(producerPage(url));
  await producer.evaluate(() => {
    const channel = new BroadcastChannel('pokome-output-v2');
    channel.onmessage = event => { if (event.data.type === 'hello') channel.postMessage({ v: 2, type: 'snapshot', controllerId: 'long-card', seq: 0, received: 1,
      messages: [{ id: 'long', user: 'long user', text: 'long line\n'.repeat(200), receivedAt: Date.now() }] }); };
    window.testChannel = channel;
  });
  const longOutput = await context.newPage();
  await longOutput.setViewportSize({ width: 640, height: 360 });
  await longOutput.goto(`${url}/output.html`);
  await longOutput.waitForFunction(() => document.querySelector('.stage-comment strong')?.textContent === 'long user');
  const dimensions = await longOutput.evaluate(() => {
    const card = document.querySelector('.stage-comment'), list = document.querySelector('#stage-chat-list');
    return { long: card.getBoundingClientRect().height > list.clientHeight, clipped: card.classList.contains('stage-comment-clipped'), top: list.scrollTop, scrollable: list.scrollHeight > list.clientHeight };
  });
  assert.deepEqual(dimensions, { long: true, clipped: false, top: 0, scrollable: true });
  assert.deepEqual(errors, []);
});

browserTest('output window mirrors visible comments without controls and follows hiding and appearance changes', async t => {
  const { context, page, errors } = await fixture(t);
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#output-background').selectOption('key');
  await page.locator('#output-key').selectOption('ff00ff');
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.waitForLoadState();
  assert.match(output.url(), /\/output\.html\?background=key&key=ff00ff$/);
  await output.locator('.stage-comment').nth(11).waitFor();
  assert.equal((await comments(output)).length, 12);
  assert.equal(await controls(output), 0);
  assert.equal(await output.locator('#actor-placeholder').isVisible(), false);
  const [, body, , stage] = await backgrounds(output);
  assert.equal(body, 'rgb(255, 0, 255)');
  assert.equal(stage, 'rgba(0, 0, 0, 0)');
  // Half-transparent decoration would leave key-colored fringes.
  assert.deepEqual(await output.evaluate(() => {
    const actor = getComputedStyle(document.querySelector('.stage-actor'));
    return [getComputedStyle(document.querySelector('.stage-decoration')).display, getComputedStyle(document.querySelector('.stage-actor'), '::before').display, actor.backgroundImage, actor.borderTopColor];
  }), ['none', 'none', 'none', 'rgba(0, 0, 0, 0)']);
  await page.locator('#output-status').filter({ hasText: '1個 接続中' }).waitFor();

  // Opening again reuses the named window instead of adding another output.
  const pages = context.pages().length;
  await page.locator('#open-output-window').click();
  await page.waitForTimeout(300);
  assert.equal(context.pages().length, pages);

  // A hidden user's comments are filtered before they are published.
  await page.locator('.nav[data-page="home"]').click();
  await page.locator('#comment-list .username').first().click();
  await page.locator('#hide-user').click();
  await output.waitForFunction(() => ![...document.querySelectorAll('.stage-comment')].some(card => card.textContent.startsWith('minto_0123')));
  assert.ok((await comments(output)).length < 12);
  await page.locator('#demo').click();
  await output.waitForFunction(() => document.querySelector('#stage-count').textContent === '13 COMMENTS');

  // Appearance arrives through shared storage.
  await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('rose'));
  await output.waitForFunction(() => document.querySelector('#talk-stage').dataset.theme === 'rose');
  assert.deepEqual(errors, []);
});

browserTest('closing the followed control page hands the output to a remaining one without new comments', async t => {
  const { context, page, url, errors } = await fixture(t);
  const output = await context.newPage();
  output.setDefaultTimeout(8000);
  await output.goto(`${url}/output.html?background=theme`);
  await output.locator('.stage-comment').nth(11).waitFor({ state: 'attached' });
  // Page A gains one comment so its list differs from page B's.
  await page.locator('#demo').click();
  await output.waitForFunction(() => document.querySelector('#stage-count').textContent === '13 COMMENTS');
  const second = await context.newPage();
  second.setDefaultTimeout(8000);
  await second.goto(url); await appReady(second);
  await second.locator('#comment-list .username').nth(11).waitFor();
  // The output keeps following A while A is alive.
  await output.waitForTimeout(2500);
  assert.equal(await output.locator('#stage-count').textContent(), '13 COMMENTS');
  // B stays quiet: only its heartbeat can trigger the handover.
  await page.close({ runBeforeUnload: true });
  await output.waitForFunction(() => document.querySelector('#stage-count').textContent === '12 COMMENTS');
  assert.equal((await comments(output)).length, 12);
  assert.deepEqual(errors, []);
});

browserTest('transparent output stays empty and transparent without a control page', async t => {
  const { context, url, errors } = await fixture(t);
  const output = await context.newPage();
  await context.pages()[0].close();
  await output.goto(`${url}/output.html?background=transparent`);
  await output.locator('#talk-stage').waitFor();
  await output.waitForTimeout(300);
  assert.deepEqual(await backgrounds(output), Array(4).fill('rgba(0, 0, 0, 0)'));
  // Only the key background removes decoration; transparency keeps it.
  assert.equal(await output.evaluate(() => getComputedStyle(document.querySelector('.stage-decoration')).display), 'block');
  assert.deepEqual(await comments(output), []);
  assert.equal(await controls(output), 0);
  const text = await output.locator('body').innerText();
  assert.doesNotMatch(text, /待っています|あなたの居場所|雑談モードを終了/);
  // Without a query, a plain browser falls back to the theme background.
  await output.goto(`${url}/output.html`);
  await output.locator('#talk-stage').waitFor();
  assert.notEqual((await backgrounds(output))[3], 'rgba(0, 0, 0, 0)');
  // OBS exposes window.obsstudio, which selects transparency by default.
  await output.addInitScript(() => { window.obsstudio = { pluginVersion: 'test' }; });
  await output.goto(`${url}/output.html`);
  await output.locator('#talk-stage').waitFor();
  assert.deepEqual(await backgrounds(output), Array(4).fill('rgba(0, 0, 0, 0)'));
  assert.deepEqual(errors, []);
});

browserTest('output keeps the newest comment visible after shrinking', async t => {
  const { context, page, errors } = await fixture(t);
  await page.locator('.nav[data-page="studio"]').click();
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.setViewportSize({ width: 1280, height: 720 });
  await output.locator('.stage-comment').nth(11).waitFor({ state: 'attached' });
  const atBottom = () => output.evaluate(() => {
    const list = document.querySelector('#stage-chat-list');
    return list.scrollHeight - list.scrollTop - list.clientHeight < 2;
  });
  await output.waitForFunction(() => document.querySelector('#stage-chat-list').scrollTop > 0);
  await output.setViewportSize({ width: 1280, height: 300 });
  await output.waitForFunction(() => { const list = document.querySelector('#stage-chat-list'); return list.scrollHeight - list.scrollTop - list.clientHeight < 2; });
  assert.equal(await atBottom(), true);
  assert.deepEqual(errors, []);
});

browserTest('reopening the output window applies a newly chosen size', async t => {
  // Without viewport emulation, window.open sizes and resizeTo take effect.
  // A large virtual screen keeps the window manager from clamping the sizes.
  const { context, page, errors } = await fixture(t, { viewport: null, args: ['--screen-info={0,0 3000x2400}'] });
  await page.locator('.nav[data-page="studio"]').click();
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1280x720'));
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.waitForLoadState();
  const size = () => output.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(await size(), [1280, 720]);
  await applyInEditor(page, editor => editor.locator('#draft-outputSize').selectOption('1080x1920'));
  await page.locator('#open-output-window').click();
  await output.waitForFunction(() => innerWidth === 1080 && innerHeight === 1920);
  await page.locator('#output-status').filter({ hasText: '1080 × 1920' }).waitFor();
  assert.deepEqual(errors, []);
});
