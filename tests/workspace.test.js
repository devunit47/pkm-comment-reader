import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, PANEL_IDS, talkSpeechStyles } from '../src/shared/workspace-model.js';
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
  const panel = normalizeLayout({ panels: { chat: { x: NaN, h: Infinity, hidden: 'true' } } }, ['chat']).panels.chat;
  assert.equal(panel.x, 0); assert.equal(panel.h, 30); assert.equal(panel.hidden, false);
});
test('saved talk layouts roundtrip without carrying unrelated fields', () => {
  const panels = Object.fromEntries(PANEL_IDS.talk.map(id => [id, { x: 0, y: 0, w: 30, h: 30, z: 1, hidden: false }]));
  const state = normalizeLayout({ panels, token: 'secret' }, PANEL_IDS.talk);
  assert.deepEqual(normalizeLayout(JSON.parse(JSON.stringify(state)), PANEL_IDS.talk), state);
  assert.equal(state.token, undefined);
});

test('pinned is appended and a missing pin borrows only normalized chat geometry', () => {
  const originalIds = ['header', 'chat', 'speech', 'actor', 'footer'];
  assert.deepEqual(PANEL_IDS.talk, [...originalIds, 'pinned']);
  for (const [h, z, expectedH, expectedZ] of [[30, 5, 15, 6], [8, 99, 8, 99]]) {
    const panels = Object.fromEntries(originalIds.map((id, index) => [id, { x: index + 3, y: index + 4, w: 40, h: id === 'chat' ? h : 20, z: id === 'chat' ? z : index, hidden: id === 'chat' }]));
    const raw = { panels }, before = structuredClone(raw);
    const normalized = normalizeLayout(raw, PANEL_IDS.talk);
    assert.deepEqual(normalized.panels.pinned, { x: panels.chat.x, y: panels.chat.y, w: 40, h: expectedH, z: expectedZ, hidden: false });
    for (const id of originalIds) assert.deepEqual(normalized.panels[id], panels[id]);
    assert.deepEqual(raw, before, 'reading does not rewrite saved layouts');
    delete panels.actor;
    assert.equal(normalizeLayout(raw, PANEL_IDS.talk), null, 'only a missing pinned panel can be supplemented');
  }
});
