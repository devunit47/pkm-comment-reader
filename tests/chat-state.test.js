import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState, addMessage, visibleMessages, clearMessages, userRule, setPinned, reconcilePinned } from '../src/browser/chat-state.js';

test('retention removes oldest messages without changing received counts', () => {
  const state = createChatState(); state.historyLimit = 2;
  for (let i = 0; i < 5; i++) addMessage(state, 'viewer', `message ${i}`, i);
  assert.deepEqual(state.messages.map(message => message.id), [3, 4]);
  assert.equal(state.received, 5);
});

test('comments, counts, first appearance and user rules never cross services', () => {
  const twitch = createChatState();
  const kick = createChatState();
  addMessage(twitch, 'same_user', 'Twitch only', 1);
  addMessage(kick, 'same_user', 'Kick only', 2);
  assert.equal(twitch.messages[0].first, true);
  assert.equal(kick.messages[0].first, true);
  twitch.rules.same_user = { hidden: true, muted: true };
  assert.deepEqual(visibleMessages(twitch), []);
  assert.equal(visibleMessages(kick)[0].text, 'Kick only');
  assert.equal(userRule(kick, 'same_user').muted, undefined);
  clearMessages(twitch);
  assert.equal(kick.messages.length, 1);
  assert.equal(kick.received, 1);
  assert.equal(kick.seen.size, 1);
});

test('history limits and filters apply independently', () => {
  const twitch = createChatState();
  const kick = createChatState();
  for (let i = 0; i < 302; i++) addMessage(twitch, 'viewer', `message ${i}`, i);
  addMessage(kick, 'viewer', 'Kick hello', 400);
  assert.equal(twitch.messages.length, 300);
  assert.equal(kick.messages.length, 1);
  twitch.search = 'missing';
  assert.equal(visibleMessages(twitch).length, 0);
  assert.equal(visibleMessages(kick).length, 1);
  kick.filter = 'first';
  addMessage(kick, 'viewer', 'Second comment', 401);
  assert.deepEqual(visibleMessages(kick).map(message => message.text), ['Kick hello']);
});

test('hiding one comment leaves other messages from the same user visible', () => {
  const state = createChatState();
  const first = addMessage(state, 'viewer', 'first', 1);
  addMessage(state, 'viewer', 'second', 2);
  first.hidden = true;
  assert.deepEqual(visibleMessages(state).map(message => message.id), [2]);
  assert.deepEqual(userRule(state, 'viewer'), {});
});

test('pinning copies normalized content independently of history, selection and filters', () => {
  const state = createChatState(); state.historyLimit = 1;
  const message = addMessage(state, 'viewer', 'Kappa original', 1, 1000, 'viewer', {
    color: '#AABBCC', badges: ['moderator'], parts: [{ type: 'emote', id: '25', name: 'Kappa' }, { type: 'text', text: ' original' }],
  });
  assert.equal(state.pinned, null);
  state.selected = message;
  assert.equal(state.pinned, null);
  setPinned(state, message);
  message.parts[0].name = 'changed'; message.badges.push('vip'); message.text = 'changed';
  addMessage(state, 'other', 'newest', 2);
  state.search = 'missing'; state.filter = 'first'; state.selected = state.messages[0];
  assert.equal(reconcilePinned(state), false);
  assert.equal(state.pinned.text, 'Kappa original');
  assert.deepEqual(state.pinned.badges, ['moderator']);
  assert.equal(state.pinned.parts[0].name, 'Kappa');
  assert.equal(state.pinned.color, '#aabbcc');
  assert.equal(state.received, 2);
  assert.equal(state.messages.length, 1);
  setPinned(state, state.messages[0]);
  assert.equal(state.pinned.id, '2');
  setPinned(state, null);
  assert.equal(state.pinned, null);
});

