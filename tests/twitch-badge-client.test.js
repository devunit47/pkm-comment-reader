import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchBadgeClient } from '../src/browser/twitch-badge-client.js';
import { addMessage, createChatState, setPinned, clearMessages } from '../src/browser/chat-state.js';

const url = 'https://static-cdn.jtvnw.net/badges/v1/eb4a8a4c-eacd-4f5e-b9f2-394348310442/3';
const badge = { set: 'subscriber', version: '0', url: '', title: '' };
const data = room => ({ broadcasterId: room, badges: [{ ...badge, url, title: 'Subscriber' }], nextRefreshAt: 3601000 });
function fixture() {
  const state = createChatState(), pending = [], changed = [];
  let now = 1000;
  const client = createTwitchBadgeClient({ state, now: () => now, onChange: () => changed.push(true), fetchImpl: () => new Promise(resolve => pending.push(resolve)) });
  const deliver = async (room = '1', index = pending.length - 1) => { pending[index]({ ok: true, json: async () => data(room) }); await new Promise(setImmediate); };
  return { state, pending, client, changed, deliver, advance: ms => { now += ms; } };
}
test('only enabled signed-in connections with rooms request lists, and reception does not repeat requests', async () => {
  const f = fixture(); f.client.setAuth({ status: 'signed-in', login: 'viewer' }); f.client.setEnabled(true);
  assert.equal(f.pending.length, 0);
  f.client.connect(); f.client.setRoomId('1'); assert.equal(f.pending.length, 1);
  for (let i = 0; i < 10; i++) f.client.resolve({ roomId: '1', badges: [badge] });
  assert.equal(f.pending.length, 1); await f.deliver();
  assert.equal(f.client.resolve({ roomId: '1', badges: [badge] }).badges[0].url, url);
  f.advance(3600000); f.client.resolve({ roomId: '1', badges: [badge] }); assert.equal(f.pending.length, 2);
  f.client.close();
});
test('arrival updates retained selection and evicted pins without counts, first flags, timestamps or new messages', async () => {
  const f = fixture();
  const original = addMessage(f.state, 'viewer', '本文', 1, 0, 'viewer', { roomId: '1', badges: [badge] }); original.receivedAt = 42;
  f.state.selected = original; setPinned(f.state, original); f.state.messages = [];
  const other = addMessage(f.state, 'other', '別', 2, 0, 'other', { roomId: '2', badges: [badge] });
  const before = JSON.stringify({ ...f.state, selected: null, pinned: null });
  f.client.connect(); f.client.setRoomId('1'); f.client.setEnabled(true); f.client.setAuth({ status: 'signed-in', login: 'viewer' });
  await f.deliver();
  assert.equal(f.state.selected.badges[0].url, url); assert.equal(f.state.pinned.badges[0].url, url);
  assert.equal(f.state.pinned.receivedAt, 42); assert.equal(f.state.selected.first, true); assert.equal(other.badges[0].url, '');
  assert.equal(JSON.stringify({ ...f.state, selected: null, pinned: null }), before);
  f.client.setAuth({ status: 'signed-out' }); assert.equal(f.state.pinned.badges[0].url, ''); assert.equal(f.state.selected.badges[0].version, '0');
});
for (const operation of ['disconnect', 'reconnect', 'clear', 'logout', 'disable']) {
  test(`late list after ${operation} cannot update the current state`, async () => {
    const f = fixture();
    f.client.connect(); f.client.setRoomId('1'); f.client.setEnabled(true); f.client.setAuth({ status: 'signed-in', login: 'viewer' });
    const message = addMessage(f.state, 'viewer', '本文', 1, 0, 'viewer', { roomId: '1', badges: [badge] });
    if (operation === 'disconnect') f.client.disconnect();
    if (operation === 'reconnect') { f.client.disconnect(); f.client.connect(); f.client.setRoomId('1'); }
    if (operation === 'clear') { clearMessages(f.state); f.client.clear(); }
    if (operation === 'logout') f.client.setAuth({ status: 'signed-out' });
    if (operation === 'disable') f.client.setEnabled(false);
    await f.deliver('1', 0); assert.equal(message.badges[0].url, ''); assert.equal(f.changed.length, 0);
    f.client.close();
  });
}
