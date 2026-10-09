import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatConnection, parseTwitchMessage, readSavedConnections, validChannel, connectionPresentation } from '../src/shared/connections.js';
import { parseKickMessage } from '../src/browser/kick.js';
import { eventHeading } from '../src/shared/comment-model.js';

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
  assert.deepEqual(twitch.messages, [{ user: 'same_user', login: 'same_user', text: 'Twitch only', color: '', badges: [], parts: [{ type: 'text', text: 'Twitch only' }] }]);
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
  const saved = { connections: { twitch: 'Previous_TW', kick: 'previous-kick' } };
  assert.deepEqual(readSavedConnections(saved), { twitch: 'previous_tw', kick: 'previous-kick' });
  assert.deepEqual(readSavedConnections({ connections: null }), { twitch: '', kick: '' });
  assert.deepEqual(readSavedConnections({ connections: { twitch: 'https://twitch.tv/a', kick: 'safe-kick' } }), { twitch: '', kick: 'safe-kick' });
  assert.deepEqual(readSavedConnections(undefined), { twitch: '', kick: '' });
  assert.equal(validChannel('kick', '../private'), false);
  assert.equal(validChannel('twitch', 'has-hyphen'), false);
});

test('malformed and wrong-room messages do not enter a service history', () => {
  assert.equal(parseKickMessage({ ...kickMessage(), data: '{bad' }, 'chatrooms.123.v2'), null);
  assert.equal(parseKickMessage(kickMessage(), 'chatrooms.456.v2'), null);
  assert.equal(parseTwitchMessage(':user!user@host PRIVMSG #other :hello', 'expected'), null);
  assert.deepEqual(parseTwitchMessage('@display-name=Name\\sHere :user!user@host PRIVMSG #expected :hello', 'expected'), { user: 'Name Here', login: 'user', text: 'hello', color: '', badges: [], parts: [{ type: 'text', text: 'hello' }] });
});

test('sender account identity survives different display names on both services', () => {
  assert.equal(parseTwitchMessage('@display-name=配信者 :owner!owner@host PRIVMSG #owner :hello', 'owner').login, 'owner');
  const event = { ...kickMessage(), data: { sender: { username: 'Display Name', slug: 'owner' }, content: 'hello' } };
  assert.equal(parseKickMessage(event, 'chatrooms.123.v2').login, 'owner');
  assert.equal(parseKickMessage(kickMessage(), 'chatrooms.123.v2').login, 'same_user');
});

test('Twitch uses browser WebSocket without a local server', async () => {
  let socket;
  const statuses = [];
  class FakeSocket {
    constructor(url) { socket = this; this.url = url; this.sent = []; }
    send(value) { this.sent.push(value); }
    close() {}
  }
  const connection = new ChatConnection('twitch', {
    WebSocketClass: FakeSocket,
    fetchImpl() { throw new Error('Twitch must not need a server'); },
    onStatus: value => statuses.push(value), onMessage() {}, onConnected() {},
  });
  try {
    await connection.connect('test_channel');
    assert.equal(socket.url, 'wss://irc-ws.chat.twitch.tv:443');
    socket.onopen();
    assert.ok(socket.sent.includes('JOIN #test_channel'));
    socket.onmessage({ data: ':server 366 anon #test_channel :End of names\r\n' });
    assert.equal(statuses.at(-1), '接続中');
  } finally { connection.disconnect(false); }
});

const notice = (tags, body = '', channel = 'expected') => `@${tags} :tmi.twitch.tv USERNOTICE #${channel}${body ? ` :${body}` : ''}`;
test('Twitch notices preserve optional bodies and verified event fields without system messages', () => {
  const message = parseTwitchMessage(notice('msg-id=resub;login=viewer;display-name=Name\\sHere;msg-param-sub-plan=Prime;msg-param-cumulative-months=6;msg-param-streak-months=2;msg-param-should-share-streak=1;emotes=25:2-6;system-msg=DO_NOT_USE', '😀 Kappa'), 'expected');
  assert.deepEqual(message.event, { kind: 'resub', plan: 'Prime', cumulativeMonths: 6, streakMonths: 2 });
  assert.equal(message.user, 'Name Here');
  assert.equal(message.parts[1].name, 'Kappa');
  assert.equal(JSON.stringify(message).includes('DO_NOT_USE'), false);
  const gift = parseTwitchMessage(notice('msg-id=subgift;login=giver;msg-param-recipient-user-name=recipient;msg-param-gift-months=3;msg-param-months=12'), 'expected');
  assert.equal(gift.text, '');
  assert.deepEqual(gift.event, { kind: 'gift', recipient: 'recipient', giftMonths: 3 });
  assert.equal(parseTwitchMessage(notice('msg-id=sub;login=viewer'), 'expected').event.kind, 'sub');
  assert.equal(parseTwitchMessage(notice('msg-id=submysterygift;login=giver'), 'expected').event.kind, 'giftBomb');
});

