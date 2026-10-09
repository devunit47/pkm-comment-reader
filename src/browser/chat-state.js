import { normalizeCommentContent, normalizeCommentEvent, hasCommentUser, eventHeading, eventDetails } from '../shared/comment-model.js';
import { normalizeComment } from '../shared/output-protocol.js';
import { normalizeSpeechOptions, createSpeechHistory } from './speech-options.js';

export function createChatState() {
  return {
    messages: [], seen: new Set(), received: 0, selected: null, pinned: null,
    rules: Object.create(null), status: 'デモモード', channel: '',
    autoSpeech: true, readName: false, voice: '', volume: 0.8, rate: 1.1,
    search: '', filter: 'all', sampleIndex: 0,
    speechOptions: normalizeSpeechOptions(), speechHistory: createSpeechHistory(),
  };
}

export function addMessage(state, user, text, id, createdAt = Date.now(), login = user, identity = {}) {
  const event = normalizeCommentEvent(identity.event);
  if (typeof user !== 'string' || typeof text !== 'string' || (!text && !event)) return null;
  user = event?.anonymous ? '' : (user || login || '').slice(0, 200);
  login = event?.anonymous ? '' : String(login || '').slice(0, 200);
  const counted = !event || event.kind === 'bits';
  const date = new Date(createdAt);
  const message = {
    id, user, login, ...normalizeCommentContent({ ...identity, text }), ...(event ? { event } : {}), first: counted && !state.seen.has(user),
    time: (Number.isNaN(date.getTime()) ? new Date() : date)
      .toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
  };
  if (counted) { state.seen.add(user); state.received++; }
  state.messages.push(message);
  const limit = Number.isInteger(state.historyLimit) && state.historyLimit >= 1 && state.historyLimit <= 300 ? state.historyLimit : 300;
  if (state.messages.length > limit) state.messages.splice(0, state.messages.length - limit);
  return message;
}

export function userRule(state, user) {
  return Object.hasOwn(state.rules, user) ? state.rules[user] : {};
}

export const messageHidden = (state, message) => !!message.hidden || (hasCommentUser(message) && !!userRule(state, message.user).hidden);

export function visibleMessages(state) {
  const query = state.search.toLowerCase();
  return state.messages.filter(message =>
    !messageHidden(state, message) &&
    (state.filter !== 'first' || message.first) &&
    `${message.user} ${message.text} ${eventHeading(message.event)} ${eventDetails(message.event, message.user)}`.toLowerCase().includes(query));
}

export function clearMessages(state) {
  state.messages = [];
  state.selected = null;
  state.pinned = null;
}

export function setPinned(state, message) {
  state.pinned = message && !messageHidden(state, message) ? normalizeComment(message) : null;
  return state.pinned;
}

export function reconcilePinned(state) {
  if (!state.pinned) return false;
  const hidden = messageHidden(state, state.pinned) ||
    (state.selected?.hidden && String(state.selected.id) === state.pinned.id) ||
    state.messages.some(message => String(message.id) === state.pinned.id && message.hidden);
  if (!hidden) return false;
  state.pinned = null;
  return true;
}
