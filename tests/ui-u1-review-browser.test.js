import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { appReady, blockExternalFonts, browserAvailable, chromium, executablePath, closeBrowser } from './browser-support.js';

// Reviewer checks for U1: the scene must look exactly as on master, and every
// operating surface (including menus and dialogs) must stay readable.
let masterCSS = null;
try { masterCSS = execFileSync('git', ['show', 'master:style.css'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { /* No master ref. */ }
const browserTest = (name, run, extra = {}) => test(name, { skip: !browserAvailable || extra.skip }, run);

async function serve(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-u1-review-'));
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data') });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await closeBrowser(browser);
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { browser, base: `http://127.0.0.1:${server.address().port}` };
}

const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'fontSize', 'fontWeight', 'lineHeight', 'paddingTop', 'paddingLeft', 'width', 'height', 'display', 'visibility', 'opacity'];
async function sceneStyles(page) {
  return page.locator('#talk-stage').evaluate((stage, props) => [stage, ...stage.querySelectorAll('*')].map((element, index) => {
    const style = getComputedStyle(element);
    return [index + ':' + element.tagName + (element.id ? '#' + element.id : '') + '.' + [...element.classList].join('.'), Object.fromEntries(props.map(prop => [prop, style[prop]]))];
  }), PROPS);
}

browserTest('output scene computed styles equal master stylesheet across sizes and color schemes', async t => {
  const { browser, base } = await serve(t);
  const differences = [];
  for (const colorScheme of ['dark', 'light']) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 800, height: 500 }, { width: 500, height: 800 }, { width: 375, height: 700 }]) {
      const results = {};
      for (const variant of ['master', 'branch']) {
        const context = await browser.newContext({ colorScheme, viewport });
        const page = await context.newPage();
        await blockExternalFonts(page);
        if (variant === 'master') await page.route('**/style.css', route => route.fulfill({ contentType: 'text/css; charset=utf-8', body: masterCSS }));
        await page.goto(base + '/output.html');
        await page.locator('#talk-stage[data-theme]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        results[variant] = await sceneStyles(page);
        await page.close(); await context.close();
      }
      assert.equal(results.branch.length, results.master.length, 'same scene element count');
      results.master.forEach(([key, style], index) => {
        const [, actual] = results.branch[index];
        for (const prop of PROPS) if (style[prop] !== actual[prop]) differences.push(`${colorScheme} ${viewport.width}x${viewport.height} ${key} ${prop}: master=${style[prop]} branch=${actual[prop]}`);
      });
    }
  }
  assert.deepEqual(differences, []);
}, { skip: !masterCSS && 'master stylesheet is unavailable' });
