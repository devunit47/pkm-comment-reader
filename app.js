import { normalizeWorkspace } from './workspace-model.js';
import { exportSettings, parseSettings, restoreSettings } from './settings-backup.js';
import { compileTheme } from './theme.js';
import { readSpeechEngines, LocalSpeechPlayer } from './speech-engine.js';
import { createChatState, addMessage, userRule, visibleMessages, clearMessages } from './chat-state.js';
import { ChatConnection, readSavedConnections, validChannel, connectionPresentation } from './connections.js';
import { normalizeSpeechOptions, prepareSpeechText, shouldAutoRead, rememberAutoRead, createSpeechHistory, isSpeechUserExcluded, readSavedAutoSpeech } from './speech-options.js';
import { readStudio, normalizeStudio, readSavedVoices, THEME_ACCENTS } from './studio.js';
import { enabledPlatforms, publication } from './app-config.js';
import { initializeWorkspace } from './workspace.js';
import { initializeTheme } from './theme.js';

const $ = id => document.getElementById(id);
const names = { twitch: 'Twitch', kick: 'Kick' };
const states = { twitch: createChatState(), kick: createChatState() };
let active = 'twitch';
document.querySelectorAll('[data-service]').forEach(element => {
  element.hidden = !enabledPlatforms.includes(element.dataset.service);
});
document.querySelectorAll('[data-local-only]').forEach(element => { element.hidden = publication === 'pages'; });
if (!enabledPlatforms.includes('kick')) {
  $('platform-help').textContent = 'Twitch専用の公開版';
  $('edition-label').textContent = 'ぽこめ Reader / Twitch版';
}
let session = 0;
let storage;
try { storage = window.localStorage; } catch { /* Storage may be disabled by the browser. */ }
const savedConnections = readSavedConnections(storage);
const savedAutoSpeech = readSavedAutoSpeech(storage);
for (const platform of Object.keys(states)) states[platform].autoSpeech = savedAutoSpeech[platform];
const enginePreferences = readSpeechEngines(storage, publication !== 'pages');
const engineVoices = { voicevox: null, coeiroink: null };
let voiceLoadGeneration = 0;
const localSpeech = new LocalSpeechPlayer({ onError: message => { $('engine-status').textContent = message + ' 音声ソフトを起動して「声を再取得」を押し、音声テストを試してください。'; notify(message); stop(); } });
const savedVoices = readSavedVoices(storage);
for (const platform of Object.keys(states)) states[platform].voice = savedVoices[platform];
let studio = readStudio(storage);
for (const state of Object.values(states)) state.historyLimit = studio.listCount;
let currentSpeech = null;
let speechDisplayTimer;
let imageGeneration = 0;
let speechImageGeneration = 0;
try {
  const saved = JSON.parse(storage?.getItem('pokome-speech-options') || '{}');
  for (const platform of Object.keys(states)) states[platform].speechOptions = normalizeSpeechOptions(saved?.[platform]);
} catch { /* Invalid stored options leave defaults intact. */ }
try {
  const savedRules = JSON.parse(storage?.getItem('pokome-users-v2') || 'null');
  const legacyRules = JSON.parse(storage?.getItem('pokome-users') || '{}');
  for (const platform of Object.keys(states)) {
    const rules = savedRules?.[platform] || (platform === 'twitch' ? legacyRules : {});
    if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
      for (const [user, rule] of Object.entries(rules)) {
        states[platform].rules[user] = { hidden: rule?.hidden === true, muted: rule?.muted === true };
      }
    }
  }
} catch { /* Invalid stored settings are ignored. */ }

const supported = 'speechSynthesis' in window;
let voices = [];
let pendingSpeech = 0;
let speechGeneration = 0;

function notify(text) {
  $('notice').textContent = text;
  $('notice').style.display = 'block';
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { $('notice').style.display = 'none'; }, 3500);
}

