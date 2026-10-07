import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, saveDesign, waitForDesign, appReady, applyInEditor, editorTarget, closeEditor, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);

async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-comment-look-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(context);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(url); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  return { context, page, url, errors };
}
// Comment list settings are edited in the editor's comment target and applied at once.
const chat = (page, steps) => applyInEditor(page, async editor => { await editorTarget(editor, 'chat'); await steps(editor); });
// Computed values of the first stage comment and its panel.
const look = target => target.evaluate(() => {
  const comment = document.querySelector('#stage-chat-list .stage-comment');
  const style = element => getComputedStyle(element);
  return {
    panel: style(document.querySelector('.stage-chat')).backgroundColor,
    panelBorder: style(document.querySelector('.stage-chat')).borderTopColor,
    text: style(comment.querySelector('p')).color,
    author: style(comment.querySelector('strong')).color,
    shadow: style(comment.querySelector('p')).textShadow,
    lineHeight: style(comment.querySelector('p')).lineHeight,
    paddingTop: style(comment).paddingTop,
    divider: style(comment).borderTopWidth,
    heading: style(document.querySelector('.stage-chat .stage-panel-label h2')).visibility,
    label: style(document.querySelector('.stage-chat .stage-panel-label')).display,
  };
});

browserTest('comment presets restyle the live stage and output, then return exactly to the theme', async t => {
  const { context, page, errors, url } = await fixture(t);
  const original = await look(page);
  assert.equal(original.shadow, 'none');

  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('outline'));
  const outline = await look(page);
  assert.equal(outline.panel, 'rgba(0, 0, 0, 0)');
  assert.equal(outline.panelBorder, 'rgba(0, 0, 0, 0)');
  assert.equal(outline.text, 'rgb(255, 255, 255)');
  assert.equal(outline.author, 'rgb(255, 255, 255)');
  assert.match(outline.shadow, /rgb\(0, 0, 0\) 1px 0px 0px/);
  assert.equal(outline.divider, '0px');
  // The live stage keeps its label row for live status; only the text hides.
  assert.deepEqual([outline.heading, outline.label], ['hidden', 'flex']);

  // The output removes the label row entirely.
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  const mirrored = await look(output);
  assert.deepEqual([mirrored.panel, mirrored.text, mirrored.shadow, mirrored.label], [outline.panel, outline.text, outline.shadow, 'none']);

  await page.bringToFront();
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('dense'));
  assert.equal(await page.locator('#stage-chat-list').getAttribute('data-comment-style'), 'anonymous');
  const dense = await look(page);
  assert.deepEqual([dense.lineHeight, dense.paddingTop], [`${20 * 1.35}px`, '2px']);
  await output.waitForFunction(() => document.querySelector('#stage-chat-list').dataset.commentStyle === 'anonymous');

  // A single adjustment leaves the preset; the selection then shows a custom mix.
  await chat(page, async editor => {
    await editor.locator('#draft-commentPreset').selectOption('light');
    assert.equal(await editor.locator('#draft-commentPanelOpacity').isEnabled(), true);
    // A light panel keeps text readable even with colors left at the dark theme's.
    await editor.locator('#draft-commentTextColorMode').selectOption('theme');
    await editor.locator('#draft-commentAuthorColorMode').selectOption('theme');
  });
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('#stage-chat-list .stage-comment p')).color, getComputedStyle(document.querySelector('.stage-chat .stage-panel-label h2')).color]), ['rgb(31, 42, 36)', 'rgb(31, 42, 36)']);
  await chat(page, async editor => {
    const opacity = editor.locator('#draft-commentPanelOpacity');
    await opacity.fill('60'); await opacity.dispatchEvent('change');
    assert.equal(await editor.locator('#draft-commentPreset').inputValue(), '');
    // Emptied entries keep the value; out-of-range ones clamp.
    for (const [entry, expected] of [['', '60'], ['150', '100'], ['-5', '0'], ['60', '60']]) {
      await opacity.fill(entry); await opacity.dispatchEvent('change');
      assert.equal(await opacity.inputValue(), expected);
    }
  });
  assert.equal((await look(page)).panel, 'rgba(255, 255, 255, 0.6)');

  // The design preview collapses a hidden label exactly like the output.
  await page.locator('#open-design-preview').click();
  await editorTarget(page, 'chat'); await page.locator('#draft-commentLabel').uncheck();
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('#talk-stage').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('.stage-chat .stage-panel-label').evaluate(element => getComputedStyle(element).display), 'none');
  await closeEditor(page);

  // Reload keeps the settings; returning to the theme restores every value.
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  assert.equal((await look(page)).panel, 'rgba(255, 255, 255, 0.6)');
  // Returning to the theme preset restores every value, names included.
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('theme'));
  assert.equal(await page.locator('#stage-chat-list').getAttribute('data-comment-style'), 'stacked');
  assert.equal(await page.locator('#stage-speech-user').evaluate(element => element.hidden), false);
  assert.deepEqual(await look(page), original);
  assert.deepEqual(errors, []);
});

