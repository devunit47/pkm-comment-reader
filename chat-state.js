import { normalizeSpeechOptions, createSpeechHistory } from './speech-options.js';

export function createChatState() {
  return {
    messages: [], seen: new Set(), received: 0, selected: null,
    rules: Object.create(null), status: 'デモモード', channel: '',
    autoSpeech: true, readName: false, voice: '', volume: 0.8, rate: 1.1,
    search: '', filter: 'all', sampleIndex: 0,
    speechOptions: normalizeSpeechOptions(), speechHistory: createSpeechHistory(),
  };
}

export function addMessage(state, user, text, id, createdAt = Date.now(), login = user) {
  if (typeof user !== 'string' || typeof text !== 'string' || !text) return null;
  const date = new Date(createdAt);
  const message = {
    id, user, login, text: text.slice(0, 2000), first: !state.seen.has(user),
    time: (Number.isNaN(date.getTime()) ? new Date() : date)
      .toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
  };
  state.seen.add(user);
  state.received++;
  state.messages.push(message);
  const limit = Number.isInteger(state.historyLimit) && state.historyLimit >= 1 && state.historyLimit <= 300 ? state.historyLimit : 300;
  if (state.messages.length > limit) state.messages.splice(0, state.messages.length - limit);
  return message;
}

export function userRule(state, user) {
  return Object.hasOwn(state.rules, user) ? state.rules[user] : {};
}

export function visibleMessages(state) {
  const query = state.search.toLowerCase();
  return state.messages.filter(message =>
    !userRule(state, message.user).hidden &&
    (state.filter !== 'first' || message.first) &&
    `${message.user} ${message.text}`.toLowerCase().includes(query));
}

export function clearMessages(state) {
  state.messages = [];
  state.selected = null;
}