function save(key, value) {
  try {
    if (!storage) throw new Error('Storage unavailable');
    storage.setItem(key, JSON.stringify(value));
  } catch { notify('設定を保存できませんでした。ブラウザの保存設定を確認してください。'); }
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderConnection() {
  const state = states[active];
  const presentation = connectionPresentation(state.status);
  $('chat-demo-note').hidden = state.status !== 'デモモード';
  $('chat-connection-status').textContent = presentation.label;
  $('chat-connection-status').dataset.state = presentation.kind;
  $('stage-platform').textContent = names[active];
  $('stage-channel').textContent = state.channel ? `#${state.channel}` : '';
  $('stage-connection').textContent = presentation.label;
  $('stage-connection').dataset.state = presentation.kind;
  for (const platform of Object.keys(states)) {
    const service = states[platform];
    const view = connectionPresentation(service.status);
    const disconnectable = ['connected', 'connecting'].includes(view.kind);
    const toggle = $(`${platform}-connection-toggle`);
    toggle.textContent = disconnectable ? '切断' : '接続';
    toggle.setAttribute('aria-label', `${names[platform]}${disconnectable ? 'を切断' : 'に接続'}`);
    toggle.title = disconnectable ? '接続を切断します' : savedConnections[platform]
      ? `保存済みの #${savedConnections[platform]} に接続します` : '接続設定でチャンネルを保存してください';
    for (const id of [`${platform}-status`, `${platform}-tab-status`]) {
      $(id).textContent = view.label;
      $(id).dataset.state = view.kind;
      $(id).title = view.detail;
    }
    $(`${platform}-tab-channel`).textContent = service.channel ? `#${service.channel}` : 'チャンネル未接続';
    $(`${platform}-connection-detail`).textContent = view.detail + (view.kind === 'error' ? ' チャンネル名とネット接続を確認し、接続し直してください。' : '');
  }
}

function renderSelection() {
  const state = states[active];
  const message = state.selected;
  $('preview-user').textContent = message?.user || 'ぽこめ Reader';
  $('preview-text').textContent = message
    ? (isSpeechUserExcluded(message, state.channel, state.speechOptions) ? '' : prepareSpeechText(message.text, state.speechOptions, active)) || 'このコメントは読み上げ対象外です。'
    : `${names[active]}のコメントを待っています。`;
  $('selected-user').textContent = message?.user || 'コメントを選択してください';
  $('hide-user').disabled = !message;
  $('mute-user').disabled = !message;
  $('hide-user').textContent = message && userRule(state, message.user).hidden ? '↺ 非表示解除' : '⊘ ユーザーを非表示';
  $('mute-user').textContent = message && userRule(state, message.user).muted ? '↺ 除外解除' : '◖ 読み上げ除外';
}

function render() {
  const state = states[active];
  const visible = visibleMessages(state);
  const list = $('comment-list');
  const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
  list.replaceChildren();
  for (const message of visible) {
    const row = make('div', `comment pokome-comment${state.selected?.id === message.id ? ' selected' : ''}`, '');
    const name = make('button', 'username pokome-comment__author', '');
    name.append(make('span', `avatar ${active}`, active === 'kick' ? 'K' : '▣'), document.createTextNode(message.user));
    name.setAttribute('aria-haspopup', 'dialog');
    name.setAttribute('aria-controls', 'user-actions');
    name.setAttribute('aria-label', message.user + ' の操作');
    name.title = 'ユーザー・コメントの操作メニューを開く';
    const openActions = event => {
      state.selected = message;
      renderSelection();
      for (const item of list.querySelectorAll('.comment')) {
        item.classList.toggle('selected', item === row);
        item.querySelector('.message').setAttribute('aria-pressed', String(item === row));
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const menu = $('user-actions');
      menu.showPopover();
      menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 8)) + 'px';
      $('hide-user').focus();
    };
    const body = make('button', 'message pokome-comment__body', message.text);
    body.title = 'ユーザー・コメントの操作メニューを開く';
    body.setAttribute('aria-pressed', String(state.selected?.id === message.id));
    for (const trigger of [name, body]) {
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', 'user-actions');
      trigger.onclick = openActions;
    }
    row.append(name, body, make('span', 'time', message.time));
    list.append(row);
  }
  if (!visible.length) list.append(make('p', 'empty', `${names[active]}の表示するコメントがありません。`));
  if (bottom) list.scrollTop = list.scrollHeight;
  $('count').replaceChildren(document.createTextNode(`${state.received} `), make('small', '', '件'));
  $('user-count').replaceChildren(document.createTextNode(`${state.seen.size} `), make('small', '', '人'));
  $('visible-count').textContent = visible.length;
  $('chat-platform').textContent = names[active];
  $('users-platform').textContent = names[active];
  $('comment-list').setAttribute('aria-label', `${names[active]}の受信コメント`);
  renderConnection();
  renderUsers();
  renderStageChat();
}

function add(platform, user, text, createdAt, login = user, readAutomatically = true) {
  const state = states[platform];
  const message = addMessage(state, user, text, ++session, createdAt, login);
  if (!message) return;
  if (platform === active) {
    render();
    if (readAutomatically && state.autoSpeech && !userRule(state, user).hidden && !userRule(state, user).muted) speak(message, true);
  }
}

function speak(message, automatic = false) {
  const preference = enginePreferences[active];
  if (!supported && preference.engine === 'browser') { notify('このブラウザは読み上げに対応していません。'); return; }
  if (preference.engine !== 'browser' && !preference[preference.engine]) { notify('音声ソフトを起動し、声を取得・選択してください。'); return; }
  if (pendingSpeech >= 20) return;
  const state = states[active];
  if (isSpeechUserExcluded(message, state.channel, state.speechOptions)) {
    if (!automatic) notify('このユーザーは設定により読み上げ対象外です。');
    return;
  }
  const text = prepareSpeechText(message.text, state.speechOptions, active);
  if (!text) { if (!automatic) notify('URLのみ・コマンドなど、設定により読み上げ対象外です。'); return; }
  if (automatic && !shouldAutoRead(state.speechHistory, message.user, text, state.speechOptions)) return;
  const platform = active;
  const generation = speechGeneration;
  const spokenText = (state.readName ? `${message.user}さん。` : '') + text;
  const utterance = preference.engine === 'browser' ? new SpeechSynthesisUtterance(spokenText) : { text: spokenText };
  utterance.lang = 'ja-JP';
  utterance.rate = state.rate;
  utterance.volume = state.volume;
  utterance.voice = voices.find(voice => voice.voiceURI === state.voice) || null;
  pendingSpeech++;
  utterance.onstart = () => {
    if (generation !== speechGeneration || platform !== active) return;
    $('speech-status').textContent = '読み上げ中';
    $('preview-user').textContent = message.user;
    $('preview-text').textContent = text;
    clearTimeout(speechDisplayTimer);
    currentSpeech = { user: message.user, text, utterance, speaking: true };
    renderStageSpeech();
  };
  const done = () => {
    if (generation !== speechGeneration) return;
    pendingSpeech = Math.max(0, pendingSpeech - 1);
    if (currentSpeech?.utterance === utterance) {
      currentSpeech.speaking = false;
      renderStageSpeech();
      speechDisplayTimer = setTimeout(() => {
        if (currentSpeech?.utterance !== utterance) return;
        currentSpeech = null;
        renderStageSpeech();
      }, 5000);
    }
    if (!pendingSpeech) $('speech-status').textContent = '待機中';
  };
  utterance.onend = done;
  utterance.onerror = event => { done(); if (!['canceled', 'interrupted'].includes(event.error)) $('engine-status').textContent = '読み上げに失敗しました。音声を選び直し、音量とブラウザの音声再生設定を確認して音声テストを試してください。'; };
  if (preference.engine === 'browser') window.speechSynthesis.speak(utterance);
  else localSpeech.speak(utterance, preference.engine, preference[preference.engine]);
  if (automatic) rememberAutoRead(state.speechHistory, message.user, text);
}