browserTest('theme CSS applies at theme values and an explicit setting takes precedence', async t => {
  const { page, errors, url } = await fixture(t);
  await saveDesign(url, { theme: '.pokome-workspace .pokome-comment__author { color: rgb(1, 2, 3); }' });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  assert.equal((await look(page)).author, 'rgb(1, 2, 3)');
  await chat(page, async editor => {
    await editor.locator('#draft-commentAuthorColorMode').selectOption('custom');
    await editor.locator('#draft-commentAuthorColor').fill('#ff8800');
    await editor.locator('#draft-commentAuthorColor').dispatchEvent('change');
  });
  assert.equal((await look(page)).author, 'rgb(255, 136, 0)');
  await chat(page, editor => editor.locator('#draft-commentAuthorColorMode').selectOption('theme'));
  assert.equal((await look(page)).author, 'rgb(1, 2, 3)');
  assert.deepEqual(errors, []);
});

browserTest('an explicit outline reaches the name and body over a theme text-shadow', async t => {
  const { context, page, errors, url } = await fixture(t);
  await saveDesign(url, { theme: '.pokome-workspace .pokome-comment__body { text-shadow: none; } .pokome-workspace .pokome-comment__author { text-shadow: none; }' });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  const shadows = target => target.evaluate(() => {
    const comment = document.querySelector('#stage-chat-list .stage-comment');
    return [comment.querySelector('.pokome-comment__author'), comment.querySelector('.pokome-comment__body')].map(element => getComputedStyle(element).textShadow);
  });
  assert.deepEqual(await shadows(page), ['none', 'none']);
  for (const [preset, width] of [['outline', '1px'], ['dark', '1px']]) {
    await chat(page, editor => editor.locator('#draft-commentPreset').selectOption(preset));
    for (const shadow of await shadows(page)) assert.ok(shadow.startsWith(`rgb(0, 0, 0) ${width} 0px 0px`), `${preset}: ${shadow}`);
  }
  await chat(page, editor => editor.locator('#draft-commentOutline').selectOption('thick'));
  for (const shadow of await shadows(page)) assert.match(shadow, /^rgb\(0, 0, 0\) 2px 0px 0px/);
  // The output applies the same outline to both elements.
  await waitForDesign(url, design => design.studio.commentOutline === 'thick');
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  for (const shadow of await shadows(output)) assert.match(shadow, /^rgb\(0, 0, 0\) 2px 0px 0px/);
  // Back at the theme value, the theme's own text-shadow applies again.
  await page.bringToFront();
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('theme'));
  assert.deepEqual(await shadows(page), ['none', 'none']);
  assert.deepEqual(errors, []);
});

