import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTheme, MAX_THEME_CSS_BYTES } from '../src/shared/theme.js';

import { chromium, executablePath, browserAvailable } from './browser-support.js';

test('theme validation with browser CSSOM', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
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
      // Settings rely on an important first-declared layer; themes must not declare layers.
      { css: '@layer pokome-settings { .pokome-workspace { color: red } }', valid: false },
      { css: '@layer early, pokome-settings; .pokome-workspace { color: red }', valid: false },
      { css: '@media (min-width: 1px) { @layer x { .pokome-workspace { color: red } } }', valid: false },
      { css: '@font-face { font-family: external; src: url(https://example.com/font.woff2) }', valid: false },
      // The folder era allows up to 1MB (formerly 100KB because of browser storage).
      { css: '/*' + 'a'.repeat(MAX_THEME_CSS_BYTES - 4) + '*/', valid: true },
      { css: '/*' + 'a'.repeat(MAX_THEME_CSS_BYTES - 3) + '*/', valid: false },
      { css: '/*' + 'あ'.repeat(MAX_THEME_CSS_BYTES / 3) + '*/', valid: false },
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
