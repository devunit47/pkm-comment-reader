import { createChatState, addMessage, userRule, visibleMessages, clearMessages } from './chat-state.js';
import { ChatConnection, readSavedConnections, validChannel, connectionPresentation } from './connections.js';
import { normalizeSpeechOptions, prepareSpeechText, shouldAutoRead, rememberAutoRead, createSpeechHistory, isSpeechUserExcluded, readSavedAutoSpeech } from './speech-options.js';
import { readStudio, normalizeStudio, readSavedVoices } from './studio.js';
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
if (publication === 'pages') {
  $('platform-help').textContent = 'Twitch専用の公開版';
  $('edition-label').textContent = 'ぽこめ Reader / Twitch版';
}
let session = 0;
let storage;
try { storage = window.localStorage; } catch { /* Storage may be disabled by the browser. */ }
const savedConnections = readSavedConnections(storage);
const savedAutoSpeech = readSavedAutoSpeech(storage);
for (const platform of Object.keys(states)) states[platform].autoSpeech = savedAutoSpeech[platform];
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
  $('connection-status').textContent = presentation.label;
  $('connection-summary').dataset.state = presentation.kind;
  $('connection-detail').textContent = presentation.detail;
  $('channel-label').textContent = state.channel ? `#${state.channel}` : '';
  $('chat-connection-status').textContent = presentation.label;
  $('chat-connection-status').dataset.state = presentation.kind;
  $('platform-pill').textContent = names[active];
  $('platform-pill').className = `pill ${active}`;
  $('stage-platform').textContent = names[active];
  $('stage-channel').textContent = state.channel ? `#${state.channel}` : '';
  $('stage-connection').textContent = presentation.label;
  $('stage-connection').dataset.state = presentation.kind;
  for (const platform of Object.keys(states)) {
    const service = states[platform];
    const view = connectionPresentation(service.status);
    for (const id of [`${platform}-status`, `${platform}-tab-status`]) {
      $(id).textContent = view.label;
      $(id).dataset.state = view.kind;
      $(id).title = view.detail;
    }
    $(`${platform}-tab-channel`).textContent = service.channel ? `#${service.channel}` : 'チャンネル未接続';
    $(`${platform}-connection-detail`).textContent = view.detail;
  }
}

function renderSelection() {
  const state = states[active];
  const message = state.selected;
  $('preview-user').textContent = message?.user || 'ぽこめ Reader';
  $('preview-text').textContent = message
    ? (isSpeechUserExcluded(message, state.channel, state.speechOptions) ? '' : prepareSpeechText(message.text, state.speechOptions)) || 'このコメントは読み上げ対象外です。'
    : `${names[active]}のコメントを待っています。`;
  $('selected-user').textContent = message?.user || 'コメントを選択してください';
  $('hide-user').disabled = !message;
  $('mute-user').disabled = !message;
  $('hide-user').textContent = message && userRule(state, message.user).hidden ? '↺ 非表示解除' : '⊘ 非表示';
  $('mute-user').textContent = message && userRule(state, message.user).muted ? '↺ 除外解除' : '◖ 読み上げ除外';
}

