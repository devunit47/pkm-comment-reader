import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { chromium, executablePath, browserAvailable, appReady, blockExternalFonts, readSettings, saveSetting, waitForSettings, saveDesign, waitForDesign } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, { raw, ports = 1 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-settings-sync-'));
  const dataDirectory = join(folder, 'data');
  if (raw !== undefined) {
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, 'settings.json'), raw);
  }
  const servers = Array.from({ length: ports }, () => createServer({ dataDirectory, customizationDirectory: join(folder, 'customization') }));
  let browser;
  t.after(async () => {
    await browser?.close();
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    await rm(folder, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, executablePath });
  const bases = [];
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    bases.push(`http://127.0.0.1:${server.address().port}`);
  }
  const errors = [];
  async function open(base, initialStorage = {}, prepare) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(values => {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
      window.settingsStorageReads = [];
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) { if (this === localStorage) window.settingsStorageReads.push(key); return read.call(this, key); };
      window.testSockets = [];
      window.WebSocket = class {
        constructor(url) { this.url = url; window.testSockets.push(this); }
        send() {}
        close() { this.closed = true; }
      };
      Object.defineProperty(window, 'speechSynthesis', { value: {
        getVoices: () => [{ name: '確認用の声', voiceURI: 'qa-voice', lang: 'ja-JP' }, { name: '別の声', voiceURI: 'qa-other', lang: 'ja-JP' }],
        addEventListener() {},
        cancel() { window.settingsSpeechCancels = (window.settingsSpeechCancels || 0) + 1; },
        speak(utterance) { utterance.onstart?.(); },
      } });
    }, initialStorage);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await blockExternalFonts(page);
    await page.route('**/api/speech/voicevox/voices', route => route.fulfill({ json: { voices: [
      { id: '3', speakerName: '確認用音声', styleName: '標準' }, { id: '4', speakerName: '確認用音声', styleName: '別の声' },
    ] } }));
    page.on('pageerror', error => errors.push(error.message));
    await prepare?.(page);
    await page.goto(base); await appReady(page);
    return page;
  }
  return { bases, dataDirectory, open, errors };
}
const settingValue = (page, selector, value) => page.waitForFunction(([selector, value]) => document.querySelector(selector)?.value === value, [selector, value]);

