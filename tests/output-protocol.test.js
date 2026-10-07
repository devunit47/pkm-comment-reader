import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputPublisher, applyOutputMessage, createOutputView, normalizeOutputMessage, parseOutputOptions, outputUrl, normalizeOutputPreferences, CONTROLLER_TIMEOUT_MS, PRESENCE_MS } from '../src/shared/output-protocol.js';

class FakeChannel {
  static sent = [];
  constructor(name) { this.name = name; }
  postMessage(message) { FakeChannel.sent.push(structuredClone(message)); }
  close() {}
}
function publisher(overrides = {}) {
  let now = 1000;
  const instance = new OutputPublisher({ Channel: FakeChannel, id: 'control-a', now: () => now, setTimer: () => 0, clearTimer: () => {}, ...overrides });
  FakeChannel.sent = [];
  return { instance, advance: ms => { now += ms; } };
}
const comment = (id, text = `text ${id}`) => ({ id, user: `user${id}`, text, receivedAt: id });
// Feed published messages through the same normalization an output uses.
function replay(view, messages, now = 1000) {
  return messages.map(message => applyOutputMessage(view, normalizeOutputMessage(message), now));
}

test('background defaults to transparent only inside OBS and ignores unknown values', () => {
  assert.deepEqual(parseOutputOptions('', false), { background: 'theme', key: '#00ff00' });
  assert.deepEqual(parseOutputOptions('', true), { background: 'transparent', key: '#00ff00' });
  assert.deepEqual(parseOutputOptions('?background=key&key=FF00FF', false), { background: 'key', key: '#ff00ff' });
  assert.deepEqual(parseOutputOptions('?background=url(x)&key=123456', true), { background: 'transparent', key: '#00ff00' });
  assert.equal(outputUrl('https://example.github.io/reader/', { background: 'key', key: '0000ff' }), 'https://example.github.io/reader/output.html?background=key&key=0000ff');
  assert.equal(outputUrl('http://localhost:5173/?x=1#y', { background: 'transparent', key: '0000ff' }), 'http://localhost:5173/output.html?background=transparent');
  assert.deepEqual(normalizeOutputPreferences({ background: 'transparent', key: 'red', size: '1x1' }), { background: 'theme', key: '00ff00', size: '1280x720' });
});

test('malformed or unknown messages are rejected and text is bounded', () => {
  for (const value of [null, 'x', { v: 1, type: 'hello', id: 'a', role: 'output' }, { v: 2, type: 'eval', controllerId: 'a', seq: 1 },
    { v: 2, type: 'append', controllerId: 'a b', seq: 1, message: comment(1) }, { v: 2, type: 'append', controllerId: 'a', seq: -1, message: comment(1) },
    { v: 2, type: 'hello', id: 'a', role: 'controller' }, { v: 2, type: 'snapshot', controllerId: 'a', seq: 1, messages: 'x' }]) {
    assert.equal(normalizeOutputMessage(value), null);
  }
  const message = normalizeOutputMessage({ v: 2, type: 'append', controllerId: 'a', seq: 1, received: 1, message: { id: 7, user: 'u'.repeat(500), text: '<b>'.repeat(1000), extra: 'x' } });
  assert.equal(message.message.id, '7');
  assert.equal(message.message.user.length, 200);
  assert.equal(message.message.text.length, 2000);
  assert.equal(message.message.extra, undefined);
});

