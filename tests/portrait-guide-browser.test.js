import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, appReady, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
const EDITOR = '#design-preview-editor';

// While the preview is still loading, the dialog already shows the ratio
// selector; the toggle must not appear for a landscape ratio in the meantime.
browserTest('the covered-area toggle stays hidden for 16:9 while the preview is still loading', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-guide-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(context);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.address().port}`); await appReady(page);
  await page.locator('[data-page="studio"]').click();
  const editor = page.locator(EDITOR);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/speech-background.svg', async route => { await gate; await route.continue(); });
  await editor.locator('#open-design-preview').click();
  await editor.locator('#design-dialog').waitFor({ state: 'visible' });
  assert.equal(await editor.locator('#preview-ratio').inputValue(), '16:9');
  const visibleWhileLoading = await editor.locator('#preview-guides').isVisible();
  release();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  assert.equal(visibleWhileLoading, false);
});