function render() {
  const state = states[active];
  const visible = visibleMessages(state);
  const list = $('comment-list');
  const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
  list.replaceChildren();
  for (const message of visible) {
    const row = make('button', `comment pokome-comment${state.selected?.id === message.id ? ' selected' : ''}`, '');
    row.setAttribute('aria-pressed', String(state.selected?.id === message.id));
    const name = make('span', 'username pokome-comment__author', '');
    name.append(make('span', `avatar ${active}`, active === 'kick' ? 'K' : '▣'), document.createTextNode(message.user));
    row.append(name, make('span', 'message pokome-comment__body', message.text), make('span', 'time', message.time));
    row.onclick = () => { state.selected = message; renderSelection(); render(); };
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
  if (!supported) { notify('このブラウザは読み上げに対応していません。'); return; }
  if (pendingSpeech >= 20) return;
  const state = states[active];
  if (isSpeechUserExcluded(message, state.channel, state.speechOptions)) {
    if (!automatic) notify('このユーザーは設定により読み上げ対象外です。');
    return;
  }
  const text = prepareSpeechText(message.text, state.speechOptions);
  if (!text) { if (!automatic) notify('URLのみ・コマンドなど、設定により読み上げ対象外です。'); return; }
  if (automatic && !shouldAutoRead(state.speechHistory, message.user, text, state.speechOptions)) return;
  const platform = active;
  const generation = speechGeneration;
  const utterance = new SpeechSynthesisUtterance((state.readName ? `${message.user}さん。` : '') + text);
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
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
  if (automatic) rememberAutoRead(state.speechHistory, message.user, text);
}

function stop() {
  speechGeneration++;
  clearTimeout(speechDisplayTimer);
  if (supported) window.speechSynthesis.cancel();
  pendingSpeech = 0;
  currentSpeech = null;
  renderStageSpeech();
  $('speech-status').textContent = supported ? '待機中' : 'ブラウザ非対応';
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
  for (const item of ['home', 'users', 'settings', 'studio']) $(`${item}-page`).hidden = item !== name;
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  $('page-title').textContent = { home: 'みんなの声が、ここに。', users: 'ひとりひとりを、大切に。', settings: '配信と、つながろう。', studio: 'あなたらしい、雑談の時間。' }[name];
}

function switchPlatform(platform) {
  if (!enabledPlatforms.includes(platform) || active === platform) return;
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
  $('voice').value = state.voice;
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
document.querySelectorAll('.nav').forEach(button => { button.onclick = () => page(button.dataset.page); });
$('open-settings').onclick = () => page('settings');
$('search').oninput = () => { states[active].search = $('search').value; render(); };
$('filter').onchange = () => { states[active].filter = $('filter').value; render(); };
$('hide-user').onclick = () => states[active].selected && toggleRule(states[active].selected.user, 'hidden');
$('mute-user').onclick = () => states[active].selected && toggleRule(states[active].selected.user, 'muted');
$('read-selected').onclick = () => states[active].selected ? speak(states[active].selected) : notify('コメントを選択してください。');
$('stop-speech').onclick = stop;
$('auto-speech').onchange = () => {
  states[active].autoSpeech = $('auto-speech').checked;
  save('pokome-auto-speech', { twitch: states.twitch.autoSpeech, kick: states.kick.autoSpeech });
  renderSpeechSettings();
  if (!states[active].autoSpeech) stop();
};
$('read-name').onchange = () => { states[active].readName = $('read-name').checked; };
$('voice').onchange = () => {
  stop();
  states[active].voice = $('voice').value;
  save('pokome-voices', { twitch: states.twitch.voice, kick: states.kick.voice });
};
function renderSpeechSettings() {
  const state = states[active];
  $('speech-stat').textContent = state.autoSpeech ? 'ON' : 'OFF';
  $('volume-value').textContent = `${Math.round(state.volume * 100)}%`;
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
for (const id of ['volume', 'rate']) $(id).oninput = () => {
  states[active][id] = Number($(id).value);
  renderSpeechSettings();
};
function loadVoices() {
  voices = window.speechSynthesis.getVoices();
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
if (supported) {
  loadVoices();
  window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
} else {
  for (const state of Object.values(states)) state.autoSpeech = false;
  $('auto-speech').disabled = true;
  $('speech-status').textContent = 'ブラウザ非対応';
}
$('clear').onclick = () => { clearMessages(states[active]); stop(); renderSelection(); render(); };

function renderStageChat() {
  const state = states[active];
  const messages = state.messages.filter(message => !userRule(state, message.user).hidden);
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
  stage.style.setProperty('--stage-accent', studio.accent);
  stage.style.setProperty('--stage-font-size', `${studio.fontSize}px`);
  $('stage-chat-list').dataset.commentStyle = studio.commentStyle;
  $('stage-comment-style').value = studio.commentStyle;
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
  for (const key of ['theme', 'accent', 'layout', 'source']) $(`studio-${key}`).value = studio[key];
  $('stage-font-value').textContent = `${studio.fontSize}px`;
  $('stage-font-minus').disabled = studio.fontSize <= 16;
  $('stage-font-plus').disabled = studio.fontSize >= 28;
  $('studio-list-count').value = studio.listCount;
  $('history-limit-label').textContent = `サービスごとに直近${studio.listCount}件 · 選択してユーザーを管理`;
  $('studio-actor-width').value = studio.actorWidth;
  $('studio-width-value').textContent = `${studio.actorWidth}%`;
  $('studio-decoration').checked = studio.decoration;
  $('studio-image-status').textContent = studio.image ? '立ち絵画像を登録済みです。' : '画像は未登録です。';
  $('remove-actor-image').disabled = !studio.image;
}

function enterTalk() {
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
function leaveTalk() {
  closeTextEditor?.();
  document.body.classList.remove('talk-mode');
  $('talk-stage').hidden = true;
  $('enter-talk').focus({ preventScroll: true });
}
$('enter-talk').onclick = enterTalk;
$('preview-talk').onclick = enterTalk;
$('leave-talk').onclick = leaveTalk;
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('talk-mode')) leaveTalk();
});
document.querySelectorAll('[data-stage-platform]').forEach(button => {
  button.onclick = () => switchPlatform(button.dataset.stagePlatform);
});

function updateStudio() {
  const source = $('studio-source').value;
  studio = normalizeStudio({ ...studio,
    theme: $('studio-theme').value, accent: $('studio-accent').value,
    speechFontSize: Number($('studio-speech-font-size').value),
    speechStyle: $('studio-speech-style').value, speechBackground: $('studio-speech-background').value,
    speechTextColor: $('studio-speech-text-color').value,
    layout: $('studio-layout').value,
    listCount: Number($('studio-list-count').value),
    actorWidth: Number($('studio-actor-width').value), decoration: $('studio-decoration').checked, source,
  });
  save('pokome-studio', studio);
  for (const state of Object.values(states)) {
    state.historyLimit = studio.listCount;
    if (state.messages.length > studio.listCount) state.messages.splice(0, state.messages.length - studio.listCount);
  }
  renderStudio();
  render();
}
for (const id of ['theme', 'accent', 'speech-font-size', 'speech-style', 'speech-background', 'speech-text-color', 'list-count', 'layout', 'actor-width', 'decoration', 'source']) {
  $(`studio-${id}`).onchange = updateStudio;
}
$('studio-theme').onchange = () => {
  $('studio-accent').value = { mint: '#ace5cd', rose: '#efb4c5', violet: '#c8b4f1', paper: '#527250' }[$('studio-theme').value];
  updateStudio();
};
$('studio-actor-width').oninput = () => { $('studio-width-value').textContent = `${$('studio-actor-width').value}%`; };
$('stage-comment-style').onchange = () => {
  const list = $('stage-chat-list');
  const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
  studio = normalizeStudio({ ...studio, commentStyle: $('stage-comment-style').value });
  save('pokome-studio', studio); renderStudio();
  if (bottom) list.scrollTop = list.scrollHeight;
  updateStageCommentVisibility();
};
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
    },
  });
  $(`${platform}-disconnect`).onclick = () => connections[platform].disconnect();
  $(`${platform}-connect-form`).onsubmit = async event => {
    event.preventDefault();
    const channel = $(`${platform}-channel`).value.trim().toLowerCase();
    if (!validChannel(platform, channel)) { notify('チャンネル名を確認してください。'); return; }
    clearMessages(states[platform]);
    states[platform].seen.clear();
    states[platform].received = 0;
    states[platform].speechHistory = createSpeechHistory();
    if (platform === active) { stop(); renderSelection(); render(); }
    await connections[platform].connect(channel);
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