browserTest('two server ports share every operating setting, apply user changes live and retain concurrent fields', async t => {
  const { bases, dataDirectory, open, errors } = await fixture(t, { ports: 2 });
  const initial = {
    connections: { twitch: 'saved_channel', kick: 'saved-kick' }, autoSpeech: { twitch: false, kick: true },
    voices: { twitch: 'qa-voice', kick: 'qa-other' }, historyLimit: 40, setupComplete: false,
    users: { twitch: { '同期ユーザー': { hidden: false, muted: false } }, kick: {} },
    speechOptions: { twitch: { maxLength: 140, skipCommands: true }, kick: { maxLength: 220 } },
    output: { background: 'key', key: '0000ff' },
  };
  for (const [field, value] of Object.entries(initial)) await saveSetting(bases[0], field, value);
  const pages = await Promise.all(bases.map(base => open(base)));
  for (const page of pages) {
    assert.equal(await page.locator('#twitch-channel').inputValue(), 'saved_channel');
    assert.equal(await page.locator('#kick-channel').inputValue(), 'saved-kick');
    assert.equal(await page.locator('#voice').inputValue(), 'qa-voice');
    assert.equal(await page.locator('#auto-speech').isChecked(), false);
    assert.equal(await page.locator('#max-length').inputValue(), '140');
    assert.equal(await page.locator('#skip-commands').isChecked(), true);
    assert.equal(await page.locator('#studio-list-count').inputValue(), '40');
    assert.equal(await page.locator('#setup-welcome').isVisible(), true);
    assert.equal(await page.locator('#output-background').inputValue(), 'key');
    assert.equal(await page.locator('#output-key').inputValue(), '0000ff');
    await page.locator('[data-platform="kick"]').click();
    assert.equal(await page.locator('#voice').inputValue(), 'qa-other');
    assert.equal(await page.locator('#auto-speech').isChecked(), true);
    assert.equal(await page.locator('#max-length').inputValue(), '220');
    assert.equal(await page.locator('#speech-engine').inputValue(), 'browser');
    await page.locator('[data-platform="twitch"]').click();
    await page.locator('#twitch-connection-toggle').click();
    await page.evaluate(() => window.testSockets[0].onmessage({ data: ':server 366 user #saved_channel :End of names' }));
    await page.evaluate(() => window.testSockets[0].onmessage({ data: '@display-name=同期ユーザー :viewer!viewer@host PRIVMSG #saved_channel :同期確認' }));
    await page.evaluate(() => window.testSockets[0].onmessage({ data: '@display-name=__proto__ :proto!proto@host PRIVMSG #saved_channel :特殊名の確認' }));
    await page.locator('#comment-list .username').filter({ hasText: '同期ユーザー' }).waitFor();
  }
  await pages[0].locator('[data-page="users"]').click();
  await pages[1].locator('[data-page="users"]').click();
  const row = pages[0].locator('#user-list .user-row').filter({ hasText: '同期ユーザー' });
  await row.getByRole('button', { name: '読み上げ除外', exact: true }).click();
  await pages[1].locator('#user-list .user-row').filter({ hasText: '同期ユーザー' }).getByRole('button', { name: '読み上げ除外を解除', exact: true }).waitFor();
  await row.getByRole('button', { name: '非表示', exact: true }).click();
  await pages[1].locator('#user-list .user-row').filter({ hasText: '同期ユーザー' }).getByRole('button', { name: '非表示を解除', exact: true }).waitFor();
  for (const page of pages) assert.equal(await page.locator('#comment-list .username').filter({ hasText: '同期ユーザー' }).count(), 0);
  const special = pages[0].locator('#user-list .user-row').filter({ hasText: '__proto__' });
  await special.getByRole('button', { name: '読み上げ除外', exact: true }).click();
  await pages[1].locator('#user-list .user-row').filter({ hasText: '__proto__' }).getByRole('button', { name: '読み上げ除外を解除', exact: true }).waitFor();
  await special.getByRole('button', { name: '非表示', exact: true }).click();
  await pages[1].locator('#user-list .user-row').filter({ hasText: '__proto__' }).getByRole('button', { name: '非表示を解除', exact: true }).waitFor();
  const protectedSettings = await waitForSettings(bases[0], settings => Object.hasOwn(settings.users.twitch, '__proto__') && settings.users.twitch['__proto__'].hidden && settings.users.twitch['__proto__'].muted);
  assert.deepEqual(protectedSettings.users.twitch['__proto__'], { hidden: true, muted: true });
  for (const page of pages) {
    assert.equal(await page.locator('#comment-list .username').filter({ hasText: '__proto__' }).count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ hidden: Object.prototype.hidden, muted: Object.prototype.muted })), { hidden: undefined, muted: undefined });
  }
  await saveSetting(bases[1], 'connections', { twitch: 'next_channel', kick: 'next-kick' });
  for (const page of pages) {
    await settingValue(page, '#twitch-channel', 'next_channel');
    assert.equal(await page.locator('#twitch-tab-channel').textContent(), '#saved_channel');
    assert.equal(await page.locator('#twitch-tab-status').textContent(), '接続済み');
    assert.deepEqual(await page.evaluate(() => window.testSockets.map(socket => !!socket.closed)), [false]);
  }
  await pages[0].locator('[data-page="home"]').click();
  await pages[0].locator('#start-setup').click(); await pages[0].locator('#complete-setup').click();
  await pages[1].waitForFunction(() => document.querySelector('#setup-welcome').hidden);
  await pages[0].locator('[data-page="settings"]').click();
  await pages[0].locator('#studio-list-count').fill('7'); await pages[0].locator('#studio-list-count').dispatchEvent('change');
  await settingValue(pages[1], '#studio-list-count', '7');
  await pages[0].locator('[data-page="home"]').click();
  await pages[1].locator('#user-list .user-row').filter({ hasText: '同期ユーザー' }).getByRole('button', { name: '非表示を解除', exact: true }).waitFor();
  await Promise.all([
    pages[0].locator('#auto-speech').check(),
    pages[1].locator('#user-list .user-row').filter({ hasText: '同期ユーザー' }).getByRole('button', { name: '非表示を解除', exact: true }).click(),
  ]);
  const saved = await waitForSettings(bases[0], settings => settings.autoSpeech.twitch && !settings.users.twitch['同期ユーザー']?.hidden && settings.users.twitch['同期ユーザー']?.muted);
  assert.equal(saved.connections.twitch, 'next_channel');
  await pages[1].waitForFunction(() => document.querySelector('#auto-speech').checked);
  await saveSetting(bases[0], 'speechOptions', { twitch: { maxLength: 180, skipCommands: false }, kick: { maxLength: 220 } });
  await saveSetting(bases[0], 'voices', { twitch: 'qa-other', kick: 'qa-voice' });
  for (const page of pages) { await settingValue(page, '#max-length', '180'); await settingValue(page, '#voice', 'qa-other'); }
  await saveSetting(bases[0], 'speechEngines', { twitch: { engine: 'voicevox', voicevox: '4' }, kick: { engine: 'browser' } });
  for (const page of pages) { await settingValue(page, '#speech-engine', 'voicevox'); await settingValue(page, '#voice', '4'); }
  await pages[0].locator('[data-page="studio"]').click();
  await pages[0].locator('#output-key').selectOption('ff00ff');
  await settingValue(pages[1], '#output-key', 'ff00ff');
  await waitForSettings(bases[0], settings => settings.output.key === 'ff00ff');
  await pages[0].locator('#output-background').selectOption('theme');
  await settingValue(pages[1], '#output-background', 'theme');
  assert.equal(await pages[1].locator('#output-key').isDisabled(), true);
  await pages[0].locator('#output-background').selectOption('key');
  await settingValue(pages[1], '#output-background', 'key');
  await waitForSettings(bases[0], settings => settings.output.background === 'key');
  for (const page of pages) { await page.reload(); await appReady(page); await settingValue(page, '#voice', '4'); }
  for (const page of pages) {
    assert.equal(await page.locator('#twitch-channel').inputValue(), 'next_channel');
    assert.equal(await page.locator('#studio-list-count').inputValue(), '7');
    assert.equal(await page.locator('#setup-welcome').isVisible(), false);
    assert.equal(await page.locator('#output-key').inputValue(), 'ff00ff');
  }
  const document = JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8'));
  assert.equal(document.format, 'pokome-settings'); assert.equal(document.version, 2);
  assert.deepEqual(await readSettings(bases[0]), await readSettings(bases[1]));
  assert.deepEqual(errors, []);
});

