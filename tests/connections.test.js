import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatConnection, parseTwitchMessage, readSavedConnections, validChannel, connectionPresentation } from '../connections.js';
import { parseKickMessage } from '../kick.js';

test('connection labels distinguish actual subscriptions from demos, pending connections and failures', () => {
  for (const status of ['デモモード', '未接続', '接続準備中', '接続失敗', '接続エラー — 通信環境を確認してください', '切断されました — 再接続してください', '再接続が必要です']) {
    assert.notEqual(connectionPresentation(status).kind, 'connected');
  }
  assert.equal(connectionPresentation('接続中').label, '接続済み');
  assert.equal(connectionPresentation('接続中').kind, 'connected');
  assert.equal(connectionPresentation('接続準備中').kind, 'connecting');
  assert.equal(connectionPresentation('デモモード').label, '未接続・デモ');
  assert.equal(connectionPresentation('切断されました — 再接続してください').label, '切断・要再接続');
  assert.equal(connectionPresentation('チャンネル情報の取得タイムアウト').detail, 'チャンネル情報の取得タイムアウト');
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeSocket.instances.push(this); }
  send(text) { this.sent.push(text); }
  close() { this.closed = true; this.onclose?.(); }
  receive(data) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}

function client(platform, options = {}) {
  const statuses = [], messages = [], connected = [];
  const connection = new ChatConnection(platform, {
    WebSocketClass: FakeSocket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ chatroomId: 123 }) }),
    onStatus: (...values) => statuses.push(values),
    onMessage: message => messages.push(message),
    onConnected: channel => connected.push(channel), ...options,
  });
  return { connection, statuses, messages, connected };
}
const kickMessage = (room = 'chatrooms.123.v2', id = 'message-1') => ({
  event: 'App\\Events\\ChatMessageEvent', channel: room,
  data: JSON.stringify({ id, sender: { username: 'same_user' }, content: 'Kick only', created_at: '2026-10-01T10:00:00Z' }),
});

test('browser fetch retains its required global receiver', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return { ok: true, json: async () => ({ chatroomId: 123 }) };
  };
  t.after(() => { globalThis.fetch = original; });
  const kick = client('kick', { fetchImpl: undefined });
  t.after(() => kick.connection.disconnect());
  await kick.connection.connect('kick-channel');
  assert.ok(kick.connection.socket);
});

test('both sockets can receive independently; disconnecting Twitch leaves Kick connected', async t => {
  const twitch = client('twitch'), kick = client('kick');
  t.after(() => { twitch.connection.disconnect(); kick.connection.disconnect(); });
  await twitch.connection.connect('channel_one');
  await kick.connection.connect('channel-two');
  const tw = twitch.connection.socket, ki = kick.connection.socket;
  tw.onopen();
  tw.receive(':tmi.twitch.tv 366 justinfan123 #channel_one :End of /NAMES list\r\n');
  ki.receive({ event: 'pusher:connection_established', data: '{"activity_timeout":120}' });
  assert.equal(JSON.parse(ki.sent[0]).data.channel, 'chatrooms.123.v2');
  ki.receive({ event: 'pusher_internal:subscription_succeeded', channel: 'chatrooms.123.v2' });
  tw.receive(':same_user!same_user@same_user.tmi.twitch.tv PRIVMSG #channel_one :Twitch only\r\n');
  ki.receive(kickMessage());
  ki.receive(kickMessage()); // A duplicated Kick event must be displayed only once.
  ki.receive(kickMessage('chatrooms.999.v2', 'other-room'));
  assert.deepEqual(twitch.messages, [{ user: 'same_user', login: 'same_user', text: 'Twitch only' }]);
  assert.equal(kick.messages.length, 1);
  assert.equal(kick.messages[0].text, 'Kick only');
  assert.deepEqual(twitch.connected, ['channel_one']);
  assert.deepEqual(kick.connected, ['channel-two']);
  twitch.connection.disconnect();
  assert.equal(ki.closed, undefined);
  ki.receive(kickMessage('chatrooms.123.v2', 'message-2'));
  assert.equal(kick.messages.length, 2);
  ki.receive({ event: 'pusher:ping', data: {} });
  assert.equal(JSON.parse(ki.sent.at(-1)).event, 'pusher:pong');
});