function stop() {
  speechGeneration++;
  localSpeech.cancel();
  clearTimeout(speechDisplayTimer);
  if (supported) window.speechSynthesis.cancel();
  pendingSpeech = 0;
  currentSpeech = null;
  renderStageSpeech();
  $('speech-status').textContent = supported || enginePreferences[active].engine !== 'browser' ? '待機中' : 'ブラウザ非対応';
}

function toggleRule(user, key) {
  const state = states[active];
  state.rules[user] = { ...userRule(state, user), [key]: !userRule(state, user)[key] };
  save('pokome-users-v2', { twitch: states.twitch.rules, kick: states.kick.rules });
  stop();
  renderSelection();
  render();
  notify(`${names[active]}: ${user} の設定を変更しました。`);
}

function renderUsers() {
  const state = states[active];
  const container = $('user-list');
  container.replaceChildren();
  const all = new Set([...state.seen, ...Object.keys(state.rules)]);
  if (!all.size) container.append(make('p', 'empty', 'コメントを受信するとユーザーが表示されます。'));
  for (const user of all) {
    const row = make('div', 'user-row', '');
    row.append(make('strong', '', user));
    for (const [key, label] of [['hidden', '非表示'], ['muted', '読み上げ除外']]) {
      const button = make('button', 'button', userRule(state, user)[key] ? `${label}を解除` : label);
      button.onclick = () => toggleRule(user, key);
      row.append(button);
    }
    container.append(row);
  }
}

function page(name) {
  $('settings-backup-panel').hidden = name !== 'settings';
  $('user-actions').hidePopover();
  document.querySelector('main').dataset.view = name;
  for (const item of ['home', 'users', 'settings', 'studio', 'updates']) $(`${item}-page`).hidden = item !== name;
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  document.querySelector('main>header').hidden = name === 'home';
  $('page-title').textContent = { home: '', users: 'ユーザー管理', settings: '接続設定', studio: '配信デザイン', updates: '更新情報' }[name];
}