test('diffs reproduce the control list and reordering falls back to a snapshot', () => {
  const { instance } = publisher();
  const view = createOutputView();
  instance.update({ platform: 'twitch', received: 2, messages: [comment(1), comment(2)] });
  instance.update({ platform: 'twitch', received: 3, messages: [comment(1), comment(2), comment(3)] });
  instance.update({ platform: 'twitch', received: 3, messages: [comment(1), comment(3)] });
  assert.deepEqual(FakeChannel.sent.map(message => message.type), ['snapshot', 'append', 'remove']);
  replay(view, FakeChannel.sent);
  assert.deepEqual(view.messages.map(message => message.id), ['1', '3']);
  assert.equal(view.received, 3);
  // A hidden user's comment is not published, but the count still is.
  instance.update({ platform: 'twitch', received: 4, messages: [comment(1), comment(3)] });
  instance.update({ platform: 'twitch', received: 4, messages: [comment(1), comment(3)] });
  assert.deepEqual(FakeChannel.sent.map(message => message.type), ['snapshot', 'append', 'remove', 'remove']);
  replay(view, FakeChannel.sent.slice(-1));
  assert.equal(view.received, 4);
  FakeChannel.sent = [];
  // Unhiding a user reinserts older comments, which a diff cannot express.
  instance.update({ platform: 'twitch', received: 3, messages: [comment(1), comment(2), comment(3)] });
  instance.update({ platform: 'kick', received: 1, messages: [comment(9)] });
  assert.deepEqual(FakeChannel.sent.map(message => message.type), ['snapshot', 'snapshot']);
  replay(view, FakeChannel.sent);
  assert.deepEqual(view.messages.map(message => message.id), ['9']);
  assert.equal(view.platform, 'kick');
});

test('speech updates are deduplicated and a sequence gap requests a resync', () => {
  const { instance } = publisher();
  const view = createOutputView();
  instance.update({ platform: 'twitch', received: 0, messages: [] });
  instance.speech({ speech: { user: 'a', text: 'hello', speaking: true, utterance: {} }, credit: 'VOICEVOX:ずんだもん' });
  instance.speech({ speech: { user: 'a', text: 'hello', speaking: true }, credit: 'VOICEVOX:ずんだもん' });
  instance.update({ platform: 'twitch', received: 1, messages: [comment(1)] });
  assert.deepEqual(FakeChannel.sent.map(message => message.type), ['snapshot', 'speech', 'append']);
  assert.equal('utterance' in FakeChannel.sent[1].speech, false);
  const [first, , third] = FakeChannel.sent;
  const results = replay(view, [first, third]);
  assert.deepEqual(results.map(result => result.resync), [false, true]);
  assert.deepEqual(view.messages, []);
  // The output's hello makes the controller send the full state again.
  FakeChannel.sent = [];
  instance.receive({ v: 2, type: 'hello', id: 'output-1', role: 'output', width: 1280, height: 720, background: 'key' });
  replay(view, FakeChannel.sent);
  assert.deepEqual(view.messages.map(message => message.id), ['1']);
  assert.deepEqual(view.speech, { user: 'a', text: 'hello', speaking: true });
  assert.equal(view.credit, 'VOICEVOX:ずんだもん');
});

test('outputs follow one controller until it leaves or goes quiet', () => {
  const view = createOutputView();
  const snapshot = (controllerId, id) => ({ v: 2, type: 'snapshot', controllerId, seq: 1, platform: 'twitch', received: 1, messages: [comment(id)], speech: null, credit: '' });
  replay(view, [snapshot('control-a', 1)], 0);
  replay(view, [snapshot('control-b', 2)], 1000);
  assert.deepEqual(view.messages.map(message => message.id), ['1']);
  applyOutputMessage(view, normalizeOutputMessage({ v: 2, type: 'heartbeat', id: 'control-a', role: 'controller' }), 20000);
  replay(view, [snapshot('control-b', 2)], 20000 + CONTROLLER_TIMEOUT_MS - 1);
  assert.deepEqual(view.messages.map(message => message.id), ['1']);
  // Diffs from another controller ask for a snapshot once the old one is quiet.
  const [result] = replay(view, [{ v: 2, type: 'append', controllerId: 'control-b', seq: 2, received: 2, message: comment(3) }], 20000 + CONTROLLER_TIMEOUT_MS);
  assert.equal(result.resync, true);
  assert.deepEqual(view.messages.map(message => message.id), ['1']);
  // A closing controller releases the output immediately.
  applyOutputMessage(view, normalizeOutputMessage({ v: 2, type: 'heartbeat', id: 'control-a', role: 'controller' }), 60000);
  applyOutputMessage(view, normalizeOutputMessage({ v: 2, type: 'bye', id: 'control-a', role: 'controller' }), 60001);
  replay(view, [snapshot('control-b', 2)], 60002);
  assert.equal(view.controllerId, 'control-b');
  assert.deepEqual(view.messages.map(message => message.id), ['2']);
});

