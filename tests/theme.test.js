import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { compileTheme } from '../theme.js';

const require = createRequire(import.meta.url);
const bundledPlaywright = 'C:/Users/<user>/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const browserPath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('theme validation with browser CSSOM', { skip: !existsSync(bundledPlaywright) || !existsSync(browserPath) }, async () => {
  const { chromium } = require(bundledPlaywright);
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
    const page = await browser.newPage();
    const cases = [
      { css: '.pokome-workspace { color: red }', valid: true },
      { css: '.pokome-workspace > .pokome-panel { border-radius: 8px }', valid: true },
      { css: '@media (min-width: 1px) { .pokome-workspace .pokome-panel { color: red } }', valid: true },
      { css: '@supports (display: grid) { .pokome-workspace { display: grid } }', valid: true },
      { css: '/* comment only */', valid: true },
      { css: '.pokome-workspace ~ body { color: red }', valid: false },
      { css: '.pokome-workspace .x, body { color: red }', valid: false },
      { css: '.pokome-workspace .x { background: url(https://example.com/image.png) }', valid: false },
      { css: '@import url(https://example.com/theme.css); .pokome-workspace { color:red }', valid: false },
      { css: '.pokome-workspace { & + body { color:red } }', valid: false },
      { css: '@media screen { body { color: red } }', valid: false },
      { css: '@font-face { font-family: external; src: url(https://example.com/font.woff2) }', valid: false },
    ];
    const results = await page.evaluate(({ source, cases }) => {
      const compile = (0, eval)(`(${source})`);
      return cases.map(({ css }) => {
        try { return { valid: true, compiled: compile(css) }; }
        catch (error) { return { valid: false, message: error.message }; }
      });
    }, { source: compileTheme.toString(), cases });
    cases.forEach(({ css, valid }, index) => assert.equal(results[index].valid, valid, `${css}: ${JSON.stringify(results[index])}`));
  } finally {
    await browser.close();
  }
});
