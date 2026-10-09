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