function switchPlatform(platform) {
  if (!enabledPlatforms.includes(platform) || active === platform) return;
  $('user-actions').hidePopover();
  stop();
  active = platform;
  const state = states[active];
  document.querySelectorAll('[data-platform]').forEach(button => {
    const selected = button.dataset.platform === active;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('search').value = state.search;
  $('filter').value = state.filter;
  $('auto-speech').checked = state.autoSpeech;
  $('read-name').checked = state.readName;
  loadVoices();
  $('volume').value = state.volume;
  $('rate').value = state.rate;
  renderSpeechSettings();
  renderSpeechOptions();
  renderSelection();
  render();
  $('comment-list').scrollTop = $('comment-list').scrollHeight;
}

document.querySelectorAll('[data-platform]').forEach(button => { button.onclick = () => switchPlatform(button.dataset.platform); });
document.querySelectorAll('[data-connection-settings]').forEach(button => {
  button.onclick = () => {
    const platform = button.dataset.connectionSettings;
    switchPlatform(platform);
    page('settings');
    $(`${platform}-channel`).focus();
  };
});
document.querySelectorAll('.nav[data-page]').forEach(button => { button.onclick = () => page(button.dataset.page); });
$('search').oninput = () => { states[active].search = $('search').value; render(); };
$('filter').onchange = () => { states[active].filter = $('filter').value; render(); };
for (const [id, key] of [['hide-user', 'hidden'], ['mute-user', 'muted']]) {
  $(id).onclick = () => {
    $('user-actions').hidePopover();
    if (states[active].selected) toggleRule(states[active].selected.user, key);
    $('search').focus();
  };
}
$('hide-comment').onclick = () => {
  $('user-actions').hidePopover();
  const state = states[active];
  if (state.selected) {
    state.selected.hidden = true;
    state.selected = null;
    stop();
    renderSelection();
    render();
    notify('このコメントを非表示にしました。');
  }
  $('search').focus();
};
$('read-selected').onclick = () => states[active].selected ? speak(states[active].selected) : notify('コメントを選択してください。');
$('stop-speech').onclick = stop;
function setAutoSpeech(enabled) {
  states[active].autoSpeech = enabled;
  $('auto-speech').checked = enabled;
  save('pokome-auto-speech', { twitch: states.twitch.autoSpeech, kick: states.kick.autoSpeech });
  renderSpeechSettings();
  if (!states[active].autoSpeech) stop();
}
$('auto-speech').onchange = () => setAutoSpeech($('auto-speech').checked);
$('stage-auto-speech').onclick = () => setAutoSpeech(!states[active].autoSpeech);
$('read-name').onchange = () => { states[active].readName = $('read-name').checked; };
$('voice').onchange = () => {
  stop();
  const preference = enginePreferences[active];
  if (preference.engine === 'browser') {
    states[active].voice = $('voice').value;
    save('pokome-voices', { twitch: states.twitch.voice, kick: states.kick.voice });
  } else { preference[preference.engine] = $('voice').value; save('pokome-speech-engines', enginePreferences); }
};
$('speech-engine').onchange = () => {
  stop();
  enginePreferences[active].engine = $('speech-engine').value;
  save('pokome-speech-engines', enginePreferences);
  loadVoices();
};
$('refresh-voices').onclick = () => loadVoices(true);
$('test-voice').onclick = () => speak({ user: '音声テスト', login: 'pokome_test', text: 'こんにちは。読み上げ音声のテストです。' });
$('local-speech-controls').hidden = publication === 'pages';
if (publication === 'pages') for (const option of $('speech-engine').options) option.hidden = option.value !== 'browser';
function renderSpeechSettings() {
  const state = states[active];
  $('speech-stat').textContent = state.autoSpeech ? 'ON' : 'OFF';
  $('stage-auto-speech').textContent = `自動読み上げ ${state.autoSpeech ? 'ON' : 'OFF'}`;
  $('stage-auto-speech').setAttribute('aria-checked', String(state.autoSpeech));
  $('volume-value').textContent = `${Math.round(state.volume * 100)}%`;
  $('stage-volume').value = state.volume;
  $('stage-volume-value').textContent = `${Math.round(state.volume * 100)}%`;
  $('rate-value').textContent = `${state.rate}×`;
}
function renderSpeechOptions() {
  const options = states[active].speechOptions;
  $('max-length').value = options.maxLength;
  $('user-interval').value = options.userInterval;
  $('skip-urls').checked = options.skipUrls;
  $('skip-duplicates').checked = options.skipDuplicates;
  $('skip-commands').checked = options.skipCommands;
  $('skip-nightbot').checked = options.skipNightbot;
  $('skip-broadcaster').checked = options.skipBroadcaster;
}
function updateSpeechOptions() {
  states[active].speechOptions = normalizeSpeechOptions({
    maxLength: Number($('max-length').value), userInterval: Number($('user-interval').value),
    skipUrls: $('skip-urls').checked, skipDuplicates: $('skip-duplicates').checked,
    skipCommands: $('skip-commands').checked,
    skipNightbot: $('skip-nightbot').checked, skipBroadcaster: $('skip-broadcaster').checked,
  });
  stop();
  states[active].speechHistory = createSpeechHistory();
  save('pokome-speech-options', { twitch: states.twitch.speechOptions, kick: states.kick.speechOptions });
  renderSpeechOptions();
  renderSelection();
}
for (const id of ['max-length', 'user-interval', 'skip-urls', 'skip-duplicates', 'skip-commands', 'skip-nightbot', 'skip-broadcaster']) {
  $(id).onchange = updateSpeechOptions;
}
$('stage-volume').oninput = () => {
  states[active].volume = Number($('stage-volume').value);
  $('volume').value = states[active].volume;
  renderSpeechSettings();
};
let volumeCloseTimer;
let volumeDragging = false;
function cancelVolumeClose() { clearTimeout(volumeCloseTimer); }
function scheduleVolumeClose() {
  cancelVolumeClose();
  if (volumeDragging) return;
  volumeCloseTimer = setTimeout(() => {
    const popover = $('stage-volume-dialog');
    if (popover.matches(':hover') || $('stage-volume-settings').matches(':hover') || popover.contains(document.activeElement)) return;
    if (popover.matches(':popover-open')) popover.hidePopover();
  }, 300);
}
function openStageVolume() {
  cancelVolumeClose();
  const button = $('stage-volume-settings');
  const popover = $('stage-volume-dialog');
  if (popover.matches(':popover-open')) return;
  popover.showPopover();
  const anchor = button.getBoundingClientRect();
  const panel = popover.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8))}px`;
  popover.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - panel.height - 8))}px`;
}
$('stage-volume-settings').onpointerenter = event => { if (event.pointerType !== 'touch') openStageVolume(); };
$('stage-volume-settings').onpointerleave = scheduleVolumeClose;
$('stage-volume-dialog').onpointerenter = cancelVolumeClose;
$('stage-volume-dialog').onpointerleave = scheduleVolumeClose;
$('stage-volume-dialog').addEventListener('focusout', scheduleVolumeClose);
$('stage-volume').addEventListener('pointerdown', () => { volumeDragging = true; cancelVolumeClose(); });
for (const event of ['pointerup', 'pointercancel']) $('stage-volume').addEventListener(event, () => {
  volumeDragging = false;
  $('stage-volume').blur();
  scheduleVolumeClose();
});
$('stage-volume-settings').onclick = () => { openStageVolume(); $('stage-volume').focus(); };
$('stage-volume-dialog').addEventListener('keydown', event => {
  if (event.key === 'Escape') event.stopPropagation();
});
for (const id of ['volume', 'rate']) $(id).oninput = () => {
  states[active][id] = Number($(id).value);
  renderSpeechSettings();
};
function loadBrowserVoices() {
  voices = supported ? window.speechSynthesis.getVoices() : [];
  $('voice').replaceChildren(make('option', '', 'ブラウザの標準音声'));
  $('voice').firstChild.value = '';
  for (const voice of voices.filter(voice => voice.lang.startsWith('ja'))) {
    const option = make('option', '', voice.name);
    option.value = voice.voiceURI;
    $('voice').append(option);
  }
  $('voice').value = states[active].voice;
  if (!$('voice').value) $('voice').value = '';
}
async function loadVoices(refresh = false) {
  const generation = ++voiceLoadGeneration;
  const platform = active;
  const preference = enginePreferences[platform];
  const engine = preference.engine;
  $('speech-engine').value = engine;
  $('refresh-voices').hidden = engine === 'browser';
  $('voice').disabled = engine !== 'browser';
  const status = $('engine-status');
  if (engine === 'browser') { status.textContent = ''; loadBrowserVoices(); return; }
  $('voice').replaceChildren(make('option', '', '声を取得中…'));
  status.textContent = '音声ソフトへ接続中…';
  try {
    if (refresh || !engineVoices[engine]) {
      const response = await fetch('./api/speech/' + engine + '/voices', { signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.voices) || !data.voices.length) throw new Error(data.error || '利用できる声がありません。');
      if (generation !== voiceLoadGeneration) return;
      engineVoices[engine] = data.voices;
    }
    if (generation !== voiceLoadGeneration || active !== platform) return;
    const list = engineVoices[engine];
    $('voice').replaceChildren(...list.map(voice => { const option = make('option', '', voice.name); option.value = voice.id; return option; }));
    if (!list.some(voice => voice.id === preference[engine])) preference[engine] = list[0].id;
    $('voice').value = preference[engine];
    $('voice').disabled = false;
    save('pokome-speech-engines', enginePreferences);
    status.textContent = list.length + '種類の声を取得しました。';
  } catch (error) {
    if (generation !== voiceLoadGeneration || active !== platform) return;
    $('voice').replaceChildren(make('option', '', '声を取得できません'));
    status.textContent = error.message === 'The operation was aborted due to timeout' ? '接続がタイムアウトしました。音声ソフトを起動して再取得してください。' : error.message + ' 音声ソフトを起動し、読み上げ方式が合っているか確認して「声を再取得」を押してください。';
  }
}
if (supported) {
  loadVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => { if (enginePreferences[active].engine === 'browser') loadVoices(); });
} else {
  for (const state of Object.values(states)) state.autoSpeech = false;
  $('auto-speech').disabled = publication === 'pages';
  loadVoices();
  $('speech-status').textContent = 'ブラウザ非対応';
}
$('clear').onclick = () => {
  if (!states[active].messages.length || !window.confirm(`${names[active]}のコメント履歴をすべて削除します。元に戻せません。削除しますか？`)) return;
  clearMessages(states[active]); stop(); renderSelection(); render();
};