browserTest('startup ignores legacy localStorage settings and leaves their values untouched', async t => {
  const { bases, open, errors } = await fixture(t);
  const legacy = {
    'pokome-connections': { twitch: 'obsolete_channel', kick: 'obsolete-kick' }, 'pokome-auto-speech': { twitch: false, kick: false },
    'pokome-voices': { twitch: 'obsolete-voice', kick: '' }, 'pokome-speech-engines': { twitch: { engine: 'voicevox', voicevox: '4' } },
    'pokome-speech-options': { twitch: { maxLength: 500 } }, 'pokome-users-v2': { twitch: { obsolete: { hidden: true } } },
    'pokome-users': { obsolete_old: { muted: true } }, 'pokome-history-limit': 1, 'pokome-setup-complete': true,
    'pokome-output-v1': { background: 'key', key: 'ff00ff' },
  };
  const defaults = await readSettings(bases[0]);
  const page = await open(bases[0], legacy);
  assert.equal(await page.locator('#twitch-channel').inputValue(), '');
  assert.equal(await page.locator('#speech-engine').inputValue(), 'browser');
  assert.equal(await page.locator('#studio-list-count').inputValue(), String(defaults.historyLimit));
  assert.equal(await page.locator('#setup-welcome').isVisible(), true);
  assert.equal(await page.locator('#output-background').inputValue(), 'theme');
  assert.deepEqual(await readSettings(bases[0]), defaults);
  assert.deepEqual(await page.evaluate(() => window.settingsStorageReads), [], 'the app does not read the obsolete browser storage');
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), value);
  assert.deepEqual(errors, []);
});

