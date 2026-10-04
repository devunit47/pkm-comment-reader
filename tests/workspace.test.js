import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, normalizeWorkspace, PANEL_IDS, talkSpeechStyles } from '../workspace-model.js';
test('the speech minimum takes space only from panels starting below it', () => {
  const panel = (x, y, w, h, hidden = false) => ({ x, y, w, h, z: 1, hidden });
  const panels = { header: panel(4, 2, 92, 8), speech: panel(4, 42, 92, 20), chat: panel(4, 64, 92, 29), footer: panel(4, 94, 92, 4), actor: panel(4, 11, 92, 30) };
  const styles = talkSpeechStyles(panels, 220);
  assert.equal(styles.speech.top, 'min(42%, max(0px, calc(100% - max(20%, 220px))))');
  assert.deepEqual(styles.chat, { top: 'max(64%, calc(42% + 220px))', height: 'max(0px, calc(93% - max(64%, calc(42% + 220px))))' });
  assert.ok(styles.footer, 'lower panels move only if the minimum reaches them');
  assert.equal(styles.header, undefined); assert.equal(styles.actor, undefined);
  assert.equal(talkSpeechStyles({ ...panels, chat: panel(50, 64, 46, 29), speech: panel(4, 42, 40, 20) }, 220).chat, undefined, 'side-by-side panels are untouched');
  assert.deepEqual(Object.keys(talkSpeechStyles({ ...panels, speech: panel(4, 42, 92, 20, true) }, 220)), ['speech'], 'a hidden speech panel takes no space');
  assert.deepEqual(Object.keys(talkSpeechStyles(panels, 0)), ['speech']);
});
test('layout geometry is constrained to its responsive canvas', () => {
  const layout = normalizeLayout({ panels: { chat: { x: 90, y: -5, w: 30, h: 200, z: 1000, hidden: true } } }, ['chat']);
  assert.deepEqual(layout.panels.chat, { x: 70, y: 0, w: 30, h: 100, z: 99, hidden: true });
});
test('invalid and missing panels do not produce incomplete layouts', () => {
  assert.equal(normalizeLayout({ panels: {} }, ['chat']), null);
  assert.throws(() => normalizeWorkspace({ version: 2 }));
  assert.throws(() => normalizeWorkspace({ version: 1, talk: { panels: {} } }));
  const panel = normalizeLayout({ panels: { chat: { x: NaN, h: Infinity, hidden: 'true' } } }, ['chat']).panels.chat;
  assert.equal(panel.x, 0); assert.equal(panel.h, 30); assert.equal(panel.hidden, false);
});
test('saved layouts roundtrip without carrying unrelated fields', () => {
  const panels = Object.fromEntries(PANEL_IDS.home.map(id => [id, { x: 0, y: 0, w: 30, h: 30, z: 1, hidden: false }]));
  const state = normalizeWorkspace({ version: 1, home: { panels }, talk: null, token: 'secret' });
  assert.deepEqual(normalizeWorkspace(JSON.parse(JSON.stringify(state))), state);
  assert.equal(state.token, undefined);
});

test('removed user panel space expands the preview without overlapping settings', () => {
  const panels = {
    comments: { x: 0, y: 0, w: 65, h: 100 },
    now: { x: 67, y: 0, w: 33, h: 20 },
    reading: { x: 67, y: 22, w: 33, h: 60 },
    moderation: { x: 67, y: 84, w: 33, h: 14 },
  };
  const result = normalizeWorkspace({ version: 1, home: { panels }, talk: null });
  assert.equal(result.home.panels.now.h, 38);
  assert.equal(result.home.panels.reading.y, 40);
  assert.equal(result.home.panels.reading.y + result.home.panels.reading.h, 100);
  assert.deepEqual(normalizeWorkspace(result), result);
});