browserTest('explicit settings win over theme CSS marked !important, and the theme returns at theme values', async t => {
  const { context, page, errors, url } = await fixture(t);
  const theme = [
    '.pokome-workspace .pokome-comment__body { text-shadow: none !important; color: rgb(1, 2, 3) !important; line-height: 3 !important; }',
    '.pokome-workspace .pokome-comment__author { text-shadow: none !important; color: rgb(4, 5, 6) !important; }',
    '.pokome-workspace .stage-chat { background: rgb(7, 8, 9) !important; }',
    // Redefining the variables the settings write must not work either.
    '.pokome-workspace { --stage-comment-text: rgb(10, 11, 12) !important; --stage-comment-outline: rgb(13, 14, 15) !important; --stage-comment-shadow: none !important; }',
    '.pokome-workspace .stage-chat { --stage-comment-ink: rgb(16, 17, 18) !important; --stage-comment-name: rgb(19, 20, 21) !important; }',
  ].join(' ');
  await saveDesign(url, { theme });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  const read = target => target.evaluate(() => {
    const comment = document.querySelector('#stage-chat-list .stage-comment');
    const body = getComputedStyle(comment.querySelector('.pokome-comment__body')), author = getComputedStyle(comment.querySelector('.pokome-comment__author'));
    return { bodyShadow: body.textShadow, bodyColor: body.color, lineHeight: body.lineHeight, authorShadow: author.textShadow, authorColor: author.color, panel: getComputedStyle(document.querySelector('.stage-chat')).backgroundColor };
  });
  const themed = { bodyShadow: 'none', bodyColor: 'rgb(1, 2, 3)', lineHeight: '60px', authorShadow: 'none', authorColor: 'rgb(4, 5, 6)', panel: 'rgb(7, 8, 9)' };
  assert.deepEqual(await read(page), themed);

  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('outline'));
  const outlined = await read(page);
  for (const shadow of [outlined.bodyShadow, outlined.authorShadow]) assert.ok(shadow.startsWith('rgb(0, 0, 0) 1px 0px 0px'), shadow);
  assert.deepEqual([outlined.bodyColor, outlined.authorColor, outlined.panel], ['rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)']);
  await chat(page, editor => editor.locator('#draft-commentLineHeight').selectOption('1.5'));
  assert.equal((await read(page)).lineHeight, '30px');
  await chat(page, async editor => {
    await editor.locator('#draft-commentPanel').selectOption('light');
    await editor.locator('#draft-commentTextColorMode').selectOption('theme');
  });
  // A light panel's readable default also beats the theme's important color.
  assert.deepEqual([(await read(page)).panel, (await read(page)).bodyColor], ['rgba(255, 255, 255, 0.9)', 'rgb(31, 42, 36)']);
  await chat(page, editor => editor.locator('#draft-commentAuthorColorMode').selectOption('theme'));
  assert.equal((await read(page)).authorColor, 'rgb(59, 110, 88)');
  assert.equal(await page.locator('.stage-chat .stage-panel-label h2').evaluate(element => getComputedStyle(element).color), 'rgb(31, 42, 36)');
  // A color chosen on a light panel still wins over its readable default.
  await chat(page, async editor => {
    await editor.locator('#draft-commentTextColorMode').selectOption('custom');
    await editor.locator('#draft-commentTextColor').fill('#aa0000');
    await editor.locator('#draft-commentTextColor').dispatchEvent('change');
  });
  assert.equal((await read(page)).bodyColor, 'rgb(170, 0, 0)');
  assert.equal(await page.locator('.stage-chat .stage-panel-label h2').evaluate(element => getComputedStyle(element).color), 'rgb(170, 0, 0)');

  await waitForDesign(url, design => design.studio.commentTextColor === '#aa0000');
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  assert.deepEqual(await read(output), await read(page));

  await page.bringToFront();
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('theme'));
  assert.deepEqual(await read(page), themed);
  assert.deepEqual(errors, []);
});

browserTest('a hidden label collapses identically in the preview and the output over a theme !important', async t => {
  const { context, page, errors, url } = await fixture(t);
  await saveDesign(url, { theme: '.pokome-workspace .stage-panel-label { display: flex !important; } .pokome-workspace #stage-chat-list { padding-top: 0 !important; }' });
  await page.reload(); await appReady(page);
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('outline'));
  const geometry = target => target.evaluate(() => {
    const chat = document.querySelector('.stage-chat'), list = document.querySelector('#stage-chat-list');
    return { label: getComputedStyle(chat.querySelector('.stage-panel-label')).display, paddingTop: getComputedStyle(list).paddingTop, listOffset: list.getBoundingClientRect().top - chat.getBoundingClientRect().top };
  });
  const [output] = await Promise.all([context.waitForEvent('page'), page.locator('#open-output-window').click()]);
  output.setDefaultTimeout(8000);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  await page.bringToFront();
  await page.locator('#open-design-preview').click();
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('#talk-stage .stage-comment').first().waitFor({ state: 'attached' });
  // Evaluate inside the preview document, like the output page.
  const preview = await geometry({ evaluate: read => frame.locator('html').evaluate(read) }), streamed = await geometry(output);
  assert.deepEqual(preview, { label: 'none', paddingTop: '20px', listOffset: preview.listOffset });
  assert.deepEqual(streamed, preview);
  await page.locator('#cancel-design').click();
  assert.deepEqual(errors, []);
});

browserTest('a chroma key output warns about a half-transparent comment panel', async t => {
  const { page, errors, url } = await fixture(t);
  const status = page.locator('#output-status');
  await page.locator('#output-background').selectOption('key');
  const opacity = value => chat(page, async editor => { await editor.locator('#draft-commentPanelOpacity').fill(value); await editor.locator('#draft-commentPanelOpacity').dispatchEvent('change'); });
  await chat(page, editor => editor.locator('#draft-commentPreset').selectOption('dark'));
  await status.filter({ hasText: 'にじみます' }).waitFor();
  await opacity('100');
  await status.filter({ hasNotText: 'にじみます' }).waitFor();
  await opacity('50');
  await status.filter({ hasText: 'にじみます' }).waitFor();
  await page.locator('#output-background').selectOption('theme');
  await status.filter({ hasNotText: 'にじみます' }).waitFor();
  assert.deepEqual(errors, []);
});
