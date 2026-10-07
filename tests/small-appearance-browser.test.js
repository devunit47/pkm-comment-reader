import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, saveDesign, saveStudio, waitForDesign, appReady, editorTarget, closeEditor, applyInEditor, temporaryDataDirectory } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-small-look-'));
  const server = createServer({ dataDirectory: await temporaryDataDirectory(t), customizationDirectory: directory });
  t.after(async () => {
    await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blockExternalFonts(context);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(url); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  return { context, page, url, errors };
}
async function change(page, selector, value) {
  await page.locator(selector).fill(value);
  await page.locator(selector).dispatchEvent('change');
}
// Applies settings of one editor target.
const edit = (page, target, steps) => applyInEditor(page, async editor => { await editorTarget(editor, target); await steps(editor); });
const look = target => target.evaluate(() => {
  const stage = document.querySelector('#talk-stage'), card = stage.querySelector('.stage-comment');
  const css = element => getComputedStyle(element);
  return {
    font: css(stage.querySelector('#stage-chat-list')).fontSize,
    background: css(card).backgroundColor, radius: css(card).borderRadius,
    padding: css(card).padding, margin: css(card).marginBottom,
    text: css(card.querySelector('p')).color, lines: css(card.querySelector('p')).webkitLineClamp,
    actorBackground: css(stage.querySelector('.stage-actor')).backgroundImage,
    actorBorder: css(stage.querySelector('.stage-actor')).borderTopWidth,
    caption: css(stage.querySelector('#actor-caption')).display,
  };
});

browserTest('small appearance controls persist, mirror to output and preview, and chips keep the font', async t => {
  const { context, page, url, errors } = await fixture(t);
  await applyInEditor(page, async editor => {
    await editorTarget(editor, 'chat'); await change(editor, '#draft-fontSize', '56');
    await editor.locator('#draft-commentPreset').selectOption('chips');
    await editorTarget(editor, 'actor'); await editor.locator('#draft-actorAppearance').selectOption('none');
  });
  await waitForDesign(url, design => design.studio.fontSize === 56 && design.studio.actorAppearance === 'none' && design.studio.commentMaxLines === 2);
  const live = await look(page);
  assert.deepEqual([live.font, live.background, live.radius, live.padding, live.margin, live.lines], ['56px', 'rgba(255, 255, 255, 0.92)', '44px', '12px 24px', '14px', '2']);
  assert.equal(live.text, 'rgb(31, 42, 36)');
  assert.deepEqual([live.actorBackground, live.actorBorder, live.caption], ['none', '0px', 'none']);
  const output = await context.newPage();
  await output.goto(`${url}/output.html?background=transparent`);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  assert.deepEqual(await look(output), live);
  await page.locator('#open-design-preview').click();
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('.stage-comment').first().waitFor({ state: 'attached' });
  assert.deepEqual(await look(page.frames().find(value => value !== page.mainFrame())), live);
  await editorTarget(page, 'chat');
  await page.locator('#draft-commentMaxLines').selectOption('3');
  await editorTarget(page, 'actor');
  await page.locator('#draft-actorAppearance').selectOption('theme');
  assert.equal(await frame.locator('p.pokome-comment__body').first().evaluate(element => getComputedStyle(element).webkitLineClamp), '3');
  await closeEditor(page);
  assert.deepEqual(await look(page), live);
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  assert.deepEqual(await look(page), live);
  await edit(page, 'chat', editor => change(editor, '#draft-fontSize', '64'));
  assert.equal(await page.locator('#stage-font-plus').count(), 0);
  assert.equal(await page.locator('#draft-speechFontSize option[value="32"]').count(), 1);
  await edit(page, 'chat', async editor => {
    await editor.locator('#draft-commentPreset').selectOption('theme');
    assert.equal(await editor.locator('#draft-fontSize').inputValue(), '64');
    assert.equal(await editor.locator('#draft-commentMaxLines').inputValue(), '');
    for (const [entry, expected] of [['', '64'], ['80', '64'], ['10', '16'], ['56', '56']]) {
      await change(editor, '#draft-fontSize', entry);
      assert.equal(await editor.locator('#draft-fontSize').inputValue(), expected);
    }
  });
  await page.locator('#open-design-preview').click();
  await editorTarget(page, 'chat');
  await page.locator('#draft-commentItemBackground').selectOption('dark');
  await page.locator('#draft-commentItemOpacity').fill('40');
  await page.locator('#draft-commentMaxLines').selectOption('3');
  await page.locator('#apply-design').click();
  await waitForDesign(url, design => design.studio.commentItemBackground === 'dark' && design.studio.commentItemOpacity === 40 && design.studio.commentMaxLines === 3);
  await page.locator('#design-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual([(await look(page)).background, (await look(page)).lines], ['rgba(0, 0, 0, 0.4)', '3']);
  assert.deepEqual(errors, []);
});

browserTest('chips preset follows item background colors after application', async t => {
  const { context, page, url, errors } = await fixture(t);
  await edit(page, 'chat', async editor => {
    await editor.locator('#draft-commentPreset').selectOption('chips');
    await editor.locator('#draft-commentItemBackground').selectOption('dark');
    assert.equal(await editor.locator('#draft-commentTextColorMode').inputValue(), 'theme');
  });
  await waitForDesign(url, design => design.studio.commentItemBackground === 'dark' && design.studio.commentTextColor === '');
  const dark = await look(page);
  assert.equal(dark.text, 'rgb(255, 255, 255)');
  assert.deepEqual(await page.locator('#talk-stage').evaluate(element => [element.hasAttribute('data-comment-text'), element.style.getPropertyValue('--stage-comment-text')]), [false, '']);
  const output = await context.newPage();
  await output.goto(`${url}/output.html?background=transparent`);
  await output.locator('.stage-comment').first().waitFor({ state: 'attached' });
  assert.deepEqual(await look(output), dark);
  await page.bringToFront();
  await edit(page, 'chat', editor => editor.locator('#draft-commentItemBackground').selectOption('light'));
  const light = await look(page);
  assert.equal(light.text, 'rgb(31, 42, 36)');
  const geometry = appearance => [appearance.font, appearance.radius, appearance.padding, appearance.margin, appearance.lines];
  assert.deepEqual(geometry(light), geometry(dark));
  assert.deepEqual(errors, []);
});

browserTest('explicit actor and chip settings beat important themes and theme values remove their attributes', async t => {
  const { page, url, errors } = await fixture(t);
  await saveDesign(url, { theme: [
    '.pokome-workspace .stage-actor { background: linear-gradient(red, blue) !important; border: 7px solid red !important; border-radius: 19px !important; box-shadow: 0 2px 4px red !important; }',
    '.pokome-workspace .actor-caption { display: block !important; }',
    '.pokome-workspace .stage-actor::before { display: block !important; }',
    '.pokome-workspace .stage-comment { background: rgb(1, 2, 3) !important; border-radius: 3px !important; padding: 1px !important; margin-bottom: 99px !important; }',
    '.pokome-workspace .pokome-comment__body { color: rgb(4, 5, 6) !important; }',
    '.pokome-workspace { --stage-comment-item-opacity: .01 !important; }',
  ].join('\n') });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  const original = await look(page);
  await applyInEditor(page, async editor => {
    await editorTarget(editor, 'actor'); await editor.locator('#draft-actorAppearance').selectOption('none');
    await editorTarget(editor, 'chat');
    await editor.locator('#draft-commentItemBackground').selectOption('light');
    await editor.locator('#draft-commentGap').selectOption('14');
  });
  let current = await look(page);
  assert.deepEqual([current.background, current.radius, current.padding, current.margin, current.text], ['rgba(255, 255, 255, 0.92)', '44px', '12px 24px', '14px', 'rgb(31, 42, 36)']);
  assert.deepEqual(await page.locator('.stage-actor').evaluate(element => [getComputedStyle(element).boxShadow, getComputedStyle(element, '::before').display]), ['none', 'none']);
  await edit(page, 'chat', editor => editor.locator('#draft-commentItemBackground').selectOption('dark'));
  current = await look(page);
  assert.deepEqual([current.background, current.text], ['rgba(0, 0, 0, 0.92)', 'rgb(255, 255, 255)']);
  await edit(page, 'chat', async editor => {
    await editor.locator('#draft-commentPanel').selectOption('light');
    for (const [entry, expected] of [['', '92'], ['120', '100'], ['-1', '0'], ['92', '92']]) {
      await change(editor, '#draft-commentItemOpacity', entry);
      assert.equal(await editor.locator('#draft-commentItemOpacity').inputValue(), expected);
    }
  });
  assert.equal((await look(page)).text, 'rgb(255, 255, 255)');
  for (const theme of ['mint', 'rose', 'violet', 'paper']) {
    await applyInEditor(page, async editor => {
      await editorTarget(editor, 'screen'); await editor.locator('#draft-theme').selectOption(theme);
      await editorTarget(editor, 'chat'); await editor.locator('#draft-commentItemBackground').selectOption('dark');
    });
    assert.equal((await look(page)).text, 'rgb(255, 255, 255)');
    await edit(page, 'chat', editor => editor.locator('#draft-commentItemBackground').selectOption('light'));
    assert.equal((await look(page)).text, 'rgb(31, 42, 36)');
  }
  await applyInEditor(page, async editor => {
    await editorTarget(editor, 'screen'); await editor.locator('#draft-theme').selectOption('mint');
    await editorTarget(editor, 'chat');
    await editor.locator('#draft-commentTextColorMode').selectOption('custom');
    await change(editor, '#draft-commentTextColor', '#ff8800');
  });
  assert.equal((await look(page)).text, 'rgb(255, 136, 0)');
  await edit(page, 'chat', async editor => {
    await editor.locator('#draft-commentItemBackground').selectOption('none');
    assert.equal(await editor.locator('#draft-commentItemOpacity').isDisabled(), true);
  });
  assert.equal((await look(page)).background, 'rgba(0, 0, 0, 0)');
  await applyInEditor(page, async editor => {
    await editorTarget(editor, 'chat'); await editor.locator('#draft-commentPreset').selectOption('theme');
    await editorTarget(editor, 'actor'); await editor.locator('#draft-actorAppearance').selectOption('theme');
  });
  assert.deepEqual(await look(page), original);
  assert.deepEqual(await page.locator('#talk-stage').evaluate(element => [element.hasAttribute('data-actor-appearance'), element.hasAttribute('data-comment-item-background'), element.style.getPropertyValue('--stage-comment-item-opacity')]), [false, false, '']);
  assert.deepEqual(errors, []);
});

browserTest('body line limits override compact and important themes without truncating text or hiding clamped cards', async t => {
  const { page, url, errors } = await fixture(t);
  await saveDesign(url, { theme: '.pokome-workspace .pokome-comment__body { display: block !important; white-space: nowrap !important; overflow: visible !important; -webkit-line-clamp: 5 !important; }' });
  await saveStudio(url, { fontSize: 20, commentStyle: 'compact', commentItemBackground: 'light', commentGap: 14, commentLineHeight: 1.35, commentLabel: false });
  await page.reload(); await appReady(page);
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#enter-talk').click();
  const message = { id: 'long', user: '長い名前'.repeat(20), text: ('長い日本語の本文 https://example.com/abc 👨‍👩‍👧‍👦\n').repeat(30) };
  await page.evaluate(async message => {
    const { renderStageComments } = await import('./src/browser/stage-appearance.js');
    const list = document.querySelector('#stage-chat-list');
    list.parentElement.style.cssText = 'height:300px;flex:none';
    renderStageComments(list, [message]); list.scrollTop = 0;
  }, message);
  await page.evaluate(async () => {
    const { normalizeStudio } = await import('./src/shared/studio.js');
    const { renderStageAppearance, markClippedComments } = await import('./src/browser/stage-appearance.js');
    window.smallLook = { normalizeStudio, renderStageAppearance, markClippedComments };
  });
  const render = lines => page.evaluate(lines => {
    const { normalizeStudio, renderStageAppearance, markClippedComments } = window.smallLook;
    const stage = document.querySelector('#talk-stage'), list = stage.querySelector('#stage-chat-list');
    renderStageAppearance(stage, normalizeStudio({ fontSize: 20, commentStyle: 'compact', commentItemBackground: 'light', commentGap: 14, commentLineHeight: 1.35, commentLabel: false, commentMaxLines: lines }));
    list.scrollTop = 0; markClippedComments(list);
    const card = list.firstElementChild, body = card.querySelector('p'), css = getComputedStyle(body);
    return { text: body.textContent, title: card.title, clamp: css.webkitLineClamp, whiteSpace: css.whiteSpace, height: body.getBoundingClientRect().height, clipped: card.classList.contains('stage-comment-clipped'), lines: stage.hasAttribute('data-comment-max-lines'), variable: stage.style.getPropertyValue('--stage-comment-max-lines') };
  }, lines);
  const clamped = await render(2);
  assert.deepEqual([clamped.text, clamped.title, clamped.clamp, clamped.whiteSpace, clamped.clipped], [message.text, `${message.user}: ${message.text}`, '2', 'normal', false]);
  assert.equal(clamped.height, 54);
  const unlimited = await render(0);
  assert.equal(unlimited.clamp, 'none');
  assert.ok(unlimited.height > clamped.height);
  assert.equal(unlimited.text, message.text);
  const themed = await render(null);
  assert.deepEqual([themed.clamp, themed.whiteSpace, themed.lines, themed.variable], ['5', 'nowrap', false, '']);
  await render(2);
  const edges = await page.evaluate(async message => {
    const { renderStageComments, markClippedComments } = await import('./src/browser/stage-appearance.js');
    const list = document.querySelector('#stage-chat-list');
    renderStageComments(list, [message, message, message]);
    list.scrollTop = 0; markClippedComments(list);
    const before = [...list.children].map(card => card.classList.contains('stage-comment-clipped'));
    list.scrollTop = list.scrollHeight; markClippedComments(list);
    return { before, after: [...list.children].map(card => card.classList.contains('stage-comment-clipped')) };
  }, message);
  assert.deepEqual(edges, { before: [false, false, true], after: [true, false, false] });
  assert.deepEqual(errors, []);
});

browserTest('comment font size keeps legacy theme overrides while 56px works without CSS', async t => {
  const { page, url } = await fixture(t);
  await saveStudio(url, { fontSize: 56 });
  await page.reload(); await appReady(page);
  assert.equal((await look(page)).font, '56px');
  await saveDesign(url, { theme: '.pokome-workspace #stage-chat-list { font-size: 60px; }' });
  await page.reload(); await appReady(page);
  assert.equal((await look(page)).font, '60px');
  await edit(page, 'chat', editor => change(editor, '#draft-fontSize', '64'));
  assert.equal((await look(page)).font, '60px');
});
