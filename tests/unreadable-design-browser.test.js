import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createServer } from '../server.js';
import { UNREFERENCED_IMAGE_GRACE_MS } from '../src/server/design-storage.js';
import { fixtureDesign, fixtureFiles } from './fixtures/preset-design.js';
import { closeBrowser, chromium, executablePath, browserAvailable, appReady, blockExternalFonts, editorTarget, temporaryDataDirectory, matrixCases } from './browser-support.js';

async function open(t, raw = JSON.stringify(fixtureDesign()), obsoleteWorkspace) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-unreadable-browser-'));
  const current = join(folder, 'current');
  const preset = join(folder, 'presets', 'kept');
  for (const target of [current, preset]) {
    await mkdir(join(target, 'images'), { recursive: true });
    await writeFile(join(target, 'design.json'), target === current ? raw : JSON.stringify(fixtureDesign()));
    for (const [ref, bytes] of Object.entries(fixtureFiles)) {
      await writeFile(join(target, ref), bytes);
      const past = new Date(Date.now() - UNREFERENCED_IMAGE_GRACE_MS - 60000);
      await utimes(join(target, ref), past, past);
    }
  }
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: folder });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => {
    await closeBrowser(browser);
    await new Promise(resolveClose => server.close(resolveClose));
    const target = resolve(folder);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('pokome-unreadable-browser-'));
    await rm(target, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await blockExternalFonts(page);
  if (obsoleteWorkspace !== undefined) await page.addInitScript(value => localStorage.setItem('pokome-workspace-v1', value), obsoleteWorkspace);
  const puts = [], errors = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/design/current')) puts.push(request); });
  page.on('pageerror', error => errors.push(error.message));
  const list = page.waitForResponse(response => response.url().endsWith('/api/design/presets') && response.status() === 200);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await appReady(page); await (await list).finished();
  const assertOriginal = async expected => {
    assert.equal(await readFile(join(current, 'design.json'), 'utf8'), expected);
    for (const [ref, bytes] of Object.entries(fixtureFiles)) assert.deepEqual(await readFile(join(current, ref)), bytes);
  };
  return { page, current, puts, errors, assertOriginal };
}

for (const [kind, raw] of Object.entries({ 'broken JSON': '{broken', 'unknown version': JSON.stringify({ ...fixtureDesign(), version: 99 }) })) {
  test(`${kind}: the page shows backup guidance and blocks reset, preset apply and edits`, { skip: !browserAvailable }, async t => {
    const app = await open(t, raw), { page } = app;
    const recovery = page.locator('#appearance-recovery');
    assert.equal(await recovery.locator('button,dialog').count(), 0, 'protection guidance contains no inactive controls');
    assert.match(await recovery.textContent(), /退避/);
    assert.equal(await recovery.isVisible(), true);
    for (const { colorScheme, width } of matrixCases({ colorScheme: ['dark', 'light'], width: [1280, 300] })) {
      await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 1000 });
      const appearance = await recovery.evaluate(element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = channels => channels.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const [light, dark] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((a, b) => b - a);
        return { contrast: (light + .05) / (dark + .05), left: box.left, right: box.right, overflow: element.scrollWidth > element.clientWidth };
      });
      assert.ok(appearance.contrast >= 4.5, colorScheme + ' protection guidance meets AA');
      assert.ok(appearance.left >= 0 && appearance.right <= width, width + 'px protection guidance stays inside the viewport');
      assert.equal(appearance.overflow, false, 'protection guidance wraps');
    }
    await page.locator('[data-page="studio"]').click();
    const presets = page.locator('#design-presets');
    await presets.locator('#preset-select').selectOption('kept');
    for (const action of ['save', 'reset', 'load', 'overwrite']) assert.equal(await presets.locator(`#preset-${action}`).isDisabled(), true);
    assert.equal(await presets.locator('#preset-rename').isEnabled(), true);
    // The editor may draft, but Apply is refused while the original is protected.
    const editor = page.locator('#design-preview-editor');
    await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
    await editorTarget(editor, 'header'); await editor.locator('#draft-title').fill('保存しない題名');
    await editor.locator('#apply-design').click();
    await editor.locator('#design-status').filter({ hasText: '退避' }).waitFor();
    assert.equal(await editor.locator('#design-dialog').isVisible(), true);
    assert.equal(app.puts.length, 0);
    await app.assertOriginal(raw);
    assert.deepEqual(app.errors, []);
  });
}

test('reset protects a newly broken original without clearing obsolete browser layout data', { skip: !browserAvailable }, async t => {
  const obsoleteWorkspace = JSON.stringify({ version: 1, home: { panels: {} }, talk: null });
  const app = await open(t, JSON.stringify(fixtureDesign()), obsoleteWorkspace), { page } = app;
  const raw = '{broken after load';
  await writeFile(join(app.current, 'design.json'), raw);
  await page.locator('[data-page=studio]').click();
  await page.locator('#design-presets #preset-reset').click();
  await page.locator('#design-presets #preset-confirm').click();
  await page.locator('#design-presets #preset-status').filter({ hasText: '退避' }).waitFor();
  await page.locator('#appearance-recovery').waitFor({ state: 'visible' });
  assert.match(await page.locator('#appearance-recovery').textContent(), /退避/);
  assert.equal(await page.locator('#appearance-recovery button,#appearance-recovery dialog').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), obsoleteWorkspace);
  assert.equal(app.puts.length, 1);
  await app.assertOriginal(raw);
  assert.deepEqual(app.errors, []);
});
