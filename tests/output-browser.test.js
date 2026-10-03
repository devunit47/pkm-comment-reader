import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);

async function fixture(t, { viewport = { width: 1440, height: 1000 }, args = [] } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath, args });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-output-browser-'));
  const server = createServer({ customizationDirectory: directory });
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
  await page.goto(url);
  return { context, page, url, errors };
}
const comments = output => output.locator('.stage-comment').evaluateAll(cards => cards.map(card => card.textContent));
const backgrounds = output => output.evaluate(() => ['html', 'body', 'main', '#talk-stage'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
const controls = output => output.evaluate(() => document.querySelectorAll('button,input,select,textarea,dialog,[popover],output').length);

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
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#studio-theme').selectOption('rose');
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
  await second.goto(url);
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
  await page.locator('#output-size').selectOption('1280x720');
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.waitForLoadState();
  const size = () => output.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(await size(), [1280, 720]);
  await page.locator('#output-size').selectOption('1080x1920');
  await page.locator('#open-output-window').click();
  await output.waitForFunction(() => innerWidth === 1080 && innerHeight === 1920);
  await page.locator('#output-status').filter({ hasText: '1080 × 1920' }).waitFor();
  assert.deepEqual(errors, []);
});