test('invalid numeric tags, unshared streaks, other rooms and unsupported notices cannot create information', () => {
  for (const bad of ['0', '-1', '1.2', '12abc', '9007199254740992', '']) {
    const message = parseTwitchMessage(notice(`msg-id=resub;msg-param-cumulative-months=${bad};msg-param-streak-months=8;msg-param-should-share-streak=0;msg-param-sub-plan=unknown`), 'expected');
    assert.deepEqual(message.event, { kind: 'resub' });
    assert.equal(parseTwitchMessage(`@bits=${bad} :viewer!viewer@host PRIVMSG #expected :Cheer100`, 'expected').event, undefined);
  }
  assert.equal(parseTwitchMessage('@bits=100 :viewer!viewer@host PRIVMSG #expected :Cheer100', 'expected').event.bits, 100);
  for (const kind of ['raid', 'bitsbadgetier', 'announcement', 'sharedchatnotice', 'unknown', 'constructor', '__proto__']) assert.equal(parseTwitchMessage(notice(`msg-id=${kind}`, 'body'), 'expected'), null);
  assert.equal(parseTwitchMessage(notice('msg-id=sub', '', 'other'), 'expected'), null);
  assert.equal(parseTwitchMessage(notice('msg-id=sub;source-room-id=2;room-id=1'), 'expected'), null);
});

test('anonymous gift formats never expose a synthetic sender or recipient as the gifter', () => {
  for (const tags of ['msg-id=anonsubgift;login=owner', 'msg-id=subgift;user-id=274598607;login=ananonymousgifter;display-name=AnAnonymousGifter', 'msg-id=anonsubmysterygift']) {
    const message = parseTwitchMessage(notice(tags + ';msg-param-recipient-display-name=Recipient'), 'expected');
    assert.equal(message.event.anonymous, true);
    assert.equal(message.user, ''); assert.equal(message.login, '');
  }
});

test('Twitch deduplicates the last 300 received IDs per connection, retaining ID-less and individual gifts', async t => {
  const twitch = client('twitch'); t.after(() => twitch.connection.disconnect());
  await twitch.connection.connect('expected'); const socket = twitch.connection.socket;
  socket.receive(':server 366 anon #expected :End\r\n');
  const send = tags => socket.receive(notice(tags));
  send('id=bomb;msg-id=submysterygift;login=giver');
  send('id=gift;msg-id=subgift;login=giver'); send('id=gift;msg-id=subgift;login=giver');
  send('msg-id=subgift;login=giver'); send('msg-id=subgift;login=giver');
  assert.equal(twitch.messages.length, 4);
  for (let i = 0; i < 300; i++) send(`id=n${i};msg-id=sub`);
  send('id=bomb;msg-id=submysterygift'); assert.equal(twitch.messages.length, 305);
  await twitch.connection.connect('expected');
  socket.receive(notice('msg-id=sub')); assert.equal(twitch.messages.length, 305);
  twitch.connection.socket.receive(':server 366 anon #expected :End\r\n' + notice('id=bomb;msg-id=submysterygift'));
  assert.equal(twitch.messages.length, 306);
});

// Tags as recorded from a real 20-person community gift (2026-10-10); names are placeholders.
test('community gifts carry their shared id and the recorded gift count', () => {
  const mass = parseTwitchMessage(notice('msg-id=submysterygift;login=giver;display-name=Giver;msg-param-community-gift-id=1938352412556766640;msg-param-mass-gift-count=20;msg-param-sender-count=20;msg-param-sub-plan=1000'), 'expected');
  assert.deepEqual(mass.event, { kind: 'giftBomb', plan: '1000', count: 20, group: '1938352412556766640' });
  assert.equal(eventHeading(mass.event), 'まとめてギフト・Tier 1・20人');
  const single = parseTwitchMessage(notice('msg-id=subgift;login=giver;msg-param-community-gift-id=1938352412556766640;msg-param-recipient-display-name=Recipient;msg-param-gift-months=1;msg-param-sender-count=0;msg-param-sub-plan=1000'), 'expected');
  assert.deepEqual(single.event, { kind: 'gift', plan: '1000', giftMonths: 1, recipient: 'Recipient', group: '1938352412556766640' });
  for (const bad of ['', 'a\\sb', 'x'.repeat(65)]) assert.equal(parseTwitchMessage(notice(`msg-id=subgift;msg-param-community-gift-id=${bad}`), 'expected').event.group, undefined);
});
