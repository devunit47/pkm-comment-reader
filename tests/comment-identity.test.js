import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTwitchMessage } from '../src/shared/connections.js';
import { addMessage, createChatState } from '../src/browser/chat-state.js';
import { normalizeOutputMessage, OutputPublisher } from '../src/shared/output-protocol.js';

const parse = (text, tags = '') => parseTwitchMessage(`@${tags} :viewer!viewer@host PRIVMSG #channel :${text}`, 'channel');
const textPart = text => ({ type: 'text', text });
const emote = (id, name) => ({ type: 'emote', id, name });

test('Twitch identity preserves emoji offsets, repeated emotes and ordered roles', () => {
  const message = parse('😀 Kappa Kappa!', 'color=#AB1234;badges=vip/1,moderator/1,subscriber/42,broadcaster/1,vip/1,unknown/1;emotes=25:2-6,8-12');
  assert.equal(message.color, '#ab1234');
  assert.deepEqual(message.badges, ['broadcaster', 'moderator', 'vip', 'subscriber']);
  assert.deepEqual(message.parts, [textPart('😀 '), emote('25', 'Kappa'), textPart(' '), emote('25', 'Kappa'), textPart('!')]);
  assert.equal(message.text, '😀 Kappa Kappa!');
});

test('bad IRC metadata keeps the complete body as text', () => {
  for (const tags of ['emotes=..bad:0-4', 'emotes=25:0-99', 'emotes=25:0-4/26:2-6', 'emotes=25:x-4', 'emotes=25:4-0', 'emotes=25:0-4,6-10']) {
    const message = parse('Kappa Other', `${tags};color=red;badges=unknown/1`);
    assert.deepEqual(message.parts, [textPart('Kappa Other')], tags);
    assert.equal(message.color, '');
    assert.deepEqual(message.badges, []);
  }
});

test('at most 100 emotes are kept without losing excess text', () => {
  const body = Array(101).fill('Kappa').join(' ');
  const ranges = Array.from({ length: 101 }, (_, i) => `${i * 6}-${i * 6 + 4}`).join(',');
  const message = parse(body, `emotes=emotesv2_safe:0-4/25:${ranges}`);
  assert.ok(message.parts.filter(part => part.type === 'emote').length <= 100);
  assert.equal(message.parts.map(part => part.text ?? part.name).join(''), body);
});

test('history counts code points and never retains half of an emote at its limit', () => {
  const state = createChatState();
  const parsed = parse('😀'.repeat(1998) + 'Kappa tail', 'emotes=25:1998-2002');
  const message = addMessage(state, parsed.user, parsed.text, 1, 0, parsed.login, parsed);
  assert.equal(message.text, '😀'.repeat(1998));
  assert.deepEqual(message.parts, [textPart(message.text)]);
  const plain = addMessage(state, 'viewer', '😀'.repeat(2001), 2);
  assert.equal([...plain.text].length, 2000);
  assert.equal(plain.text.endsWith('😀'), true);
});

test('output sync retains identity while dropping URLs, invalid IDs, colors and inconsistent parts', () => {
  const packet = identity => ({ v: 2, type: 'append', controllerId: 'safe', seq: 1, message: { id: 'one', user: 'viewer', text: 'Kappa', ...identity } });
  assert.equal(normalizeOutputMessage({ ...packet({}), v: 1 }), null);
  const valid = normalizeOutputMessage(packet({ color: '#abcdef', badges: ['subscriber', 'vip', 'vip', 'unknown'], parts: [{ ...emote('25', 'Kappa'), url: 'https://evil.example/image' }], url: 'https://evil.example' }));
  assert.equal(valid.message.color, '#abcdef');
  assert.deepEqual(valid.message.badges, ['vip', 'subscriber']);
  assert.deepEqual(valid.message.parts, [emote('25', 'Kappa')]);
  assert.equal(valid.message.url, undefined);
  for (const parts of [[emote('../bad', 'Kappa')], [emote('25', 'Other')], [{ type: 'image', url: 'https://evil.example' }]]) {
    const normalized = normalizeOutputMessage(packet({ color: 'url(x)', parts }));
    assert.deepEqual(normalized.message.parts, [textPart('Kappa')]);
    assert.equal(normalized.message.color, '');
  }
});

test('publisher sends normalized identity in snapshots and appended comments', () => {
  const packets = [];
  class Channel { postMessage(packet) { packets.push(packet); } close() {} }
  const publisher = new OutputPublisher({ Channel, id: 'control', setTimer: () => 0, clearTimer() {} });
  const first = { id: 1, ...parse('Kappa', 'color=#123456;badges=vip/1;emotes=25:0-4') };
  publisher.update({ platform: 'twitch', received: 1, messages: [first] });
  publisher.update({ platform: 'twitch', received: 2, messages: [first, { ...first, id: 2 }] });
  const snapshot = normalizeOutputMessage(packets.find(packet => packet.type === 'snapshot'));
  const appended = normalizeOutputMessage(packets.find(packet => packet.type === 'append'));
  for (const message of [snapshot.messages[0], appended.message]) {
    assert.equal(message.color, '#123456');
    assert.deepEqual(message.badges, ['vip']);
    assert.deepEqual(message.parts, [emote('25', 'Kappa')]);
  }
  publisher.close();
});
