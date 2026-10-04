import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SPEECH_OPTIONS, normalizeSpeechOptions, prepareSpeechText, createSpeechHistory, shouldAutoRead, rememberAutoRead, isSpeechUserExcluded, readSavedAutoSpeech } from '../src/browser/speech-options.js';
import { createChatState, addMessage } from '../src/browser/chat-state.js';

test('auto speech defaults on and restores explicit off separately for each service', () => {
  assert.equal(createChatState().autoSpeech, true);
  assert.deepEqual(readSavedAutoSpeech(undefined), { twitch: true, kick: true });
  assert.deepEqual(readSavedAutoSpeech({ getItem: () => '{broken' }), { twitch: true, kick: true });
  assert.deepEqual(readSavedAutoSpeech({ getItem: () => JSON.stringify({ twitch: false, kick: true }) }), { twitch: false, kick: true });
  assert.deepEqual(readSavedAutoSpeech({ getItem: () => JSON.stringify({ kick: false }) }), { twitch: true, kick: false });
  assert.deepEqual(readSavedAutoSpeech({ getItem: () => JSON.stringify({ twitch: 'false', kick: null }) }), { twitch: true, kick: true });
});

test('URL omission retains surrounding Japanese and removes URL-only messages', () => {
  const options = normalizeSpeechOptions();
  assert.equal(prepareSpeechText('こちら https://example.com/watch?v=1 を見てね', options), 'こちら を見てね');
  assert.equal(prepareSpeechText('https://example.com。ありがとう', options), '。ありがとう');
  assert.equal(prepareSpeechText('WWW.example.com/test', options), '');
  assert.equal(prepareSpeechText('(https://example.com/a).', options), '');
  assert.equal(prepareSpeechText('https://example.com', { ...options, skipUrls: false }), 'https://example.com');
});

test('limit counts visible characters without splitting emoji or combining characters', () => {
  const options = { ...DEFAULT_SPEECH_OPTIONS, maxLength: 10 };
  const text = '👨‍👩‍👧‍👦'.repeat(12);
  assert.equal(prepareSpeechText(text, options), '👨‍👩‍👧‍👦'.repeat(10));
  assert.equal(prepareSpeechText('か\u3099'.repeat(12), options), 'か\u3099'.repeat(10));
  assert.equal(prepareSpeechText('あ'.repeat(9) + ' https://long.example.com/path いろ', options), 'あ'.repeat(9) + ' ');
  const state = createChatState();
  const message = addMessage(state, 'viewer', text, 1);
  prepareSpeechText(message.text, options);
  assert.equal(message.text, text); // The displayed comment remains unchanged.
});

test('commands are optional and whitespace-only comments are skipped', () => {
  const options = { ...DEFAULT_SPEECH_OPTIONS, skipCommands: true };
  assert.equal(prepareSpeechText('  !song', options), '');
  assert.equal(prepareSpeechText('/me hello', options), '');
  assert.equal(prepareSpeechText('こんにちは！', options), 'こんにちは！');
  assert.equal(prepareSpeechText('!song', DEFAULT_SPEECH_OPTIONS), '!song');
  assert.equal(prepareSpeechText('   ', options), '');
});

test('duplicate suppression is per user and expires after 30 seconds', () => {
  const history = createSpeechHistory();
  const options = normalizeSpeechOptions();
  rememberAutoRead(history, 'alice', 'hello', 1000);
  assert.equal(shouldAutoRead(history, 'alice', 'hello', options, 29999), false);
  assert.equal(shouldAutoRead(history, 'bob', 'hello', options, 1001), true);
  assert.equal(shouldAutoRead(history, 'alice', 'different', options, 1001), true);
  assert.equal(shouldAutoRead(history, 'alice', 'hello', options, 31000), true);
  assert.equal(shouldAutoRead(history, 'alice', 'hello', { ...options, skipDuplicates: false }, 1001), true);
});

test('interval uses only accepted comments and histories remain separate by platform', () => {
  const twitch = createChatState(), kick = createChatState();
  const options = { ...DEFAULT_SPEECH_OPTIONS, userInterval: 5 };
  rememberAutoRead(twitch.speechHistory, 'alice', 'first', 1000);
  assert.equal(shouldAutoRead(twitch.speechHistory, 'alice', 'next', options, 2000), false);
  assert.equal(shouldAutoRead(kick.speechHistory, 'alice', 'next', options, 2000), true);
  assert.equal(shouldAutoRead(twitch.speechHistory, 'alice', 'next', options, 6000), true);
  assert.equal(shouldAutoRead(twitch.speechHistory, 'alice', '', options, 6000), false);
});

test('saved settings validate bounds and tolerate corrupt storage values', () => {
  assert.deepEqual(normalizeSpeechOptions(null), DEFAULT_SPEECH_OPTIONS);
  assert.deepEqual(normalizeSpeechOptions({ maxLength: -1, userInterval: Infinity, skipUrls: 'false' }), DEFAULT_SPEECH_OPTIONS);
  const saved = { maxLength: 30, skipUrls: false, skipDuplicates: false, skipCommands: true, userInterval: 5 };
  assert.deepEqual(normalizeSpeechOptions(JSON.parse(JSON.stringify(saved))), { ...DEFAULT_SPEECH_OPTIONS, ...saved });
});

test('Nightbot and broadcaster exclusions use exact account names and independent settings', () => {
  const options = normalizeSpeechOptions();
  const owner = addMessage(createChatState(), '配信者', 'hello', 1, Date.now(), 'Owner');
  assert.equal(isSpeechUserExcluded(owner, 'owner', options), true);
  assert.equal(isSpeechUserExcluded(owner, 'different_channel', options), false);
  assert.equal(isSpeechUserExcluded(owner, '', options), false);
  assert.equal(isSpeechUserExcluded(owner, 'owner', { ...options, skipBroadcaster: false }), false);
  assert.equal(isSpeechUserExcluded({ user: 'NIGHTBOT' }, 'owner', options), true);
  assert.equal(isSpeechUserExcluded({ user: 'Nightbot', login: 'viewer' }, 'owner', options), false);
  assert.equal(isSpeechUserExcluded({ user: 'nightbot_fan' }, 'owner', options), false);
  const disabled = normalizeSpeechOptions({ skipNightbot: false, skipBroadcaster: false });
  assert.equal(isSpeechUserExcluded({ user: 'Nightbot' }, 'owner', disabled), false);
  assert.equal(isSpeechUserExcluded(owner, 'owner', disabled), false);
  assert.deepEqual(normalizeSpeechOptions(JSON.parse(JSON.stringify(disabled))), disabled);
});

test('Kick emote tokens are skipped in speech without changing other platforms', () => {
  const text = 'こんにちは [emote:123:wave] またね[emote:456]';
  assert.equal(prepareSpeechText(text, DEFAULT_SPEECH_OPTIONS, 'kick'), 'こんにちは またね');
  assert.equal(prepareSpeechText('[emote:123:wave] [emote:456]', DEFAULT_SPEECH_OPTIONS, 'kick'), '');
  assert.equal(prepareSpeechText(text, DEFAULT_SPEECH_OPTIONS, 'twitch'), text);
  assert.equal(prepareSpeechText('[emote:未完了', DEFAULT_SPEECH_OPTIONS, 'kick'), '[emote:未完了');
});