browserTest('startup applies settings received by SSE while the initial design is still loading', async t => {
  const { bases, open, errors } = await fixture(t);
  let page, release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { entered = resolve; });
  const opening = open(bases[0], {}, async target => {
    page = target;
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) {
          super(url, options);
          if (url === '/api/settings/events') this.addEventListener('open', () => { window.settingsEventsOpen = true; });
        }
      };
    });
    await page.route('**/api/design/current', async route => {
      const response = await route.fetch();
      entered(); await gate;
      await route.fulfill({ response });
    });
  });
  try {
    await Promise.race([held, opening]);
    await page.waitForFunction(() => window.settingsEventsOpen);
    const reread = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/settings' &&
      (await response.json()).settings.historyLimit === 7);
    await saveSetting(bases[0], 'connections', { twitch: 'boot_channel', kick: '' });
    await saveSetting(bases[0], 'historyLimit', 7);
    await (await reread).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally { release(); }
  await opening;
  assert.equal(await page.locator('#twitch-channel').inputValue(), 'boot_channel');
  assert.equal(await page.locator('#studio-list-count').inputValue(), '7');
  assert.deepEqual(errors, []);
});

browserTest('a failed save of the first local voice restores the saved selection without repeated writes', async t => {
  const { bases, open, errors } = await fixture(t);
  const page = await open(bases[0]);
  let writes = 0;
  await page.route('**/api/settings/speechEngines', route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    return writes === 1 ? route.continue() : route.fulfill({ status: 503, json: { error: '確認用の保存失敗' } });
  });
  await page.locator('#speech-engine').selectOption('voicevox');
  await page.locator('#notice').filter({ hasText: '保存' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#voice').value === '');
  await page.waitForTimeout(600);
  assert.equal(writes, 2, 'the failed automatic selection never restarts its own save');
  const settings = await readSettings(bases[0]);
  assert.equal(settings.speechEngines.twitch.engine, 'voicevox');
  assert.equal(settings.speechEngines.twitch.voicevox, '');
  assert.equal(await page.locator('#speech-engine').inputValue(), 'voicevox');
  assert.deepEqual(errors, []);
});

browserTest('other service settings and enabling auto speech preserve the active manual reading', async t => {
  const { bases, open, errors } = await fixture(t);
  await saveSetting(bases[0], 'autoSpeech', { twitch: false, kick: false });
  const page = await open(bases[0]);
  await page.locator('#test-voice').click();
  await page.locator('#speech-status').filter({ hasText: '読み上げ中' }).waitFor();
  const played = async () => page.evaluate(() => ({ cancels: window.settingsSpeechCancels || 0,
    text: document.querySelector('#preview-text').textContent, credit: document.querySelector('#preview-speech-credit').textContent,
    status: document.querySelector('#speech-status').textContent }));
  const before = await played();
  for (const [field, change] of [
    ['autoSpeech', true], ['voices', 'qa-other'], ['speechEngines', { engine: 'voicevox', voicevox: '4' }],
    ['speechOptions', { maxLength: 220 }], ['users', { '別サービスのユーザー': { hidden: true, muted: true } }],
  ]) {
    const current = await readSettings(bases[0]);
    const kick = change && typeof change === 'object' ? { ...current[field].kick, ...change } : change;
    const value = { ...current[field], kick };
    const reread = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/settings' &&
      JSON.stringify((await response.json()).settings[field].kick) === JSON.stringify(kick));
    await saveSetting(bases[0], field, value); await (await reread).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await played(), before, `${field} for Kick leaves the Twitch reading alone`);
  }
  await page.locator('#auto-speech').check();
  await waitForSettings(bases[0], settings => settings.autoSpeech.twitch);
  assert.deepEqual(await played(), before, 'enabling Twitch auto speech preserves its current manual reading');
  assert.deepEqual(errors, []);
});