test('a released or quiet controller lets another controller heartbeat request a resync', () => {
  const view = createOutputView();
  const heartbeat = id => normalizeOutputMessage({ v: 2, type: 'heartbeat', id, role: 'controller' });
  // An output opened before any control page recovers from the first heartbeat.
  assert.equal(applyOutputMessage(view, heartbeat('control-a'), 1000).resync, true);
  replay(view, [{ v: 2, type: 'snapshot', controllerId: 'control-a', seq: 1, platform: 'twitch', received: 1, messages: [comment(1)], speech: null, credit: '' }], 1000);
  // While the followed controller is alive, other heartbeats are ignored.
  assert.deepEqual(applyOutputMessage(view, heartbeat('control-b'), 2000), { changed: false, resync: false });
  assert.deepEqual(applyOutputMessage(view, heartbeat('control-a'), 3000), { changed: false, resync: false });
  // Closing asks the remaining controllers for a snapshot right away.
  assert.equal(applyOutputMessage(view, normalizeOutputMessage({ v: 2, type: 'bye', id: 'control-a', role: 'controller' }), 4000).resync, true);
  assert.equal(applyOutputMessage(view, heartbeat('control-b'), 4001).resync, true);
  assert.deepEqual(view.messages.map(message => message.id), ['1']);
  // A bye from a controller the output does not follow changes nothing.
  replay(view, [{ v: 2, type: 'snapshot', controllerId: 'control-b', seq: 5, platform: 'twitch', received: 2, messages: [comment(2)], speech: null, credit: '' }], 5000);
  assert.equal(applyOutputMessage(view, normalizeOutputMessage({ v: 2, type: 'bye', id: 'control-a', role: 'controller' }), 5001).resync, false);
  // A crashed controller without bye is released after the timeout.
  assert.equal(applyOutputMessage(view, heartbeat('control-c'), 5000 + CONTROLLER_TIMEOUT_MS - 1).resync, false);
  assert.equal(applyOutputMessage(view, heartbeat('control-c'), 5000 + CONTROLLER_TIMEOUT_MS).resync, true);
});

test('controller reports outputs and other controllers with generous presence', () => {
  const statuses = [];
  const { instance, advance } = publisher({ onStatus: status => statuses.push(status) });
  instance.receive({ v: 2, type: 'heartbeat', id: 'output-1', role: 'output', width: 1920, height: 1080, background: 'transparent' });
  instance.receive({ v: 2, type: 'heartbeat', id: 'control-b', role: 'controller' });
  assert.deepEqual(statuses.at(-1), { supported: true, outputs: [{ width: 1920, height: 1080, background: 'transparent' }], otherControllers: 1 });
  advance(PRESENCE_MS - 1);
  instance.tick();
  assert.equal(statuses.at(-1).outputs.length, 1);
  advance(2);
  instance.tick();
  assert.deepEqual(statuses.at(-1), { supported: true, outputs: [], otherControllers: 0 });
  instance.close();
  assert.deepEqual(FakeChannel.sent.at(-1), { v: 2, type: 'bye', id: 'control-a', role: 'controller' });
  const unsupported = new OutputPublisher({ Channel: null });
  unsupported.update({ platform: 'twitch', received: 0, messages: [] });
  assert.equal(unsupported.status().supported, false);
});