test('late events from old sockets and cancelled Kick lookups are ignored', async t => {
  const twitch = client('twitch');
  t.after(() => twitch.connection.disconnect());
  await twitch.connection.connect('old_channel');
  const old = twitch.connection.socket;
  await twitch.connection.connect('new_channel');
  old.receive(':tmi.twitch.tv 366 justinfan #old_channel :End\r\n');
  old.receive(':user!user@host PRIVMSG #old_channel :obsolete\r\n');
  assert.equal(twitch.connected.length, 0);
  assert.equal(twitch.messages.length, 0);
  let resolve;
  let lookupStarted;
  const started = new Promise(done => { lookupStarted = done; });
  const kick = client('kick', { fetchImpl: () => new Promise(done => { resolve = done; lookupStarted(); }) });
  t.after(() => kick.connection.disconnect());
  const pending = kick.connection.connect('old-channel');
  await started;
  kick.connection.disconnect();
  resolve({ ok: true, json: async () => ({ chatroomId: 123 }) });
  await pending;
  assert.equal(kick.connection.socket, null);
  assert.equal(kick.connected.length, 0);
});

test('failed lookup or subscription never overwrites a successful previous connection', async t => {
  const saved = { twitch: 'previous_tw', kick: 'previous-kick' };
  const kick = client('kick', { onConnected: channel => { saved.kick = channel; } });
  t.after(() => kick.connection.disconnect());
  await kick.connection.connect('new-kick');
  kick.connection.socket.receive({ event: 'pusher:error', data: { code: 4001 } });
  assert.equal(saved.kick, 'previous-kick');
  assert.equal(saved.twitch, 'previous_tw');
  const failed = client('kick', {
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Not found' }) }),
    onConnected: channel => { saved.kick = channel; },
  });
  await failed.connection.connect('missing');
  assert.equal(failed.connection.socket, null);
  assert.equal(saved.kick, 'previous-kick');
});

test('previous connections restore separately and invalid saved values are ignored', () => {
  const saved = JSON.stringify({ twitch: 'Previous_TW', kick: 'previous-kick' });
  assert.deepEqual(readSavedConnections({ getItem: () => saved }), { twitch: 'previous_tw', kick: 'previous-kick' });
  assert.deepEqual(readSavedConnections({ getItem: () => '{invalid' }), { twitch: '', kick: '' });
  assert.deepEqual(readSavedConnections({ getItem: () => JSON.stringify({ twitch: 'https://twitch.tv/a', kick: 'safe-kick' }) }), { twitch: '', kick: 'safe-kick' });
  assert.deepEqual(readSavedConnections(undefined), { twitch: '', kick: '' });
  assert.equal(validChannel('kick', '../private'), false);
  assert.equal(validChannel('twitch', 'has-hyphen'), false);
});

test('malformed and wrong-room messages do not enter a service history', () => {
  assert.equal(parseKickMessage({ ...kickMessage(), data: '{bad' }, 'chatrooms.123.v2'), null);
  assert.equal(parseKickMessage(kickMessage(), 'chatrooms.456.v2'), null);
  assert.equal(parseTwitchMessage(':user!user@host PRIVMSG #other :hello', 'expected'), null);
  assert.deepEqual(parseTwitchMessage('@display-name=Name\\sHere :user!user@host PRIVMSG #expected :hello', 'expected'), { user: 'Name Here', login: 'user', text: 'hello' });
});

test('sender account identity survives different display names on both services', () => {
  assert.equal(parseTwitchMessage('@display-name=配信者 :owner!owner@host PRIVMSG #owner :hello', 'owner').login, 'owner');
  const event = { ...kickMessage(), data: { sender: { username: 'Display Name', slug: 'owner' }, content: 'hello' } };
  assert.equal(parseKickMessage(event, 'chatrooms.123.v2').login, 'owner');
  assert.equal(parseKickMessage(kickMessage(), 'chatrooms.123.v2').login, 'same_user');
});