function renderStageChat() {
  const state = states[active];
  const messages = state.messages.filter(message => !message.hidden && !userRule(state, message.user).hidden);
  const list = $('stage-chat-list');
  const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
  list.replaceChildren();
  for (const message of messages) {
    const card = make('div', 'stage-comment pokome-comment', '');
    card.title = `${message.user}: ${message.text}`;
    card.append(make('strong', 'pokome-comment__author', message.user), make('p', 'pokome-comment__body', message.text));
    list.append(card);
  }
  if (!messages.length) list.append(make('p', 'stage-empty', 'あなたの声を、待っています。'));
  if (bottom) list.scrollTop = list.scrollHeight;
  updateStageCommentVisibility();
  $('stage-count').textContent = `${state.received} COMMENTS`;
}

function updateStageCommentVisibility() {
  const list = $('stage-chat-list');
  if (!list.clientHeight) return;
  const bounds = list.getBoundingClientRect();
  for (const comment of list.querySelectorAll('.stage-comment')) {
    const rect = comment.getBoundingClientRect();
    // Long comments remain scrollable even when they cannot fit in one view.
    const clipped = rect.height <= list.clientHeight && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
    comment.classList.toggle('stage-comment-clipped', clipped);
  }
}
$('stage-chat-list').addEventListener('scroll', updateStageCommentVisibility, { passive: true });
new ResizeObserver(updateStageCommentVisibility).observe($('stage-chat-list'));

function renderStageSpeech() {
  $('stage-speech-status').textContent = currentSpeech?.speaking ? '読み上げ中' : '待機中';
  $('stage-speech-user').textContent = currentSpeech?.user || '';
  $('stage-speech-text').textContent = currentSpeech?.text || '次のコメントを待っています。';
  $('stage-speech-text').closest('.stage-speech').dataset.speaking = String(!!currentSpeech?.speaking);
}

