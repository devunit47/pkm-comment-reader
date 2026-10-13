import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from './browser-support.js';

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