browserTest('unreadable settings stay protected and persistent guidance and changed panels fit every supported dock width', async t => {
  const raw = '{broken settings';
  const { bases, dataDirectory, open, errors } = await fixture(t, { raw });
  const page = await open(bases[0]);
  await page.locator('#settings-warning').filter({ hasText: '設定ファイルを読めません' }).waitFor();
  assert.equal(await page.locator('#settings-warning').isVisible(), true);
  if (!await page.locator('#auto-speech').isDisabled()) {
    await page.setViewportSize({ width: 150, height: 1000 });
    await page.locator('#auto-speech').click();
    await page.locator('#notice').filter({ hasText: '保存' }).waitFor();
    const notice = await page.locator('#notice').boundingBox();
    assert.ok(notice.x >= -1 && notice.x + notice.width <= 151, 'save failure guidance stays inside a 150px dock');
    const noticeOverflow = await page.locator('#notice').evaluate(element => element.scrollWidth > element.clientWidth);
    assert.equal(noticeOverflow, false, 'save failure text wraps inside a 150px dock');
  }
  assert.equal(await readFile(join(dataDirectory, 'settings.json'), 'utf8'), raw);
  const backup = { format: 'pokome-settings', version: 1, settings: {
    'pokome-connections': JSON.stringify({ twitch: 'backup_channel', kick: '' }),
    'pokome-auto-speech': JSON.stringify({ twitch: false, kick: false }),
    'pokome-voices': JSON.stringify({ twitch: '', kick: '' }),
    'pokome-speech-engines': JSON.stringify({ twitch: { engine: 'browser' }, kick: { engine: 'browser' } }),
    'pokome-speech-options': JSON.stringify({ twitch: { maxLength: 100 }, kick: {} }),
    'pokome-users-v2': JSON.stringify({ twitch: {}, kick: {} }), 'pokome-history-limit': '40',
  } };
  await page.locator('[data-page="settings"]').click();
  await page.locator('#restore-settings').setInputFiles({ name: 'old-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator('#backup-status').filter({ hasText: '見た目はcustomizationフォルダーのまま' }).waitFor();
  for (const colorScheme of ['light', 'dark']) {
    const palette = colorScheme === 'light'
      ? { background: '#f2f5f2', panel: '#ffffff', text: '#25382f', muted: '#54645a', line: '#b6c5bd', computedBackground: 'rgb(242, 245, 242)', computedMuted: 'rgb(84, 100, 90)', computedPanel: 'rgb(255, 255, 255)', computedText: 'rgb(37, 56, 47)' }
      : { background: '#101718', panel: '#1a2325', text: '#e4eeea', muted: '#a9bbb1', line: '#2c3739', computedBackground: 'rgb(16, 23, 24)', computedMuted: 'rgb(169, 187, 177)', computedPanel: 'rgb(26, 35, 37)', computedText: 'rgb(228, 238, 234)' };
    const css = `.pokome-workspace { --bg: ${palette.background}; --panel: ${palette.panel}; --text: ${palette.text}; --muted: ${palette.muted}; --line: ${palette.line}; background: var(--bg); color: var(--text); } .pokome-workspace button, .pokome-workspace input, .pokome-workspace select { background: var(--panel); color: var(--text); border-color: var(--line); }`;
    await saveDesign(bases[0], design => ({ ...design, theme: css }));
    await waitForDesign(bases[0], design => design.theme === css);
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('main')).backgroundColor === expected, palette.computedBackground);
    assert.equal(await page.locator('#settings-warning').evaluate(element => getComputedStyle(element).color), palette.computedMuted);
    assert.deepEqual(await page.locator('#twitch-channel').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color })),
      { background: palette.computedPanel, color: palette.computedText });
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 500, 300, 150]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const view of ['home', 'users', 'settings', 'studio']) {
        await page.locator(`[data-page="${view}"]`).click();
        assert.equal(await page.locator('#settings-warning').isVisible(), true);
        const issues = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const roots = ['#settings-warning', '#notice', '#setup-welcome', '.reading', '#users-page', '#settings-page', '#settings-backup-panel', '#stream-output-panel'];
          return roots.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(root => {
            if (!root.getClientRects().length) return [];
            const nodes = [root, ...root.querySelectorAll('p,label,h2,button,input,select')];
            const visible = nodes.filter(node => { const box = node.getBoundingClientRect(); return node.checkVisibility() && box.width && box.height; });
            const outside = visible.filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > width + 1; }).map(node => node.id || node.tagName);
            const controls = visible.filter(node => node.matches('button,input,select'));
            const overlap = [];
            for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
              const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
              if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlap.push([controls[i].id, controls[j].id]);
            }
            const overflow = root.scrollWidth > root.clientWidth + 1;
            return outside.length || overlap.length || overflow ? [{ selector, outside, overlap, overflow }] : [];
          }));
        });
        assert.deepEqual(issues, [], `${width}px ${colorScheme} ${view}`);
        if (process.env.SETTINGS_QA_DIRECTORY) {
          await mkdir(process.env.SETTINGS_QA_DIRECTORY, { recursive: true });
          await page.screenshot({ path: join(process.env.SETTINGS_QA_DIRECTORY, `${width}-${colorScheme}-${view}.png`), fullPage: true });
        }
      }
    }
  }
  assert.equal(await readFile(join(dataDirectory, 'settings.json'), 'utf8'), raw);
  assert.deepEqual(errors, []);
});