test('hidden comments and hidden users clear pins, while muted users keep them', () => {
  const state = createChatState();
  const message = addMessage(state, 'viewer', 'first', 1);
  setPinned(state, message);
  state.rules.viewer = { muted: true };
  assert.equal(reconcilePinned(state), false);
  assert.equal(state.pinned.id, '1');
  message.hidden = true;
  assert.equal(reconcilePinned(state), true);
  assert.equal(state.pinned, null);
  setPinned(state, message);
  assert.equal(state.pinned, null);
  message.hidden = false;
  setPinned(state, message);
  state.messages = [];
  state.rules.viewer = { hidden: true };
  assert.equal(reconcilePinned(state), true);
  assert.equal(state.pinned, null);
  state.rules.viewer = {};
  assert.equal(reconcilePinned(state), false);
  assert.equal(state.pinned, null);
});

test('history clearing releases only that service pin and new states restore no pin', () => {
  const twitch = createChatState(), kick = createChatState();
  setPinned(twitch, addMessage(twitch, 'viewer', 'twitch', 1));
  setPinned(kick, addMessage(kick, 'viewer', 'kick', 2));
  clearMessages(twitch);
  assert.equal(twitch.pinned, null);
  assert.equal(kick.pinned.text, 'kick');
  assert.equal(createChatState().pinned, null);
});

test('hiding a selected pin after history retention removes it releases the pin', () => {
  const state = createChatState(); state.historyLimit = 1;
  const original = addMessage(state, 'viewer', 'pinned original', 1);
  setPinned(state, original);
  state.selected = original;
  const other = addMessage(state, 'other', 'newest', 2);
  assert.equal(state.messages.includes(original), false);
  assert.equal(reconcilePinned(state), false);
  state.selected = other; other.hidden = true;
  assert.equal(reconcilePinned(state), false);
  assert.equal(state.pinned.id, '1');
  state.selected = original; original.hidden = true;
  assert.equal(reconcilePinned(state), true);
  assert.equal(state.pinned, null);
});

test('notices share retention and search, but only PRIVMSG contributes to counts and first comments', () => {
  const state = createChatState(); state.historyLimit = 2;
  const event = { kind: 'gift', recipient: '受取人', plan: '2000' };
  const gift = addMessage(state, '贈り主', '', 1, 0, 'giver', { event });
  assert.ok(gift); assert.equal(gift.first, false); assert.equal(state.received, 0); assert.equal(state.seen.size, 0);
  state.search = '受取人'; assert.deepEqual(visibleMessages(state), [gift]);
  state.search = 'サブスクギフト'; assert.deepEqual(visibleMessages(state), [gift]);
  state.search = ''; state.filter = 'first'; assert.deepEqual(visibleMessages(state), []);
  const ordinary = addMessage(state, '贈り主', 'こんにちは', 2);
  const bits = addMessage(state, 'other', 'Cheer100', 3, 0, 'other', { event: { kind: 'bits', bits: 100 } });
  assert.equal(ordinary.first, true); assert.equal(bits.first, true); assert.equal(state.received, 2);
  assert.deepEqual(state.messages.map(message => message.id), [2, 3]);
  assert.equal(addMessage(state, 'viewer', '', 4, 0, '', { event: { kind: 'unknown' } }), null);
});

test('event pins are independent copies and anonymous notices ignore synthetic-user rules', () => {
  const state = createChatState();
  const gift = addMessage(state, '贈り主', '', 1, 0, 'giver', { event: { kind: 'gift', recipient: '受取人' } });
  state.rules['受取人'] = { hidden: true };
  setPinned(state, gift); gift.event.recipient = 'changed';
  assert.equal(state.pinned.event.recipient, '受取人'); assert.equal(reconcilePinned(state), false);
  state.rules['贈り主'] = { hidden: true }; assert.equal(reconcilePinned(state), true);
  const anonymous = addMessage(state, 'AnAnonymousGifter', '', 2, 0, 'ananonymousgifter', { event: { kind: 'gift', anonymous: true } });
  state.rules.AnAnonymousGifter = { hidden: true }; state.rules[''] = { hidden: true };
  assert.equal(anonymous.user, ''); assert.equal(anonymous.login, '');
  assert.deepEqual(visibleMessages(state), [anonymous]);
  setPinned(state, anonymous); assert.equal(reconcilePinned(state), false);
  anonymous.hidden = true; assert.equal(reconcilePinned(state), true);
  clearMessages(state); assert.equal(state.messages.length, 0);
});
