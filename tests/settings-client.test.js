import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore } from '../src/browser/settings-client.js';
import { normalizeSettings } from '../src/shared/settings-model.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const reply = (status, value) => ({ status, ok: status < 400, json: async () => structuredClone(value) });
class Events {
  static last;
  constructor(url) { assert.equal(url, '/api/settings/events'); Events.last = this; this.listeners = {}; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  emit(type, data = {}) { for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
function fakeServer() {
  let current = { settings: normalizeSettings(), revision: 'default', writable: true, warning: '' }, count = 0;
  const requests = [], holds = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === '/api/settings') return reply(200, current);
    const hold = holds.shift();
    if (hold) await hold.promise;
    if (!current.writable) return reply(422, { error: current.warning, writable: false });
    const field = url.split('/').at(-1);
    current = { ...current, settings: normalizeSettings({ ...current.settings, [field]: JSON.parse(options.body) }), revision: `r${++count}` };
    return reply(200, current);
  };
  return { fetchImpl, requests, holds, get current() { return current; },
    external(fields) { current = { ...current, settings: normalizeSettings({ ...current.settings, ...fields }), revision: `r${++count}` }; } };
}

test('startup normalizes server settings without saving and writes only a chosen field', async () => {
  const server = fakeServer();
  server.external({ connections: { twitch: 'Channel', kick: '?' }, historyLimit: 20 });
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, watch: false });
  assert.deepEqual(store.settings.connections, { twitch: 'channel', kick: '' });
  assert.equal(server.requests.length, 1);
  await store.set('historyLimit', 30);
  assert.equal(server.requests[1].url, '/api/settings/historyLimit');
  assert.equal(server.requests[1].method, 'PUT');
  assert.equal(server.requests[1].body, '30');
  assert.equal(store.settings.historyLimit, 30);
  assert.equal(store.settings.connections.twitch, 'channel');
  await assert.rejects(store.set('theme', 'x'), /設定項目/);
});

test('unreadable originals and unreachable servers refuse writes without changing defaults', async () => {
  const server = fakeServer();
  Object.assign(server.current, { writable: false, warning: '設定ファイルを読めません。原本を退避してください。' });
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, watch: false });
  assert.equal(store.writable, false);
  await assert.rejects(store.set('historyLimit', 12), /退避/);
  assert.equal(server.requests.length, 1);
  const offline = await createSettingsStore({ fetchImpl: async () => { throw new Error('接続できません。'); }, watch: false });
  assert.equal(offline.writable, false);
  assert.match(offline.warning, /接続できません/);
  await assert.rejects(offline.set('historyLimit', 12), /ローカルサーバー/);
});

test('queued saves keep optimistic values while another field changes externally', async () => {
  const server = fakeServer();
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, EventSourceClass: Events });
  const hold = gate(); server.holds.push(hold);
  const first = store.set('historyLimit', 25);
  const second = store.set('autoSpeech', { twitch: false, kick: true });
  assert.equal(store.settings.historyLimit, 25);
  assert.equal(store.settings.autoSpeech.twitch, false);
  server.external({ users: { twitch: { reader: { hidden: true } }, kick: {} } });
  Events.last.emit('change', { revision: server.current.revision });
  await tick();
  hold.release(); await Promise.all([first, second]); await tick();
  assert.equal(store.settings.historyLimit, 25);
  assert.equal(store.settings.autoSpeech.twitch, false);
  assert.equal(store.settings.users.twitch.reader.hidden, true);
  assert.deepEqual(server.requests.filter(request => request.method === 'PUT').map(request => request.url), ['/api/settings/historyLimit', '/api/settings/autoSpeech']);
});

test('a failed save rolls back its field and retains a later queued edit', async () => {
  const server = fakeServer();
  let fail = true;
  const store = await createSettingsStore({ fetchImpl: async (url, options) => {
    if (options?.method === 'PUT' && fail) { fail = false; return reply(503, { error: '書き込めません。' }); }
    return server.fetchImpl(url, options);
  }, watch: false });
  const first = store.set('historyLimit', 9);
  const second = store.set('setupComplete', true);
  await assert.rejects(first, /書き込めません/); await second;
  assert.equal(store.settings.historyLimit, 300);
  assert.equal(store.settings.setupComplete, true);
});

test('an earlier response never erases a newer pending edit to the same field', async () => {
  const server = fakeServer();
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, watch: false });
  const firstHold = gate(), secondHold = gate(); server.holds.push(firstHold, secondHold);
  const first = store.set('historyLimit', 11);
  const second = store.set('historyLimit', 12);
  firstHold.release(); await first;
  assert.equal(store.settings.historyLimit, 12);
  secondHold.release(); await second;
  assert.equal(server.current.settings.historyLimit, 12);
});

test('external changes and the first stream connection catch up without losing unsaved fields', async () => {
  const server = fakeServer();
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, EventSourceClass: Events });
  const updates = [];
  store.subscribe(detail => updates.push(detail));
  server.external({ setupComplete: true, connections: { twitch: 'another', kick: '' } });
  Events.last.emit('open'); await tick();
  assert.equal(store.settings.setupComplete, true);
  assert.equal(store.settings.connections.twitch, 'another');
  assert.deepEqual(updates.at(-1).fields.sort(), ['connections', 'setupComplete']);
  server.external({ output: { background: 'key', key: 'ff00ff' } });
  Events.last.emit('change', { revision: server.current.revision }); await tick();
  assert.equal(store.settings.output.key, 'ff00ff');
  store.close(); assert.equal(Events.last.closed, true);
});

test('a protected save response refreshes the warning and refuses later writes', async () => {
  const server = fakeServer();
  const store = await createSettingsStore({ fetchImpl: server.fetchImpl, watch: false });
  Object.assign(server.current, { writable: false, revision: 'broken', warning: '設定ファイルを読めません。' });
  await assert.rejects(store.set('historyLimit', 12), /設定ファイル/);
  assert.equal(store.writable, false);
  assert.equal(store.settings.historyLimit, 300);
  await assert.rejects(store.set('setupComplete', true), /設定ファイル/);
});
