// The stream output renders state that a control page publishes over a
// same-origin BroadcastChannel. Every received value is normalized here, so
// output.js never trusts the shape of a message from another window.
export const OUTPUT_CHANNEL = 'pokome-output-v1';
export const BACKGROUNDS = Object.freeze(['transparent', 'theme', 'key']);
export const KEY_COLORS = Object.freeze(['00ff00', 'ff00ff', '0000ff']);
export const OUTPUT_SIZES = Object.freeze({ '1920x1080': [1920, 1080], '1280x720': [1280, 720], '1080x1920': [1080, 1920], '1440x1080': [1440, 1080] });
export const HEARTBEAT_MS = 2000;
// Hidden pages may run timers only once a minute, so presence is generous and
// losing it never clears what an output has already rendered.
export const PRESENCE_MS = 70000;
export const CONTROLLER_TIMEOUT_MS = 30000;
export const MAX_OUTPUT_MESSAGES = 300;

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const identifier = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : '';
const sequence = value => Number.isSafeInteger(value) && value >= 0 ? value : -1;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 10000 ? value : 0;

export function parseOutputOptions(search = '', isObs = false) {
  const params = new URLSearchParams(search);
  const requested = params.get('background');
  const key = (params.get('key') || '').toLowerCase();
  return {
    // Plain browsers show transparency as white, which looks broken; OBS
    // browser sources should be transparent even without a query string.
    background: BACKGROUNDS.includes(requested) ? requested : isObs ? 'transparent' : 'theme',
    key: `#${KEY_COLORS.includes(key) ? key : KEY_COLORS[0]}`,
  };
}

export function outputUrl(base, { background, key } = {}) {
  const url = new URL('output.html', base);
  url.search = ''; url.hash = '';
  if (BACKGROUNDS.includes(background)) url.searchParams.set('background', background);
  const color = String(key || '').replace(/^#/, '').toLowerCase();
  if (background === 'key' && KEY_COLORS.includes(color)) url.searchParams.set('key', color);
  return url.href;
}

export function normalizeOutputPreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    background: ['theme', 'key'].includes(source.background) ? source.background : 'theme',
    key: KEY_COLORS.includes(source.key) ? source.key : KEY_COLORS[0],
    size: Object.hasOwn(OUTPUT_SIZES, source.size) ? source.size : '1280x720',
  };
}

function normalizeComment(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) ? String(value.id) : text(value.id, 64);
  const body = text(value.text, 2000);
  if (!id || !body) return null;
  return { id, user: text(value.user, 200), text: body, receivedAt: Number.isFinite(value.receivedAt) ? value.receivedAt : 0 };
}

function normalizeSpeech(value) {
  if (!value || typeof value !== 'object') return null;
  return { user: text(value.user, 200), text: text(value.text, 2000), speaking: value.speaking === true };
}

// Returns null for anything that is not a complete, known message.
export function normalizeOutputMessage(value) {
  if (!value || typeof value !== 'object' || value.v !== 1) return null;
  const { type } = value;
  if (type === 'hello' || type === 'heartbeat' || type === 'bye') {
    const id = identifier(value.id), role = value.role;
    if (!id || !['controller', 'output'].includes(role)) return null;
    if (type === 'hello' && role !== 'output') return null;
    const message = { type, id, role };
    if (role === 'output') Object.assign(message, { width: dimension(value.width), height: dimension(value.height), background: BACKGROUNDS.includes(value.background) ? value.background : '' });
    return message;
  }
  const controllerId = identifier(value.controllerId), seq = sequence(value.seq);
  if (!controllerId || seq < 0) return null;
  if (type === 'snapshot') {
    if (!Array.isArray(value.messages)) return null;
    return { type, controllerId, seq, platform: text(value.platform, 20), received: count(value.received),
      messages: value.messages.slice(-MAX_OUTPUT_MESSAGES).map(normalizeComment).filter(Boolean),
      speech: normalizeSpeech(value.speech), credit: text(value.credit, 500) };
  }
  if (type === 'append') {
    const comment = normalizeComment(value.message);
    return comment ? { type, controllerId, seq, message: comment, received: count(value.received) } : null;
  }
  if (type === 'remove') {
    if (!Array.isArray(value.ids)) return null;
    return { type, controllerId, seq, received: count(value.received), ids: value.ids.slice(0, MAX_OUTPUT_MESSAGES).map(id => typeof id === 'number' ? String(id) : text(id, 64)).filter(Boolean) };
  }
  if (type === 'speech') return { type, controllerId, seq, speech: normalizeSpeech(value.speech), credit: text(value.credit, 500) };
  return null;
}

export function createOutputView() {
  return { controllerId: '', seq: 0, lastSeen: 0, platform: '', received: 0, messages: [], speech: null, credit: '' };
}

