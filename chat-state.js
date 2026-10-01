export function createChatState() {
  return {
    messages: [], seen: new Set(), received: 0, selected: null,
    rules: Object.create(null), status: 'デモモード', channel: '',
    autoSpeech: false, readName: false, voice: '', volume: 0.8, rate: 1.1,
    search: '', filter: 'all', sampleIndex: 0,
  };
}

export function addMessage(state, user, text, id, createdAt = Date.now()) {
  if (typeof user !== 'string' || typeof text !== 'string' || !text) return null;
  const date = new Date(createdAt);
  const message = {
    id, user, text: text.slice(0, 2000), first: !state.seen.has(user),
    time: (Number.isNaN(date.getTime()) ? new Date() : date)
      .toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
  };
  state.seen.add(user);
  state.received++;
  state.messages.push(message);
  if (state.messages.length > 300) state.messages.shift();
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
