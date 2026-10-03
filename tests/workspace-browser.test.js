import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

import { chromium, executablePath, browserAvailable, waitForDesign } from './browser-support.js';

// Each server gets its own customization folder, never the repository's.
const folders = [];
after(() => Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }))));
const scratch = async () => { const folder = await mkdtemp(join(tmpdir(), 'pokome-workspace-')); folders.push(folder); return folder; };

test('workspace edits, persistence, protected recovery and design roundtrip', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const style of ['panel', 'bubble', 'image']) {
      await page.locator('#studio-speech-style').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event('change')); }, style);
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
    await page.locator('#stage-title').hover();
    await page.locator('#talk-stage').focus();
    assert.equal(await page.locator('#stage-comment-settings').evaluate(element => getComputedStyle(element).opacity), '0');
    await page.locator('.stage-chat .stage-panel-label').hover();
    assert.equal(await page.locator('#stage-comment-settings').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await page.locator('.stage-font-controls').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await page.locator('#stage-comment-style').isVisible(), false);
    await page.getByRole('button', { name: 'コメントの表示設定', exact: true }).click();
    await page.locator('#stage-comment-style').selectOption('anonymous');
    assert.equal(await page.locator('#stage-speech-user').evaluate(element => getComputedStyle(element).display), 'none');
    assert.equal(await page.locator('.stage-comment strong').first().evaluate(element => getComputedStyle(element).display), 'none');
    await page.locator('#stage-comment-style').selectOption('inline');
    assert.notEqual(await page.locator('#stage-speech-user').evaluate(element => getComputedStyle(element).display), 'none');
    assert.equal(await page.locator('.stage-comment').first().evaluate(element => getComputedStyle(element).display), 'flex');
    await page.locator('#stage-comment-style').selectOption('compact');
    assert.equal(await page.locator('.stage-comment p').first().evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
    assert.equal((await waitForDesign(`http://127.0.0.1:${server.address().port}`, design => design.studio.commentStyle === 'compact')).studio.commentStyle, 'compact');
    assert.equal(await page.locator('.stage-comment').count(), initialCount);
    await page.locator('#stage-comment-style').selectOption('stacked');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#stage-comment-settings-dialog').isVisible(), false);
    assert.equal(await page.locator('#talk-stage').isVisible(), true);
    const initialSize = await page.locator('.stage-comment p').first().evaluate(element => getComputedStyle(element).fontSize);
    const subtitleBefore = await page.locator('#stage-subtitle').boundingBox();
    await page.locator('#stage-font-plus').click();
    assert.equal(await page.locator('.stage-comment p').first().evaluate(element => getComputedStyle(element).fontSize), `${parseFloat(initialSize) + 2}px`);
    assert.equal(await page.locator('.stage-comment').count(), initialCount);
    assert.deepEqual(await page.locator('#stage-subtitle').boundingBox(), subtitleBefore);
    await page.locator('#stage-font-minus').click();
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
    for (const [id, label, key] of [['stage-title', '配信タイトル', 'title'], ['stage-subtitle', 'ひとこと', 'subtitle'], ['stage-footer-text', '画面下の文章', 'footer'], ['stage-speech-title', '読み上げ枠の見出し', 'speechTitle']]) {
      await page.locator(`#${id}`).hover();
      const alignment = await page.locator(`#${id}`).evaluate(element => {
        const text = element.getBoundingClientRect(), pencil = element.parentElement.querySelector('.stage-edit-pencil').getBoundingClientRect();
        return Math.abs((text.top + text.bottom) / 2 - (pencil.top + pencil.bottom) / 2);
      });
      assert.ok(alignment < 2, `${label}: pencil center differs by ${alignment}px`);
      await page.getByRole('button', { name: `${label}を編集`, exact: true }).click();
      assert.equal(await page.locator('.stage-text-dialog[open]').evaluate(dialog => dialog.matches(':modal')), true);
      await page.getByRole('textbox', { name: label, exact: true }).fill(`<新しい${label}>`);
      await page.locator('.stage-text-editor').getByRole('button', { name: '保存', exact: true }).click();
      assert.equal(await page.locator(`#${id}`).textContent(), `<新しい${label}>`);
      assert.equal((await waitForDesign(`http://127.0.0.1:${server.address().port}`, design => design.studio[key] === `<新しい${label}>`)).studio[key], `<新しい${label}>`);
    }
    await page.locator('#stage-title').hover();
    await page.getByRole('button', { name: '配信タイトルを編集', exact: true }).click();
    await page.getByRole('textbox', { name: '配信タイトル', exact: true }).fill('保存しない');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#talk-stage').isVisible(), true);
    assert.equal(await page.locator('#stage-title').textContent(), '<新しい配信タイトル>');
    await page.keyboard.press('Escape');
    await page.reload();
    assert.equal(await page.locator('#stage-title').textContent(), '<新しい配信タイトル>');
    await page.locator('[data-page="studio"]').click();
    await page.locator('#studio-list-count').fill('3');
    await page.locator('#studio-list-count').dispatchEvent('change');
    await page.locator('[data-page="home"]').click();
    await page.locator('#enter-talk').click();
    assert.equal(await page.locator('.stage-comment').count(), 3);
    await page.keyboard.press('Escape');
    await page.locator('[data-page="home"]').click();
    const editor = page.locator('#workspace-editor');
    const session = page.locator('#layout-session');
    assert.equal(await editor.isVisible(), false);
    assert.equal(await session.isVisible(), false);
    await page.locator('[data-page="studio"]').click();
    await editor.locator('#edit').click();
    assert.equal(await session.isVisible(), true);
    await session.locator('#finish').click();
    await editor.locator('.fields summary').click();
    assert.equal(await editor.locator('#x').getAttribute('aria-describedby'), 'x-help');
    await editor.locator('#x').fill('10');
    await editor.locator('#x').dispatchEvent('change');
    await editor.locator('#w').fill('45');
    await editor.locator('#w').dispatchEvent('change');
    await editor.locator('#edit').click();
    const move = page.getByRole('button', { name: 'コメント一覧 を移動', exact: true });
    const before = await move.boundingBox();
    await page.mouse.move(before.x + 12, before.y + 10);
    await page.mouse.down();
    await page.mouse.move(before.x + 65, before.y + 30, { steps: 4 });
    await page.mouse.up();
    const resize = page.getByRole('button', { name: 'コメント一覧 のサイズ変更', exact: true });
    const handle = await resize.boundingBox();
    await page.mouse.move(handle.x + 8, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 38, handle.y + 28, { steps: 4 });
    await page.mouse.up();
    const home = await page.evaluate(() => JSON.parse(localStorage.getItem('pokome-workspace-v1')).home);
    assert.ok(home.panels.comments.x > 10);
    assert.ok(home.panels.comments.w > 45);
    await page.reload();
    assert.equal(await session.isVisible(), false);
    assert.equal(await page.locator('.comments').evaluate(element => element.style.left), `${home.panels.comments.x}%`);
    await page.locator('[data-page="studio"]').click();
    await editor.locator('#mode').selectOption('talk');
    await editor.locator('#edit').click();
    await session.locator('#finish').click();
    await editor.locator('.fields summary').click();
    await editor.locator('#hidden').check();
    await page.locator('[data-page="home"]').click();
    await page.locator('#enter-talk').click();
    await page.locator('.stage-header').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.locator('[data-page="studio"]').click();
    await editor.locator('#edit').click();
    await session.locator('#finish').click();
    await page.locator('#talk-stage').waitFor({ state: 'hidden' });
    await page.locator('[data-page="studio"]').click();
    await page.locator('#theme-css').locator('xpath=ancestor::details').locator('summary').click();
    await page.locator('#theme-css').fill('.pokome-workspace .pokome-panel { border-radius: 3px; }');
    await page.locator('#theme-apply').click();
    assert.match(await page.locator('#pokome-user-theme').textContent(), /border-radius: 3px/);
    await page.locator('#theme-import').setInputFiles({ name: 'theme.css', mimeType: 'text/css', buffer: Buffer.from('.pokome-workspace { color: rgb(1, 2, 3); }') });
    await page.waitForFunction(() => document.querySelector('#pokome-user-theme').textContent.includes('rgb(1, 2, 3)'));
    // The talk layout and theme are saved to the folder; the home layout stays in this browser.
    const base = `http://127.0.0.1:${server.address().port}`;
    const saved = await waitForDesign(base, design => design.theme.includes('rgb(1, 2, 3)') && design.ratios['16:9']?.layout?.panels.header.hidden === true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pokome-workspace-v1'))), { version: 1, home, talk: null });
    assert.equal(await page.locator('#design-export').count(), 0, 'the old design file export is gone');
    assert.equal(await page.locator('#theme-import').getAttribute('accept'), '.css,text/css');
    await page.reload();
    assert.match(await page.locator('#pokome-user-theme').textContent(), /rgb\(1, 2, 3\)/);
    assert.equal(await page.locator('.stage-header').evaluate(element => element.style.display), 'none');
    assert.equal(await page.locator('.comments').evaluate(element => element.style.left), `${home.panels.comments.x}%`);
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
    await page.goto('http://127.0.0.1:' + server.address().port);
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
    const freshPage = await browser.newPage();
    await freshPage.goto('http://127.0.0.1:' + server.address().port);
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
    const page = await browser.newPage(); const errors = [];
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
    await page.goto('http://127.0.0.1:' + server.address().port);
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
    await page.reload(); await page.waitForFunction(() => !document.querySelector('#voice').disabled);
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


test('fixed home side panels keep all controls reachable by scrolling', { skip: !browserAvailable }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const server = createServer({ customizationDirectory: await scratch() }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      localStorage.setItem('pokome-workspace-v1', JSON.stringify({ version: 1, talk: null, home: { panels: {
        comments: { x: 0, y: 0, w: 65, h: 100, z: 1 },
        now: { x: 67, y: 0, w: 33, h: 20, z: 1 },
        reading: { x: 67, y: 22, w: 33, h: 60, z: 1 },
        moderation: { x: 67, y: 84, w: 33, h: 14, z: 1 },
      } } }));
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
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
    for (const selector of ['.reading']) {
      const measurements = await page.locator(selector).evaluate(panel => ({ overflow: getComputedStyle(panel).overflowY, height: panel.clientHeight, content: panel.scrollHeight }));
      assert.equal(measurements.overflow, 'auto'); assert.ok(measurements.content > measurements.height);
    }
    const preview = await page.locator('.now').boundingBox();
    const settings = await page.locator('.reading').boundingBox();
    assert.ok(preview.height > 280);
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
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    assert.equal(await page.locator('#setup-welcome').isVisible(), true);
    await page.locator('#start-setup').click(); await page.locator('#setup-connect').click();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    await page.locator('#open-setup').click(); await page.locator('#setup-voice').click();
    assert.equal(await page.locator('#home-page').isVisible(), true);
    await page.locator('#open-setup').click(); await page.locator('#complete-setup').click();
    assert.equal(await page.locator('#setup-welcome').isVisible(), false);
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.locator('[data-page="studio"]').click(); await page.locator('#studio-list-count').fill('42'); await page.locator('#studio-list-count').dispatchEvent('change');
    await page.locator('[data-page="settings"]').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-settings').click();
    const download = await downloadPromise;
    const { readFile } = await import('node:fs/promises'); const backup = await readFile(await download.path());
    // Backups hold operating settings only: no appearance, no images.
    assert.doesNotMatch(backup.toString(), /pokome-studio|pokome-theme|pokome-overlays|data:image/);
    await page.locator('[data-page="studio"]').click(); await page.locator('#studio-list-count').fill('10'); await page.locator('#studio-list-count').dispatchEvent('change');
    await page.locator('#studio-theme').selectOption('rose');
    await waitForDesign(base, design => design.studio.theme === 'rose');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#restore-settings').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    assert.equal(await page.locator('#confirm-restore').isDisabled(), true);
    await page.locator('#restore-settings').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: backup });
    assert.equal(await page.locator('#confirm-restore').isDisabled(), false);
    await Promise.all([page.waitForEvent('load'), page.locator('#confirm-restore').click()]);
    await page.locator('[data-page="studio"]').click();
    assert.equal(await page.locator('#studio-list-count').inputValue(), '42');
    assert.equal(await page.locator('#studio-theme').inputValue(), 'rose', 'restoring settings leaves the folder design alone');
    // A backup from the browser-only edition imports its appearance and images into the folder.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const legacy = JSON.parse(backup.toString());
    Object.assign(legacy.settings, {
      'pokome-studio': JSON.stringify({ theme: 'violet', title: '旧版のタイトル', image: png, source: 'image', listCount: 7 }),
      'pokome-theme-v1': '.pokome-workspace { color: rgb(9, 8, 7); }',
      'pokome-overlays-v1': JSON.stringify({ version: 1, items: [{ id: 'item-1', type: 'image', assetId: 'asset-1' }], assets: { 'asset-1': png } }),
    });
    delete legacy.settings['pokome-history-limit'];
    await page.locator('[data-page="settings"]').click();
    await page.locator('#restore-settings').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
    assert.match(await page.locator('#backup-status').textContent(), /取り込みます/);
    await Promise.all([page.waitForEvent('load'), page.locator('#confirm-restore').click()]);
    const imported = await waitForDesign(base, design => design.studio.theme === 'violet');
    assert.equal(imported.studio.title, '旧版のタイトル');
    assert.match(imported.studio.image, /^images\/[0-9a-f]{64}\.png$/);
    assert.equal(imported.ratios['16:9'].overlays.assets['asset-1'], imported.studio.image, 'the same image is stored once');
    assert.equal(imported.theme, '.pokome-workspace { color: rgb(9, 8, 7); }');
    await page.locator('[data-page="studio"]').click();
    assert.equal(await page.locator('#studio-list-count').inputValue(), '7');
    assert.equal(await page.locator('#actor-image').evaluate(image => image.complete && image.naturalWidth), 1);
    assert.equal(await page.evaluate(() => ['pokome-studio', 'pokome-theme-v1', 'pokome-overlays-v1'].map(key => localStorage.getItem(key))).then(values => values.every(value => value === null)), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