function renderStudio() {
  const stage = $('talk-stage');
  stage.dataset.theme = studio.theme;
  stage.dataset.layout = studio.layout;
  stage.dataset.decorated = String(studio.decoration);
  stage.style.setProperty('--stage-accent', studio.accentMode === 'theme' ? THEME_ACCENTS[studio.theme] : studio.accent);
  stage.style.setProperty('--stage-font-size', `${studio.fontSize}px`);
  $('stage-chat-list').dataset.commentStyle = studio.commentStyle;
  $('stage-comment-style').value = studio.commentStyle;
  $('stage-speech-user').hidden = studio.commentStyle === 'anonymous';
  stage.style.setProperty('--speech-font-size', `${studio.speechFontSize}px`);
  stage.style.setProperty('--speech-background', studio.speechBackground);
  const luminance = studio.speechBackground.slice(1).match(/../g).map(hex => {
    const channel = parseInt(hex, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  stage.style.setProperty('--speech-ink', luminance > .179 ? '#000000' : '#ffffff');
  document.querySelector('.stage-speech').dataset.style = studio.speechStyle;
  stage.style.setProperty('--speech-image', `url("${studio.speechImage || './speech-background.svg'}")`);
  stage.style.setProperty('--speech-image-ink', studio.speechTextColor);
  const preview = document.querySelector('.speech-bubble');
  preview.dataset.style = studio.speechStyle;
  for (const property of ['--speech-background', '--speech-ink', '--speech-image', '--speech-image-ink']) {
    preview.style.setProperty(property, stage.style.getPropertyValue(property));
  }
  const stageColors = getComputedStyle(stage);
  preview.style.setProperty('--stage-surface', stageColors.getPropertyValue('--stage-surface'));
  preview.style.setProperty('--stage-text', stageColors.getPropertyValue('--stage-text'));
  preview.style.setProperty('--stage-border', stageColors.getPropertyValue('--stage-border'));
  preview.style.setProperty('--stage-accent', stageColors.getPropertyValue('--stage-accent'));
  stage.style.setProperty('--actor-width', `${studio.actorWidth}fr`);
  stage.style.setProperty('--chat-width', `${100 - studio.actorWidth}fr`);
  $('stage-title').textContent = studio.title;
  $('stage-subtitle').textContent = studio.subtitle;
  $('stage-footer-text').textContent = studio.footer;
  $('stage-speech-title').textContent = studio.speechTitle;
  $('studio-speech-font-size').value = studio.speechFontSize;
  $('studio-speech-style').value = studio.speechStyle;
  $('studio-speech-background').value = studio.speechBackground;
  $('studio-speech-background').disabled = studio.speechStyle !== 'bubble';
  $('speech-background-field').classList.toggle('inactive-field', studio.speechStyle !== 'bubble');
  $('speech-background-help').textContent = studio.speechStyle === 'bubble' ? 'セリフの吹き出しの背景に使う色です。' : '「読み上げ枠のスタイル」で「セリフの吹き出し」を選ぶと変更できます。';
  $('studio-speech-text-color').value = studio.speechTextColor;
  $('studio-speech-image-status').textContent = studio.speechImage ? 'ユーザーの背景画像を登録済みです。' : '標準の背景画像を使用します。';
  $('reset-speech-image').disabled = !studio.speechImage;
  const hasImage = studio.source === 'image' && !!studio.image;
  $('actor-image').hidden = !hasImage;
  if ($('actor-image').getAttribute('src') !== (studio.image || null)) {
    if (studio.image) $('actor-image').src = studio.image;
    else $('actor-image').removeAttribute('src');
  }
  $('actor-placeholder').hidden = hasImage;
  $('actor-placeholder').querySelector('small').textContent = studio.source === 'image'
    ? '配信デザイン設定で画像を読み込んでください' : 'OBSで映像を重ねるための空き枠';
  $('actor-caption').textContent = hasImage ? 'WITH YOU ♡' : 'YOUR SPACE';
  for (const key of ['theme', 'source']) $(`studio-${key}`).value = studio[key];
  $('stage-font-value').textContent = `${studio.fontSize}px`;
  $('stage-font-minus').disabled = studio.fontSize <= 16;
  $('stage-font-plus').disabled = studio.fontSize >= 28;
  $('studio-accent-mode').value = studio.accentMode;
  $('studio-accent').disabled = studio.accentMode === 'theme';
  $('studio-accent').value = studio.accentMode === 'theme' ? THEME_ACCENTS[studio.theme] : studio.accent;
  $('studio-accent-help').textContent = studio.accentMode === 'theme' ? 'テーマに合わせて配色します。色を指定する場合は「自分で設定」に切り替えてください。' : '背景は選んだテーマ、アクセントカラーは指定した色を使います。';
  $('studio-list-count').value = studio.listCount;
  $('history-limit-label').textContent = `サービスごとに直近${studio.listCount}件 · ユーザー名・コメントから操作`;
  $('studio-decoration').checked = studio.decoration;
  $('studio-image-status').textContent = studio.image ? '立ち絵画像を登録済みです。' : '画像は未登録です。';
  $('remove-actor-image').disabled = !studio.image;
}

function enterTalk(fromHistory = false) {
  if (document.body.classList.contains('talk-mode')) return;
  if (fromHistory !== true) history.pushState({ ...history.state, pokomeTalk: true }, '');
  $('talk-stage').hidden = false;
  document.body.classList.add('talk-mode');
  renderStageChat();
  $('stage-chat-list').scrollTop = $('stage-chat-list').scrollHeight;
  updateStageCommentVisibility();
  renderStageSpeech();
  // Move focus to the canvas so controls disappear for screen capture.
  $('talk-stage').setAttribute('tabindex', '-1');
  $('talk-stage').focus({ preventScroll: true });
}
function leaveTalk(fromHistory = false) {
  if (!document.body.classList.contains('talk-mode')) return;
  if (fromHistory !== true && history.state?.pokomeTalk) history.back();
  if ($('stage-connection-dialog').open) $('stage-connection-dialog').close();
  if ($('stage-volume-dialog').matches(':popover-open')) $('stage-volume-dialog').hidePopover();
  closeTextEditor?.();
  document.body.classList.remove('talk-mode');
  $('talk-stage').hidden = true;
  page('home');
  $('enter-talk').focus({ preventScroll: true });
}
window.addEventListener('popstate', () => {
  if (history.state?.pokomeTalk) enterTalk(true);
  else leaveTalk(true);
});
$('enter-talk').onclick = enterTalk;
$('leave-talk').onclick = leaveTalk;
let connectionPanelOrigin;
$('stage-connection').onclick = () => {
  const panel = $(active + '-connect-form').closest('section');
  connectionPanelOrigin = document.createComment('connection panel');
  panel.before(connectionPanelOrigin);
  $('stage-connection-content').append(panel);
  $('stage-connection-title').textContent = names[active] + ' 接続設定';
  $('stage-connection-dialog').showModal();
  $(active + '-channel').focus();
};
$('close-stage-connection').onclick = () => $('stage-connection-dialog').close();
$('stage-connection-dialog').addEventListener('close', () => {
  const panel = $('stage-connection-content').firstElementChild;
  if (panel && connectionPanelOrigin) connectionPanelOrigin.replaceWith(panel);
  connectionPanelOrigin = null;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('talk-mode') && !$('stage-connection-dialog').open) leaveTalk();
});
document.querySelectorAll('[data-stage-platform]').forEach(button => {
  button.onclick = () => switchPlatform(button.dataset.stagePlatform);
});

function updateStudio() {
  const source = $('studio-source').value;
  studio = normalizeStudio({ ...studio,
    theme: $('studio-theme').value, accentMode: $('studio-accent-mode').value,
    accent: studio.accentMode === 'custom' ? $('studio-accent').value : studio.accent,
    speechFontSize: Number($('studio-speech-font-size').value),
    speechStyle: $('studio-speech-style').value, speechBackground: $('studio-speech-background').value,
    speechTextColor: $('studio-speech-text-color').value,
    listCount: Number($('studio-list-count').value),
    decoration: $('studio-decoration').checked, source,
  });
  save('pokome-studio', studio);
  for (const state of Object.values(states)) {
    state.historyLimit = studio.listCount;
    if (state.messages.length > studio.listCount) state.messages.splice(0, state.messages.length - studio.listCount);
  }
  renderStudio();
  render();
}
for (const id of ['theme', 'accent', 'speech-font-size', 'speech-style', 'speech-background', 'speech-text-color', 'list-count', 'decoration', 'source']) {
  $(`studio-${id}`).onchange = updateStudio;
}
$('studio-accent-mode').onchange = updateStudio;
$('stage-comment-style').onchange = () => {
  const list = $('stage-chat-list');
  const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
  studio = normalizeStudio({ ...studio, commentStyle: $('stage-comment-style').value });
  save('pokome-studio', studio); renderStudio();
  if (bottom) list.scrollTop = list.scrollHeight;
  updateStageCommentVisibility();
};
$('stage-comment-settings').onclick = () => $('stage-comment-settings-dialog').showModal();
$('stage-comment-settings-dialog').addEventListener('keydown', event => {
  if (event.key === 'Escape') event.stopPropagation();
});
for (const [id, step] of [['stage-font-minus', -2], ['stage-font-plus', 2]]) {
  $(id).onclick = () => {
    const list = $('stage-chat-list');
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    studio = normalizeStudio({ ...studio, fontSize: Math.max(16, Math.min(28, studio.fontSize + step)) });
    save('pokome-studio', studio); renderStudio();
    if (bottom) list.scrollTop = list.scrollHeight;
    updateStageCommentVisibility();
  };
}
let closeTextEditor = null;
for (const [id, key, label, limit] of [
  ['stage-title', 'title', '配信タイトル', 60],
  ['stage-subtitle', 'subtitle', 'ひとこと', 100],
  ['stage-footer-text', 'footer', '画面下の文章', 100],
  ['stage-speech-title', 'speechTitle', '読み上げ枠の見出し', 40],
]) {
  const text = $(id);
  const wrapper = make('span', 'stage-editable', '');
  text.replaceWith(wrapper);
  wrapper.append(text);
  const edit = make('button', 'stage-edit-pencil', '✎');
  edit.type = 'button'; edit.setAttribute('aria-label', `${label}を編集`); edit.title = `${label}を編集`;
  wrapper.append(edit);
  edit.onclick = () => {
    closeTextEditor?.();
    const dialog = document.createElement('dialog');
    dialog.className = 'stage-text-dialog';
    dialog.setAttribute('aria-label', `${label}を編集`);
    const form = make('form', 'stage-text-editor', '');
    const caption = make('label', '', `${label}（${limit}文字まで）`);
    const input = document.createElement('input'); input.value = studio[key]; input.maxLength = limit; input.setAttribute('aria-label', label);
    caption.append(input);
    const submit = make('button', 'button primary', '保存'); submit.type = 'submit';
    const cancel = make('button', 'button', 'キャンセル'); cancel.type = 'button';
    form.append(caption, submit, cancel); dialog.append(form); wrapper.append(dialog); edit.hidden = true;
    const close = () => { dialog.close(); dialog.remove(); edit.hidden = false; edit.focus({ preventScroll: true }); closeTextEditor = null; };
    closeTextEditor = close;
    cancel.onclick = close;
    dialog.oncancel = event => { event.preventDefault(); close(); };
    form.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    form.onsubmit = event => {
      event.preventDefault(); studio = normalizeStudio({ ...studio, [key]: input.value });
      save('pokome-studio', studio); renderStudio(); close();
    };
    dialog.showModal(); input.focus(); input.select();
  };
}
async function uploadStudioImage(input, target) {
  const file = input.files[0];
  const isSpeech = target === 'speechImage';
  const generation = isSpeech ? ++speechImageGeneration : ++imageGeneration;
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    notify('PNG・JPEG・WebP・GIFの2MB以下の画像を選んでください。');
    input.value = '';
    return;
  }
  try {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      reader.readAsDataURL(file);
    });
    const probe = new Image();
    probe.src = image;
    await probe.decode();
    if (generation !== (isSpeech ? speechImageGeneration : imageGeneration)) return;
    const next = normalizeStudio({ ...studio, ...(isSpeech ? { speechStyle: 'image', speechImage: image } : { source: 'image', image }) });
    // Only replace the previous image once saving the new one succeeds.
    if (!storage) throw new Error('ブラウザに画像を保存できません。');
    storage.setItem('pokome-studio', JSON.stringify(next));
    studio = next;
    renderStudio();
  } catch { notify('画像を読み込み・保存できませんでした。小さい画像やブラウザの保存設定を確認してください。'); }
  input.value = '';
}
$('studio-image').onchange = () => uploadStudioImage($('studio-image'), 'image');
$('studio-speech-image').onchange = () => uploadStudioImage($('studio-speech-image'), 'speechImage');
$('reset-speech-image').onclick = () => {
  speechImageGeneration++;
  studio = { ...studio, speechImage: '', speechStyle: 'image' };
  save('pokome-studio', studio);
  renderStudio();
};
$('remove-actor-image').onclick = () => {
  imageGeneration++;
  studio = { ...studio, image: '' };
  save('pokome-studio', studio);
  renderStudio();
};

