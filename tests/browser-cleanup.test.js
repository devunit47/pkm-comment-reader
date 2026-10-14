import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser, chromium, executablePath, browserAvailable } from './browser-support.js';

test('test browsers finish speech silently in pages and popups', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>speech</title>');
    // Real speech of this text takes many seconds (and plays through the speakers).
    const speak = target => target.evaluate(() => new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance('読み上げの確認です。'.repeat(20)); utterance.volume = 0;
      utterance.onend = () => resolve('end'); utterance.onerror = event => resolve(`error:${event.error}`);
      speechSynthesis.speak(utterance); setTimeout(() => resolve('timeout'), 2000);
    }));
    assert.equal(await speak(page), 'end');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => { window.open('about:blank', 'speech', 'popup'); })]);
    assert.equal(await speak(popup), 'end');
  } finally { await closeBrowser(browser); }
});

test('browser cleanup waits for every page before closing contexts and the browser', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let pageClosed = false, contextClosed = false, browserClosed = false;
  const context = { pages: () => [{ async close() { started.resolve(); await release.promise; pageClosed = true; } }],
    async close() { assert.equal(pageClosed, true); contextClosed = true; } };
  const closing = closeBrowser({ contexts: () => [context], async close() { browserClosed = true; } });
  try {
    await Promise.race([started.promise, closing]);
    assert.equal(browserClosed, false, 'the browser must not force-quit a live output page');
    release.resolve(); await closing;
    assert.equal(contextClosed, true); assert.equal(browserClosed, true);
  } finally { release.resolve(); await closing; }
});

test('browser cleanup still closes contexts and the browser after a page fails to close', async () => {
  const failure = new Error('page close failed');
  let contextClosed = false, browserClosed = false;
  const context = { pages: () => [{ async close() { throw failure; } }], async close() { contextClosed = true; } };
  await assert.rejects(closeBrowser({ contexts: () => [context], async close() { browserClosed = true; } }), failure);
  assert.equal(contextClosed, true); assert.equal(browserClosed, true);
});