// Pure reducer for the output page. `resync` asks the caller to send hello.
export function applyOutputMessage(view, message, now = Date.now()) {
  const result = { changed: false, resync: false };
  if (!message) return result;
  if (message.role === 'controller') {
    if (message.id === view.controllerId) {
      if (message.type === 'heartbeat') view.lastSeen = now;
      // A closed control page releases the output at once; content stays
      // until a remaining control page answers the resync with a snapshot.
      if (message.type === 'bye') { view.lastSeen = -Infinity; result.resync = true; }
    } else if (message.type === 'heartbeat' && (!view.controllerId || now - view.lastSeen >= CONTROLLER_TIMEOUT_MS)) {
      // A quiet chat sends no diffs, so another page's heartbeat must also
      // recover an output whose controller closed, crashed or never existed.
      result.resync = true;
    }
    return result;
  }
  if (!message.controllerId) return result;
  if (view.controllerId && message.controllerId !== view.controllerId) {
    if (now - view.lastSeen < CONTROLLER_TIMEOUT_MS) return result;
    if (message.type !== 'snapshot') { result.resync = true; return result; }
  }
  if (message.type === 'snapshot') {
    Object.assign(view, { controllerId: message.controllerId, seq: message.seq, lastSeen: now, platform: message.platform,
      received: message.received, messages: message.messages, speech: message.speech, credit: message.credit });
    result.changed = true;
    return result;
  }
  if (!view.controllerId || message.seq !== view.seq + 1) { result.resync = true; return result; }
  view.seq = message.seq; view.lastSeen = now;
  if (message.type === 'append') {
    view.messages.push(message.message);
    if (view.messages.length > MAX_OUTPUT_MESSAGES) view.messages.splice(0, view.messages.length - MAX_OUTPUT_MESSAGES);
    view.received = message.received;
  } else if (message.type === 'remove') {
    const ids = new Set(message.ids);
    view.messages = view.messages.filter(comment => !ids.has(comment.id));
    view.received = message.received;
  } else {
    view.speech = message.speech; view.credit = message.credit;
  }
  result.changed = true;
  return result;
}

const randomId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Control-page side. Normal updates are diffs; snapshots are sent only when an
// output asks or when the order of the visible list cannot be expressed as
// removals followed by appends.
export class OutputPublisher {
  constructor({ Channel = globalThis.BroadcastChannel, now = () => Date.now(), id = randomId(), onStatus = () => {}, setTimer = (run, ms) => globalThis.setInterval(run, ms), clearTimer = timer => globalThis.clearInterval(timer) } = {}) {
    this.id = id; this.now = now; this.onStatus = onStatus; this.clearTimer = clearTimer;
    this.seq = 0;
    this.state = { platform: '', received: 0, messages: [], speech: null, credit: '' };
    this.sentIds = null; this.sentPlatform = null; this.sentSpeech = '';
    this.outputs = new Map(); this.controllers = new Map(); this.lastStatus = '';
    this.supported = typeof Channel === 'function';
    if (!this.supported) return;
    this.channel = new Channel(OUTPUT_CHANNEL);
    this.channel.onmessage = event => this.receive(event.data);
    this.timer = setTimer(() => this.tick(), HEARTBEAT_MS);
    this.post({ type: 'heartbeat', id: this.id, role: 'controller' });
  }
  post(message) { if (this.channel) this.channel.postMessage({ v: 1, ...message }); }
  next(type, fields) { this.post({ type, controllerId: this.id, seq: ++this.seq, ...fields }); }
  snapshot() {
    const { platform, received, messages, speech, credit } = this.state;
    this.next('snapshot', { platform, received, messages, speech, credit });
    this.sentIds = messages.map(message => message.id); this.sentPlatform = platform; this.sentReceived = received;
    this.sentSpeech = JSON.stringify([speech, credit]);
  }
  update({ platform, received, messages }) {
    const list = messages.map(message => ({ id: String(message.id), user: message.user, text: message.text, receivedAt: message.receivedAt || 0 }));
    this.state = { ...this.state, platform, received, messages: list };
    if (!this.channel) return;
    if (this.sentIds === null || platform !== this.sentPlatform) { this.snapshot(); return; }
    const ids = list.map(message => message.id), current = new Set(ids);
    const removed = this.sentIds.filter(id => !current.has(id));
    const kept = this.sentIds.filter(id => current.has(id));
    if (kept.some((id, index) => ids[index] !== id)) { this.snapshot(); return; }
    const added = list.slice(kept.length);
    // A comment from a hidden user changes only the count; send it anyway.
    if (removed.length || (!added.length && received !== this.sentReceived)) this.next('remove', { ids: removed, received });
    for (const message of added) this.next('append', { message, received });
    this.sentIds = ids; this.sentReceived = received;
  }
  speech({ speech, credit }) {
    const value = speech ? { user: speech.user || '', text: speech.text || '', speaking: speech.speaking === true } : null;
    this.state = { ...this.state, speech: value, credit: credit || '' };
    const key = JSON.stringify([value, credit || '']);
    if (!this.channel || key === this.sentSpeech) return;
    this.sentSpeech = key;
    this.next('speech', { speech: value, credit: credit || '' });
  }
  receive(data) {
    const message = normalizeOutputMessage(data);
    if (!message) return;
    const now = this.now();
    if (message.role === 'output') {
      if (message.type === 'bye') this.outputs.delete(message.id);
      else this.outputs.set(message.id, { seen: now, width: message.width, height: message.height, background: message.background });
      if (message.type === 'hello') this.snapshot();
    } else if (message.role === 'controller' && message.id !== this.id) {
      if (message.type === 'bye') this.controllers.delete(message.id); else this.controllers.set(message.id, now);
    } else if (message.controllerId && message.controllerId !== this.id) this.controllers.set(message.controllerId, now);
    this.report();
  }
  status() {
    const now = this.now();
    for (const [id, output] of this.outputs) if (now - output.seen > PRESENCE_MS) this.outputs.delete(id);
    for (const [id, seen] of this.controllers) if (now - seen > PRESENCE_MS) this.controllers.delete(id);
    return { supported: this.supported, outputs: [...this.outputs.values()].map(({ width, height, background }) => ({ width, height, background })), otherControllers: this.controllers.size };
  }
  report() {
    const status = this.status(), key = JSON.stringify(status);
    if (key !== this.lastStatus) { this.lastStatus = key; this.onStatus(status); }
  }
  tick() { this.post({ type: 'heartbeat', id: this.id, role: 'controller' }); this.report(); }
  close() {
    if (!this.channel) return;
    this.post({ type: 'bye', id: this.id, role: 'controller' });
    this.clearTimer(this.timer); this.channel.close(); this.channel = null;
  }
}