renderStudio();
renderStageSpeech();

const samples = {
  twitch: [['minto_0123', 'ぽこめちゃん、はじめまして！いつも配信楽しみにしてます！'], ['sakura_pink', '今日も配信ありがとう 🌸'], ['nekotan_22', 'こんばんは〜！'], ['game_lover', 'このステージの雰囲気、すごく好き'], ['yuki_4649', '音声ちゃんと聞こえてるよ！'], ['tanaka2525', 'ナイスプレイ！！'], ['mochi_chan', 'お茶飲みながら、のんびり見てます 🍵'], ['harupeko', 'そのキャラクターかわいい！'], ['ao_ooo', '初見です！よろしくお願いします'], ['kana_night', 'きょうもおつかれさま ♡'], ['minto_0123', '次のステージも楽しみ！'], ['sakura_pink', '888888 👏']],
  kick: [['kick_viewer', 'Kickからこんにちは！'], ['green_leaf', 'こちらのチャットも見えてるよ 🌿'], ['minto_0123', 'Kickのコメントはここに届きます。']],
};
$('demo').onclick = () => {
  if (states[active].status !== 'デモモード') { notify('実接続中はデモコメントを追加できません。'); return; }
  add(active, ...samples[active][states[active].sampleIndex++ % samples[active].length]);
};

