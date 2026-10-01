import { createChatState, addMessage, userRule, visibleMessages, clearMessages } from './chat-state.js';
import { ChatConnection, readSavedConnections, validChannel } from './connections.js';
import { normalizeSpeechOptions, prepareSpeechText, shouldAutoRead, rememberAutoRead, createSpeechHistory, isSpeechUserExcluded } from './speech-options.js';

const $ = id => document.getElementById(id);
const names = { twitch: 'Twitch', kick: 'Kick' };
const states = { twitch: createChatState(), kick: createChatState() };
let active = 'twitch';
let session = 0;
let storage;
try { storage = window.localStorage; } catch { /* Storage may be disabled by the browser. */ }
const savedConnections = readSavedConnections(storage);
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
  $('connection-status').textContent = state.status;
  $('channel-label').textContent = state.channel ? `#${state.channel}` : '接続してコメントを受信';
  $('connection-dot').style.background = state.status === '接続中' ? '#ace5cd' : '#d9bd7c';
  $('platform-pill').textContent = names[active];
  $('platform-pill').className = `pill ${active}`;
  for (const platform of Object.keys(states)) {
    $(`${platform}-status`).textContent = states[platform].status;
    $(`${platform}-tab-status`).textContent = states[platform].status;
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
    const row = make('button', `comment${state.selected?.id === message.id ? ' selected' : ''}`, '');
    row.setAttribute('aria-pressed', String(state.selected?.id === message.id));
    const name = make('span', 'username', '');
    name.append(make('span', `avatar ${active}`, active === 'kick' ? 'K' : '▣'), document.createTextNode(message.user));
    row.append(name, make('span', 'message', message.text), make('span', 'time', message.time));
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
}

function add(platform, user, text, createdAt, login = user) {
  const state = states[platform];
  const message = addMessage(state, user, text, ++session, createdAt, login);
  if (!message) return;
  if (platform === active) {
    render();
    if (state.autoSpeech && !userRule(state, user).hidden && !userRule(state, user).muted) speak(message, true);
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
  };
  const done = () => {
    if (generation !== speechGeneration) return;
    pendingSpeech = Math.max(0, pendingSpeech - 1);
    if (!pendingSpeech) $('speech-status').textContent = '待機中';
  };
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
  if (automatic) rememberAutoRead(state.speechHistory, message.user, text);
}

function stop() {
  speechGeneration++;
  if (supported) window.speechSynthesis.cancel();
  pendingSpeech = 0;
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
  for (const item of ['home', 'users', 'settings']) $(`${item}-page`).hidden = item !== name;
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  $('page-title').textContent = { home: 'みんなの声が、ここに。', users: 'ひとりひとりを、大切に。', settings: '配信と、つながろう。' }[name];
}

function switchPlatform(platform) {
  if (active === platform) return;
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
  renderSpeechSettings();
  if (!states[active].autoSpeech) stop();
};
$('read-name').onchange = () => { states[active].readName = $('read-name').checked; };
$('voice').onchange = () => { states[active].voice = $('voice').value; };
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
}
if (supported) {
  loadVoices();
  window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
} else {
  $('auto-speech').disabled = true;
  $('speech-status').textContent = 'ブラウザ非対応';
}
$('clear').onclick = () => { clearMessages(states[active]); stop(); renderSelection(); render(); };

const samples = {
  twitch: [['minto_0123', 'ぽこめちゃん、はじめまして！いつも配信楽しみにしてます！'], ['sakura_pink', '今日も配信ありがとう 🌸'], ['nekotan_22', 'こんばんは〜！'], ['game_lover', 'このステージの雰囲気、すごく好き'], ['yuki_4649', '音声ちゃんと聞こえてるよ！'], ['tanaka2525', 'ナイスプレイ！！'], ['mochi_chan', 'お茶飲みながら、のんびり見てます 🍵'], ['harupeko', 'そのキャラクターかわいい！'], ['ao_ooo', '初見です！よろしくお願いします'], ['kana_night', 'きょうもおつかれさま ♡'], ['minto_0123', '次のステージも楽しみ！'], ['sakura_pink', '888888 👏']],
  kick: [['kick_viewer', 'Kickからこんにちは！'], ['green_leaf', 'こちらのチャットも見えてるよ 🌿'], ['minto_0123', 'Kickのコメントはここに届きます。']],
};
$('demo').onclick = () => {
  if (states[active].status !== 'デモモード') { notify('実接続中はデモコメントを追加できません。'); return; }
  add(active, ...samples[active][states[active].sampleIndex++ % samples[active].length]);
};

const connections = {};
for (const platform of Object.keys(states)) {
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
  for (const sample of samples[platform]) add(platform, ...sample);
  states[platform].selected = states[platform].messages[0];
}
renderSelection();
renderSpeechOptions();
render();
window.addEventListener('beforeunload', () => {
  stop();
  for (const connection of Object.values(connections)) connection.disconnect(false);
});
