import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState, addMessage, visibleMessages, clearMessages, userRule } from '../chat-state.js';

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