const connections = {};
async function connectChannel(platform, channel) {
  if (!validChannel(platform, channel)) { notify('チャンネル名を確認してください。'); return; }
  clearMessages(states[platform]);
  states[platform].seen.clear();
  states[platform].received = 0;
  states[platform].speechHistory = createSpeechHistory();
  if (platform === active) { stop(); renderSelection(); render(); }
  await connections[platform].connect(channel);
}
for (const platform of enabledPlatforms) {
  $(`${platform}-channel`).value = savedConnections[platform];
  connections[platform] = new ChatConnection(platform, {
    onStatus(status, channel) {
      states[platform].status = status;
      states[platform].channel = channel;
      renderConnection();
    },
    onMessage(message) { add(platform, message.user, message.text, message.createdAt, message.login); },
    onConnected(channel) {
      savedConnections[platform] = channel;
      save('pokome-connections', savedConnections);
      $(`${platform}-channel`).value = channel;
      renderConnection();
    },
  });
  $(`${platform}-disconnect`).onclick = () => connections[platform].disconnect();
  $(`${platform}-connection-toggle`).onclick = async () => {
    if (['接続中', '接続準備中'].includes(states[platform].status)) {
      connections[platform].disconnect();
    } else if (savedConnections[platform]) {
      await connectChannel(platform, savedConnections[platform]);
    } else {
      document.querySelector(`[data-connection-settings="${platform}"]`).click();
      notify('チャンネルを入力して接続すると、次回からこのボタンで接続できます。');
    }
  };
  $(`${platform}-connect-form`).onsubmit = async event => {
    event.preventDefault();
    const channel = $(`${platform}-channel`).value.trim().toLowerCase();
    await connectChannel(platform, channel);
  };
}
function clock() {
  $('clock').textContent = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
clock();
setInterval(clock, 30000);
for (const platform of Object.keys(states)) {
  for (const [user, text] of samples[platform]) add(platform, user, text, undefined, user, false);
  states[platform].selected = states[platform].messages[0];
}
renderSelection();
$('auto-speech').checked = states[active].autoSpeech;
renderSpeechSettings();
renderSpeechOptions();
render();
const themeEditor = initializeTheme(storage);
themeEditor.connectWorkspace(initializeWorkspace(storage));
window.addEventListener('beforeunload', () => {
  stop();
  for (const connection of Object.values(connections)) connection.disconnect(false);
});

$('open-setup').onclick = () => $('setup-dialog').showModal();
$('close-setup').onclick = () => $('setup-dialog').close();
$('setup-connect').onclick = () => { $('setup-dialog').close(); page('settings'); $(active + '-channel').focus(); };
$('setup-test-voice').onclick = () => {
  $('setup-dialog').close();
  page('home');
  $('test-voice').scrollIntoView({ block: 'center' });
  $('test-voice').focus();
  $('test-voice').click();
};
$('setup-voice').onclick = () => { $('setup-dialog').close(); page('home'); document.querySelector('.reading').scrollIntoView({ block: 'center' }); $('voice').focus(); };
$('complete-setup').onclick = () => { save('pokome-setup-complete', true); $('setup-welcome').hidden = true; $('setup-dialog').close(); };
$('setup-welcome').hidden = !!storage?.getItem('pokome-setup-complete') || !!storage?.getItem('pokome-connections');
$('start-setup').onclick = () => $('setup-dialog').showModal();
$('backup-settings').onclick = () => {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportSettings(storage), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pokome-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $('backup-status').textContent = error.message; }
};
let pendingSettings = null;
$('restore-settings').onchange = async event => {
  pendingSettings = null; $('confirm-restore').disabled = true;
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 12 * 1024 * 1024) throw new Error('設定ファイルは12MB以下にしてください。');
    const settings = parseSettings(await file.text());
    if (settings['pokome-theme-v1']) compileTheme(settings['pokome-theme-v1']);
    if (settings['pokome-workspace-v1']) normalizeWorkspace(JSON.parse(settings['pokome-workspace-v1']));
    pendingSettings = settings;
    $('backup-status').textContent = '現在の接続先・音声・ユーザー設定・見た目を置き換えます。「復元する」で適用します。';
    $('confirm-restore').disabled = false;
  } catch (error) { $('backup-status').textContent = '読み込めませんでした。' + error.message; }
};
$('confirm-restore').onclick = () => {
  try { if (!pendingSettings) return; stop(); restoreSettings(storage, pendingSettings); location.reload(); }
  catch { $('backup-status').textContent = '復元できませんでした。ブラウザの保存容量・保存設定を確認してください。'; }
};
