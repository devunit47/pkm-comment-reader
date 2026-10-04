import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../server.js';
import { stageLocalFiles } from '../scripts/build-local.js';
import { chromium, executablePath, browserAvailable, blockExternalFonts, appReady } from './browser-support.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

// Native HTTP preserves the deliberately supplied Host; fetch rewrites it.
const write = (url, headers, body) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'PUT', headers }, response => {
    response.resume(); response.on('end', () => resolve(response.statusCode));
  });
  req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('write timed out'))); req.end(body);
});

async function serve(t, packaged) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-write-headers-'));
  let factory = createServer;
  if (packaged) {
    await stageLocalFiles(pathToFileURL(folder + '/'));
    factory = (await import(pathToFileURL(join(folder, 'server.js')).href)).createServer;
  }
  const server = factory({ customizationDirectory: join(folder, 'customization') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const packaged of [false, true]) {
  const edition = packaged ? 'packaged distribution' : 'development';
  test(`${edition}: writes require the local Host, matching Origin and same-origin fetch site`, async t => {
    const base = await serve(t, packaged);
    const current = await (await fetch(`${base}/api/design/current`)).json();
    const good = { 'Content-Type': 'application/json', 'If-Match': current.revision, Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    const cases = [
      { 'Sec-Fetch-Site': undefined }, { 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: undefined }, { Origin: 'null' }, { Origin: 'https://example.invalid' },
      { Host: 'example.invalid', Origin: 'http://example.invalid' },
    ];
    for (const changed of cases) {
      const headers = { ...good, ...changed };
      for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
      assert.equal(await write(`${base}/api/design/current`, headers, JSON.stringify(current.design)), 403, JSON.stringify(changed));
    }
    for (const hostname of ['127.0.0.1', 'localhost']) {
      const host = `${hostname}:${new URL(base).port}`, origin = `http://${host}`;
      const value = await (await fetch(`${base}/api/design/current`)).json();
      const headers = { ...good, Host: host, Origin: origin, 'If-Match': value.revision };
      assert.equal(await write(`${base}/api/design/current`, headers, JSON.stringify(value.design)), 200);
      assert.equal(await write(`${base}/api/design/images`, { ...headers, 'Content-Type': 'image/png' }, png), 200);
    }
  });

  test(`${edition}: an actual browser supplies the required headers for design and image writes`, { skip: !browserAvailable, timeout: 30000 }, async t => {
    let browser;
    const base = await serve(t, packaged);
    t.after(() => browser?.close());
    browser = await chromium.launch({ headless: true, executablePath, timeout: 10000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
    await blockExternalFonts(page);
    await page.goto(base); await appReady(page);
    const result = await page.evaluate(async () => {
      const { createDesignStore } = await import('/src/browser/design-client.js');
      const store = await createDesignStore({ watch: false });
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), value => value.charCodeAt(0));
      const image = await store.uploadImage(new Blob([bytes], { type: 'image/png' }));
      await store.save({ ...store.design, studio: { ...store.design.studio, title: 'ヘッダー確認', image: image.ref } });
      const current = await (await fetch('/api/design/current')).json();
      return { title: current.design.studio.title, image: current.design.studio.image };
    });
    assert.equal(result.title, 'ヘッダー確認');
    assert.match(result.image, /^images\/[a-f0-9]{64}\.png$/);
  });
}
