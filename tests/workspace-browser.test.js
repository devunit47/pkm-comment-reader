import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

import { chromium, executablePath, browserAvailable, waitForDesign, appReady, blockExternalFonts, saveStudio, readDesign, applyInEditor, editorThemeCSS, editorTarget } from './browser-support.js';

// Each server gets its own customization folder, never the repository's.
const folders = [];
after(() => Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }))));
const scratch = async () => { const folder = await mkdtemp(join(tmpdir(), 'pokome-workspace-')); folders.push(folder); return folder; };

test('workspace edits, persistence, protected recovery and design roundtrip', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await appReady(page);
    for (const style of ['panel', 'bubble', 'image']) {
      await saveStudio(`http://127.0.0.1:${server.address().port}`, { speechStyle: style });
      await page.waitForFunction(style => document.querySelector('.speech-bubble').dataset.style === style, style);
      const appearance = await page.evaluate(style => {
        const preview = getComputedStyle(document.querySelector('.speech-bubble'));
        const stage = getComputedStyle(document.querySelector(style === 'image' ? '.stage-speech-content' : '.stage-speech'));
        return [style === 'image' ? preview.backgroundImage : preview.backgroundColor, style === 'image' ? stage.backgroundImage : stage.backgroundColor];
      }, style);
      assert.equal(appearance[0], appearance[1]);
    }
    for (const id of ['studio-title', 'studio-subtitle', 'studio-footer', 'studio-speech-title']) assert.equal(await page.locator(`#${id}`).count(), 0);
    await page.locator('#enter-talk').click();
    await page.locator('#stage-connection').click();
    assert.equal(await page.locator('#talk-stage').isVisible(), true);
    assert.equal(await page.locator('#stage-connection-dialog').isVisible(), true);
    assert.equal(await page.locator('#twitch-channel').evaluate(element => element === document.activeElement), true);
    await page.locator('#close-stage-connection').click();
    const titleBox = await page.locator('#stage-title').boundingBox();
    const subtitleBox = await page.locator('#stage-subtitle').boundingBox();
    assert.ok(subtitleBox.y >= titleBox.y + titleBox.height, 'subtitle stays below the title');
    const exitBox = await page.locator('#leave-talk').boundingBox();
    assert.ok(Math.abs(titleBox.y - exitBox.y) < 2, 'title and exit button have aligned top edges');
    const hintBox = await page.locator('.stage-exit-hint').boundingBox();
    assert.ok(hintBox.y >= exitBox.y + exitBox.height, 'Escape hint is below the exit button');
    const statusBox = await page.locator('#stage-connection').boundingBox();
    const switchBox = await page.locator('.stage-switch').boundingBox();
    assert.ok(Math.abs(statusBox.y + statusBox.height / 2 - switchBox.y - switchBox.height / 2) < 2, 'connection status and service switches share a row');
    const wavePosition = await page.locator('.stage-wave').boundingBox();
    assert.equal(await page.locator('#stage-volume').isVisible(), false);
    await page.getByRole('button', { name: '読み上げの音量設定', exact: true }).click();
    await page.locator('#stage-volume').fill('0.4');
    await page.locator('#stage-volume').dispatchEvent('input');
    assert.equal(await page.locator('#stage-volume-value').textContent(), '40%');
    assert.equal(await page.locator('#volume').inputValue(), '0.4');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#stage-volume-dialog').isVisible(), false);
    await page.locator('#stage-title').hover();
    await page.locator('#stage-volume-settings').hover();
    assert.equal(await page.locator('#stage-volume-dialog').isVisible(), true);
    assert.equal(await page.locator('#stage-volume').evaluate(element => getComputedStyle(element).writingMode), 'vertical-lr');
    await page.locator('#stage-volume').hover();
    assert.equal(await page.locator('#stage-volume-dialog').isVisible(), true);
    await page.locator('#stage-title').hover();
    await page.locator('#stage-volume-dialog').waitFor({ state: 'hidden' });
    await page.locator('#stage-volume-settings').hover();
    await page.locator('#stage-title').click();
    assert.equal(await page.locator('#stage-volume-dialog').isVisible(), false);
    assert.equal(await page.locator('#talk-stage').isVisible(), true);
    await page.locator('#stage-speech-status').evaluate(element => { element.textContent = '読み上げ中'; });
    assert.deepEqual(await page.locator('.stage-wave').boundingBox(), wavePosition);
    await page.locator('#stage-speech-status').evaluate(element => { element.textContent = '待機中'; });
    const initialCount = await page.locator('.stage-comment').count();
    const canvas = page.locator('#design-preview-editor');
    async function editTalk(steps) {
      await page.locator('#stage-design-edit').click(); await canvas.locator('#apply-design:not(:disabled)').waitFor();
      await steps(canvas); await canvas.locator('#apply-design').click(); await canvas.locator('#design-dialog').waitFor({ state: 'hidden' });
    }
    assert.equal(await page.locator('#stage-font-plus,#stage-comment-settings,.stage-edit-pencil').count(), 0);
    for (const style of ['anonymous', 'inline', 'compact', 'stacked']) {
      await editTalk(async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-commentStyle').selectOption(style); });
      assert.equal((await readDesign(new URL(page.url()).origin)).studio.commentStyle, style);
      if (style === 'anonymous') {
        assert.equal(await page.locator('#stage-speech-user').evaluate(element => getComputedStyle(element).display), 'none');
        assert.equal(await page.locator('.stage-comment strong').first().evaluate(element => getComputedStyle(element).display), 'none');
      }
      if (style === 'inline') assert.equal(await page.locator('.stage-comment').first().evaluate(element => getComputedStyle(element).display), 'flex');
      if (style === 'compact') assert.equal(await page.locator('.stage-comment p').first().evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
      assert.equal(await page.locator('.stage-comment').count(), initialCount);
    }
    const initialSize = await page.locator('.stage-comment p').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await editTalk(async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-fontSize').fill(String(initialSize + 2)); });
    assert.equal(await page.locator('.stage-comment p').first().evaluate(element => getComputedStyle(element).fontSize), (initialSize + 2) + 'px');
    await editTalk(async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-fontSize').fill(String(initialSize)); });
    await page.locator('#stage-chat-list').evaluate(list => {
      list.style.flex = 'none';
      list.style.height = `${list.firstElementChild.getBoundingClientRect().height + 20}px`;
      list.scrollTop = 10;
      list.dispatchEvent(new Event('scroll'));
    });
    assert.equal(await page.locator('.stage-comment').first().evaluate(element => getComputedStyle(element).visibility), 'hidden');
    await page.locator('#stage-chat-list').evaluate(list => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
    assert.equal(await page.locator('.stage-comment').first().evaluate(element => getComputedStyle(element).visibility), 'visible');
    await page.locator('#stage-chat-list').evaluate(list => { list.style.removeProperty('flex'); list.style.removeProperty('height'); });
    for (const [id, target, key] of [['stage-title', 'header', 'title'], ['stage-subtitle', 'header', 'subtitle'], ['stage-footer-text', 'footer', 'footer'], ['stage-speech-title', 'speech', 'speechTitle']]) {
      await editTalk(async editor => { await editorTarget(editor, target); await editor.locator('#draft-' + key).fill('<新しい' + key + '>'); });
      assert.equal(await page.locator('#' + id).textContent(), '<新しい' + key + '>');
      assert.equal((await readDesign(new URL(page.url()).origin)).studio[key], '<新しい' + key + '>');
    }
    await page.locator('#stage-design-edit').click(); await canvas.locator('#apply-design:not(:disabled)').waitFor();
    await page.keyboard.press('Escape'); await canvas.locator('#design-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#talk-stage').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.reload(); await appReady(page);
    assert.equal(await page.locator('#stage-title').textContent(), '<新しいtitle>');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#studio-list-count').fill('3');
    await page.locator('#studio-list-count').dispatchEvent('change');
    await page.locator('[data-page="home"]').click();
    await page.locator('#enter-talk').click();
    assert.equal(await page.locator('.stage-comment').count(), 3);
    await page.keyboard.press('Escape');
    await page.locator('[data-page="home"]').click();
    assert.equal(await page.locator('#workspace-editor,#layout-session,[data-layout-handle]').count(), 0);
    await page.locator('[data-page="studio"]').click();
    await applyInEditor(page, async canvas => { await editorTarget(canvas, 'header'); await canvas.locator('#panel-hidden').check(); });
    await page.locator('[data-page="home"]').click(); await page.locator('#enter-talk').click();
    await page.locator('.stage-header').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.locator('[data-page="studio"]').click();
    await applyInEditor(page, async editor => { await editorThemeCSS(editor); await editor.locator('#draft-css').fill('.pokome-workspace .pokome-panel { border-radius: 3px; }'); });
    assert.match(await page.locator('#pokome-user-theme').textContent(), /border-radius: 3px/);
    await applyInEditor(page, async editor => {
      await editorThemeCSS(editor);
      assert.equal(await editor.locator('#draft-css-file').getAttribute('accept'), '.css,text/css');
      await editor.locator('#draft-css-file').setInputFiles({ name: 'theme.css', mimeType: 'text/css', buffer: Buffer.from('.pokome-workspace { color: rgb(1, 2, 3); }') });
      await page.waitForFunction(() => document.querySelector('#design-preview-editor').shadowRoot.getElementById('draft-css').value.includes('rgb(1, 2, 3)'));
    });
    await page.waitForFunction(() => document.querySelector('#pokome-user-theme').textContent.includes('rgb(1, 2, 3)'));
    // Talk layout and theme roundtrip through the folder; home stays responsive.
    const base = `http://127.0.0.1:${server.address().port}`;
    const saved = await waitForDesign(base, design => design.theme.includes('rgb(1, 2, 3)') && design.ratios['16:9']?.layout?.panels.header.hidden === true);
    assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), null);
    assert.equal(await page.locator('#design-export').count(), 0, 'the old design file export is gone');
    await page.reload(); await appReady(page);
    assert.match(await page.locator('#pokome-user-theme').textContent(), /rgb\(1, 2, 3\)/);
    assert.equal(await page.locator('.stage-header').evaluate(element => element.style.display), 'none');
    assert.equal(await page.locator('.comments').evaluate(element => element.style.left), '');
    assert.deepEqual((await waitForDesign(base, () => true)).ratios['16:9'].layout, saved.ratios['16:9'].layout);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('platform buttons toggle saved connections independently and open settings when unsaved', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('pokome-connections', JSON.stringify({ twitch: 'saved_channel', kick: 'saved-kick' }));
      window.testSockets = [];
      window.WebSocket = class {
        constructor(url) { this.url = url; window.testSockets.push(this); }
        send() {}
        close() { this.closed = true; }
      };
    });
    await page.route('**/api/kick/channel/*', route => route.fulfill({ json: { chatroomId: 123 } }));
    await page.goto('http://127.0.0.1:' + server.address().port); await appReady(page);
    await page.locator('#twitch-channel').evaluate(input => { input.value = 'unsaved_edit'; });
    await page.getByRole('button', { name: 'Twitchに接続', exact: true }).click();
    assert.equal(await page.locator('#twitch-tab-channel').textContent(), '#saved_channel');
    assert.equal(await page.locator('#twitch-connection-toggle').textContent(), '切断');
    assert.equal(await page.locator('#kick-connection-toggle').textContent(), '接続');
    await page.getByRole('button', { name: 'Twitchを切断', exact: true }).click();
    assert.equal(await page.locator('#twitch-connection-toggle').textContent(), '接続');
    assert.equal(await page.evaluate(() => window.testSockets[0].closed), true);
    await page.getByRole('button', { name: 'Twitchに接続', exact: true }).click();
    await page.evaluate(() => window.testSockets[1].onmessage({ data: ':server 366 user #saved_channel :End of names' }));
    assert.equal(await page.locator('#twitch-tab-status').textContent(), '接続済み');
    await page.getByRole('button', { name: 'Kickに接続', exact: true }).click();
    await page.waitForFunction(() => window.testSockets.length === 3);
    assert.equal(await page.locator('#kick-tab-channel').textContent(), '#saved-kick');
    await page.getByRole('button', { name: 'Kickを切断', exact: true }).click();
    assert.equal(await page.locator('#twitch-tab-status').textContent(), '接続済み');
    await page.evaluate(() => window.testSockets[1].onerror());
    assert.equal(await page.locator('#twitch-connection-toggle').textContent(), '接続');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pokome-connections')).twitch), 'saved_channel');
    await page.evaluate(() => localStorage.removeItem('pokome-connections'));
    // Use a fresh page without the saved-connection initialization script.
    const freshPage = await browser.newPage(); await blockExternalFonts(freshPage);
    await freshPage.goto('http://127.0.0.1:' + server.address().port); await appReady(freshPage);
    await freshPage.getByRole('button', { name: 'Twitchに接続', exact: true }).click();
    assert.equal(await freshPage.locator('#settings-page').isVisible(), true);
    assert.equal(await freshPage.locator('#twitch-channel').evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('local engines select voices, play synchronized previews, stop and persist per platform', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const uuid = '3c37646f-3881-5374-2a83-149267990abc';
  const server = createServer({ customizationDirectory: await scratch(), fetchImpl: async url => {
    if (url.endsWith('/speakers') && url.includes(':50021')) return Response.json([{ name: 'ボイステスト', styles: [{ id: 3, name: 'ノーマル' }] }]);
    if (url.endsWith('/v1/speakers')) return Response.json([{ speakerName: '声色テスト', speakerUuid: uuid, styles: [{ styleId: 0, styleName: 'れいせい' }] }]);
    if (url.includes('/audio_query?')) return Response.json({ accent_phrases: [] });
    return new Response(Buffer.from('RIFF0000WAVEdata'));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage(); await blockExternalFonts(page); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.testAudio = [];
      window.Audio = class {
        constructor() { window.testAudio.push(this); }
        play() { this.onplaying(); return Promise.resolve(); }
        pause() { this.paused = true; }
        removeAttribute() {}
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port); await appReady(page);
    await page.locator('#speech-engine').selectOption('voicevox');
    await page.waitForFunction(() => !document.querySelector('#voice').disabled);
    assert.equal(await page.locator('#voice').inputValue(), '3');
    await page.locator('#test-voice').click();
    await page.waitForFunction(() => document.querySelector('#speech-status').textContent === '読み上げ中');
    assert.equal(await page.locator('#stage-speech-text').textContent(), 'こんにちは。読み上げ音声のテストです。');
    await page.locator('#stop-speech').click();
    assert.equal(await page.locator('#speech-status').textContent(), '待機中');
    assert.equal(await page.evaluate(() => window.testAudio[0].paused), true);
    await page.locator('[data-platform="kick"]').click();
    assert.equal(await page.locator('#speech-engine').inputValue(), 'browser');
    await page.locator('#speech-engine').selectOption('coeiroink');
    await page.waitForFunction(() => !document.querySelector('#voice').disabled);
    assert.equal(await page.locator('#voice').inputValue(), uuid + ':0');
    await page.locator('#test-voice').click();
    await page.waitForFunction(() => document.querySelector('#speech-status').textContent === '読み上げ中');
    await page.locator('[data-platform="twitch"]').click();
    assert.equal(await page.locator('#speech-engine').inputValue(), 'voicevox');
    assert.equal(await page.locator('#speech-status').textContent(), '待機中');
    await page.reload(); await appReady(page); await page.waitForFunction(() => !document.querySelector('#voice').disabled);
    assert.equal(await page.locator('#speech-engine').inputValue(), 'voicevox');
    assert.equal(await page.locator('#voice').inputValue(), '3');
    await page.route('**/api/speech/voicevox/voices', route => route.fulfill({ status: 502, json: { error: '音声ソフトを起動してください。' } }));
    await page.locator('#refresh-voices').click();
    await page.waitForFunction(() => document.querySelector('#engine-status').textContent.includes('起動してください'));
    assert.equal(await page.locator('#voice').isDisabled(), true);
    await page.locator('#speech-engine').selectOption('browser');
    assert.equal(await page.locator('#voice').isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});


test('standard home keeps operating controls reachable despite obsolete saved layout', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await blockExternalFonts(page);
    await page.addInitScript(() => {
      localStorage.setItem('pokome-workspace-v1', JSON.stringify({ version: 1, talk: null, home: { panels: {
        comments: { x: 0, y: 0, w: 65, h: 100, z: 1 },
        now: { x: 67, y: 0, w: 33, h: 20, z: 1 },
        reading: { x: 67, y: 22, w: 33, h: 60, z: 1 },
        moderation: { x: 67, y: 84, w: 33, h: 14, z: 1 },
      } } }));
    });
    await page.goto('http://127.0.0.1:' + server.address().port); await appReady(page);
    assert.equal(await page.locator('.moderation').count(), 0);
    const total = await page.locator('#comment-list .comment').count();
    await page.locator('#comment-list .message').first().click();
    assert.equal(await page.locator('#user-actions').isVisible(), true);
    await page.locator('#hide-comment').click();
    assert.equal(await page.locator('#comment-list .comment').count(), total - 1);
    const author = page.locator('#comment-list .username').first();
    const username = await author.textContent();
    await author.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#user-actions').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#user-actions').isVisible(), false);
    await author.click(); await page.locator('#mute-user').click();
    const rules = await page.evaluate(() => JSON.parse(localStorage.getItem('pokome-users-v2')));
    assert.equal(Object.values(rules.twitch).some(rule => rule.muted), true);
    assert.equal(Object.values(rules.kick).some(rule => rule.muted), false);
    await author.click(); await page.locator('#hide-user').click();
    assert.equal(await page.locator('#comment-list .username').filter({ hasText: username.slice(1) }).count(), 0);
    await page.locator('[data-page="users"]').click();
    await page.locator('#user-list .user-row').filter({ hasText: username.slice(1) }).getByRole('button', { name: '非表示を解除', exact: true }).click();
    await page.locator('[data-page="home"]').click();
    const preview = await page.locator('.now').boundingBox();
    const settings = await page.locator('.reading').boundingBox();
    assert.ok(preview.y + preview.height <= settings.y);
    await page.locator('#stop-speech').scrollIntoViewIfNeeded();
    const button = await page.locator('#stop-speech').boundingBox(); const panel = await page.locator('.reading').boundingBox();
    assert.ok(button.y >= panel.y && button.y + button.height <= panel.y + panel.height);
    await page.locator('#stop-speech').click();
    await page.locator('[data-page="updates"]').click();
    assert.equal(await page.locator('.platform-tabs').isVisible(), false);
    assert.equal(await page.locator('main>header #enter-talk').count(), 0);
    assert.equal(await page.locator('#page-title').textContent(), '更新情報');
    await page.locator('[data-page="home"]').click();
    assert.equal(await page.locator('.platform-tabs').isVisible(), true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('first setup guide and full settings backup restore work through the UI', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage(); await blockExternalFonts(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port); await appReady(page);
    assert.equal(await page.locator('#setup-welcome').isVisible(), true);
    await page.locator('#start-setup').click(); await page.locator('#setup-connect').click();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    await page.locator('#open-setup').click(); await page.locator('#setup-voice').click();
    assert.equal(await page.locator('#home-page').isVisible(), true);
    await page.locator('#open-setup').click(); await page.locator('#complete-setup').click();
    assert.equal(await page.locator('#setup-welcome').isVisible(), false);
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.locator('[data-page="settings"]').click(); await page.locator('#studio-list-count').fill('42'); await page.locator('#studio-list-count').dispatchEvent('change');
    await page.locator('[data-page="settings"]').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-settings').click();
    const download = await downloadPromise;
    const { readFile } = await import('node:fs/promises'); const backup = await readFile(await download.path());
    // Backups hold operating settings only: no appearance, images or home layout.
    assert.doesNotMatch(backup.toString(), /pokome-studio|pokome-theme|pokome-overlays|pokome-workspace|data:image/);
    await page.locator('[data-page="settings"]').click(); await page.locator('#studio-list-count').fill('10'); await page.locator('#studio-list-count').dispatchEvent('change');
    await applyInEditor(page, editor => editor.locator('#draft-theme').selectOption('rose'));
    await waitForDesign(base, design => design.studio.theme === 'rose');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#restore-settings').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    // The file is read asynchronously, so wait for the status before checking the button.
    await page.locator('#backup-status').filter({ hasText: '読み込めませんでした' }).waitFor();
    assert.equal(await page.locator('#confirm-restore').isDisabled(), true);
    await page.locator('#restore-settings').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: backup });
    await page.locator('#backup-status').filter({ hasText: '見た目はcustomizationフォルダーのまま' }).waitFor();
    assert.equal(await page.locator('#confirm-restore').isDisabled(), false);
    await Promise.all([page.waitForEvent('load'), page.locator('#confirm-restore').click()]); await appReady(page);
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.locator('#studio-list-count').inputValue(), '42');
    assert.equal((await readDesign(base)).studio.theme, 'rose', 'restoring settings leaves the folder design alone');
    // A browser-only backup restores operating settings and ignores its obsolete appearance.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const legacy = JSON.parse(backup.toString());
    Object.assign(legacy.settings, {
      'pokome-studio': JSON.stringify({ theme: 'violet', title: '旧版のタイトル', image: png, source: 'image', listCount: 7 }),
      'pokome-theme-v1': '.pokome-workspace { invalid: ',
      'pokome-workspace-v1': 'malformed obsolete layout',
      'pokome-overlays-v1': JSON.stringify({ version: 1, items: [{ id: 'item-1', type: 'image', assetId: 'asset-1' }], assets: { 'asset-1': png } }),
    });
    delete legacy.settings['pokome-history-limit'];
    await page.locator('[data-page="settings"]').click();
    await page.locator('#restore-settings').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
    await page.locator('#backup-status').filter({ hasText: '古い見た目・画像・配置は復元しません' }).waitFor();
    assert.equal(await page.locator('#confirm-restore').isDisabled(), false);
    await Promise.all([page.waitForEvent('load'), page.locator('#confirm-restore').click()]); await appReady(page);
    assert.equal((await readDesign(base)).studio.theme, 'rose');
    assert.equal((await readDesign(base)).theme, '');
    assert.equal((await readDesign(base)).studio.image, '');
    assert.equal((await readDesign(base)).ratios['16:9'], null);
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.locator('#studio-list-count').inputValue(), '7');
    assert.equal(await page.locator('#actor-image').getAttribute('src'), null);
    assert.equal(await page.evaluate(() => ['pokome-studio', 'pokome-theme-v1', 'pokome-overlays-v1'].map(key => localStorage.getItem(key))).then(values => values.every(value => value === null)), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

// Regression: after a reload in talk mode, leaving talk mode went back to the
// stale talk history entry and immediately re-entered talk mode.
test('leaving talk mode after a reload in talk mode returns to the operating screen', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage(); await blockExternalFonts(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port); await appReady(page);
    await page.locator('#enter-talk').click();
    await page.reload(); await appReady(page);
    await page.locator('#enter-talk').click();
    await page.locator('#leave-talk').click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.classList.contains('talk-mode')), false);
    await page.locator('[data-page="studio"]').click();
    assert.equal(await page.locator('#studio-page').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});


test('home ignores obsolete layout without clearing the saved value', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage(); await blockExternalFonts(page);
    await page.goto(`http://127.0.0.1:${server.address().port}`); await appReady(page);
    const legacy = JSON.stringify({ version: 1, home: { panels: { comments: { hidden: true, x: 50, y: 50, w: 5, h: 5 } } } });
    await page.evaluate(value => localStorage.setItem('pokome-workspace-v1', value), legacy);
    await page.reload(); await appReady(page);
    assert.equal(await page.locator('#workspace-editor,#layout-session,[data-layout-handle]').count(), 0);
    assert.equal(await page.locator('.workspace').evaluate(element => element.hasAttribute('data-fixed-layout')), false);
    assert.equal(await page.locator('.comments').isVisible(), true);
    assert.equal(await page.locator('.comments').evaluate(element => element.style.left), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('pokome-workspace-v1')), legacy);

  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
