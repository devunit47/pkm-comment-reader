import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { appReady, blockExternalFonts, browserAvailable, chromium, executablePath, closeBrowser } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);

function contrastFailures() {
  const rgb = value => {
    const match = value.match(/[\d.]+/g)?.map(Number);
    return match?.length >= 3 ? match.slice(0, 3).map(channel => value.startsWith('color(srgb ') ? channel * 255 : channel) : null;
  };
  const luminance = channels => channels.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + .05) / (dark + .05); };
  const failures = [];
  const roots = [document, ...[...document.querySelectorAll('*')].map(element => element.shadowRoot).filter(Boolean)];
  for (const element of roots.flatMap(root => [...root.querySelectorAll('h1,h2,h3,p,small,label,button,input,select,a,.connection-badge,.service-status')])) {
    if (!element.checkVisibility() || !element.getClientRects().length || element.matches(':disabled')) continue;
    const view = getComputedStyle(element), color = rgb(view.color);
    if (!color) continue;
    let parent = element, background;
    while (parent && !background) {
      const value = getComputedStyle(parent).backgroundColor;
      const alpha = value.startsWith('rgba(') ? Number(value.match(/[\d.]+/g)?.[3] ?? 1) : 1;
      if (value !== 'transparent' && alpha > 0) background = rgb(value);
      parent = parent.parentElement || parent.getRootNode().host;
    }
    if (!background) background = rgb(getComputedStyle(document.body).backgroundColor);
    if (!background) continue;
    const size = parseFloat(view.fontSize), weight = Number(view.fontWeight) || (view.fontWeight === 'bold' ? 700 : 400);
    const minimum = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (contrast(color, background) < minimum) failures.push(`${element.tagName}#${element.id}.${element.className}: ${contrast(color, background).toFixed(2)}:1 < ${minimum}:1 (${view.color} on ${background}, ${element.textContent.trim().slice(0, 30)})`);
}
return failures;
}


browserTest('operating UI follows the system color scheme and keeps text contrast readable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-ui-theme-'));
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data') });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await closeBrowser(browser);
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const colorScheme of ['dark', 'light']) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await blockExternalFonts(page);
    await page.goto(base);
    await appReady(page);
    assert.ok(await page.locator('body').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 14, 'operating body text is at least 14px');
    const pages = ['home', 'users', 'settings', 'studio', 'updates'];
    for (const name of pages) {
      await page.locator(`[data-page="${name}"]`).click();
      await page.locator(`#${name}-page`).waitFor({ state: 'visible' });
      assert.ok(await page.locator('main > header h1').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 21, 'page heading retains its type hierarchy');
      const failures = await page.evaluate(contrastFailures);
      assert.deepEqual(failures, [], `${colorScheme}/${name} contrast`);
      if (name === 'studio') {
        const primaryCount = await page.evaluate(() => {
          const roots = [document, ...[...document.querySelectorAll('*')].map(element => element.shadowRoot).filter(Boolean)];
          return roots.flatMap(root => [...root.querySelectorAll('button.primary')]).filter(button => button.checkVisibility()).length;
        });
        assert.equal(primaryCount, 1, 'design page has one primary action');
      }
    }
    await page.locator('#open-setup').click();
    await page.locator('#setup-dialog[open]').waitFor();
    assert.deepEqual(await page.evaluate(contrastFailures), [], colorScheme + '/setup contrast');
    await page.keyboard.press('Escape');
    await page.locator('[data-page=studio]').click();
    const editor = page.locator('#design-preview-editor');
    await editor.locator('#open-design-preview').click(); await editor.locator('#apply-design:not(:disabled)').waitFor();
    assert.deepEqual(await page.evaluate(contrastFailures), [], colorScheme + '/editor contrast');
    await editor.locator('#cancel-design').click();
    await page.locator('[data-page=home]').click();
    for (const state of ['connected', 'connecting', 'disconnected', 'error']) {
      await page.locator('#twitch-tab-status').evaluate((element, state) => { element.dataset.state = state; }, state);
      assert.deepEqual(await page.evaluate(contrastFailures), [], colorScheme + '/' + state + ' contrast');
    }
    const stateColors = await page.locator('#twitch-tab-status').evaluate(element => {
      const values = {};
      for (const state of ['connected', 'connecting', 'disconnected', 'error']) {
        element.dataset.state = state;
        const style = getComputedStyle(element);
        values[state] = `${style.color}/${style.borderColor}/${getComputedStyle(element, '::before').color}`;
      }
      return values;
    });
    assert.equal(new Set(Object.values(stateColors)).size, 4, `${colorScheme} connection states have distinct colors: ${JSON.stringify(stateColors)}`);
    const result = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const tokens = ['--ui-bg', '--ui-surface', '--ui-raised', '--ui-line', '--ui-text', '--ui-muted', '--ui-accent', '--ui-accent-text', '--ui-ok', '--ui-warn', '--ui-danger', '--ui-twitch', '--ui-kick'];
      return { colorScheme: root.colorScheme, missing: tokens.filter(token => !root.getPropertyValue(token).trim()), legacy: ['--bg', '--panel', '--line', '--mint', '--muted', '--text'].filter(token => root.getPropertyValue(token).trim()),
        background: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color };
    });
    assert.equal(result.colorScheme, colorScheme);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.legacy, []);
    await page.locator('#demo').click();
    await page.locator('#comment-list .username').first().click();
    await page.locator('#user-actions').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(contrastFailures), [], colorScheme + '/user-actions contrast');
    await page.keyboard.press('Escape');
    await page.locator('#enter-talk').click();
    await page.setViewportSize({ width: 300, height: 1000 });
    await page.locator('#leave-talk').focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#talk-controls')).opacity === '1');
    assert.deepEqual(await page.evaluate(contrastFailures), [], colorScheme + '/talk-controls contrast');
    assert.ok(await page.locator('#talk-controls .stage-exit-hint').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 12, 'talk operating hints remain at least 12px');
    for (const page of context.pages()) await page.close();
    await context.close();
  }
});
