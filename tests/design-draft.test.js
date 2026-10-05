import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftSession, sameDesign, MAX_HISTORY } from '../src/shared/design-draft.js';
import { defaultDesign, withTalk, talkActorImage } from '../src/shared/design-model.js';

const titled = (design, title) => ({ ...design, studio: { ...design.studio, title } });

test('edits change only the draft, never the design it was opened from', () => {
  const applied = defaultDesign(), original = structuredClone(applied);
  const session = createDraftSession(applied, 'r1');
  assert.equal(session.dirty, false);
  session.change(titled(session.design, 'new'));
  assert.equal(session.design.studio.title, 'new');
  assert.equal(session.dirty, true);
  assert.equal(session.revision, 'r1');
  assert.deepEqual(applied, original);
  assert.equal(session.start.studio.title, original.studio.title);
});

test('undo and redo step through operations; a new edit drops redo', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  session.change(titled(session.design, 'a'), { label: 'タイトル' });
  session.change(titled(session.design, 'b'), { label: 'タイトル' });
  assert.deepEqual(session.undo(), { label: 'タイトル', ratio: null });
  assert.equal(session.design.studio.title, 'a');
  session.redo();
  assert.equal(session.design.studio.title, 'b');
  session.undo(); session.undo();
  assert.equal(session.dirty, false, 'undoing everything returns to the opening content');
  assert.equal(session.canRedo, true);
  session.change(titled(session.design, 'c'));
  assert.equal(session.canRedo, false);
  assert.equal(session.undo() !== null && session.undo(), null);
});

test('calls with one merge key form a single operation until sealed', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  for (const title of ['x', 'xy', 'xyz']) session.change(titled(session.design, title), { merge: 'title' });
  session.seal();
  session.change(titled(session.design, 'xyz!'), { merge: 'title' });
  session.undo();
  assert.equal(session.design.studio.title, 'xyz');
  session.undo();
  assert.equal(session.dirty, false);
  assert.equal(session.canUndo, false);
});

test('an operation that returns to where it began leaves no history', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  const opening = session.design.studio.title;
  session.change(titled(session.design, 'moved'), { merge: 'drag' });
  session.change(titled(session.design, opening), { merge: 'drag' });
  session.seal();
  assert.equal(session.canUndo, false);
  assert.equal(session.change(session.design), false, 'an unchanged design is not an edit');
});

test('a cancelled gesture restores its start without history', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  session.change(titled(session.design, 'kept'));
  session.change(titled(session.design, 'drag 1'), { merge: 'drag' });
  session.change(titled(session.design, 'drag 2'), { merge: 'drag' });
  assert.equal(session.cancelOpen(), true);
  assert.equal(session.design.studio.title, 'kept');
  session.undo();
  assert.equal(session.dirty, false);
  assert.equal(session.cancelOpen(), false);
});

test('history keeps the newest operations up to the limit, across ratios', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  for (let index = 0; index < MAX_HISTORY + 5; index++) session.change(titled(session.design, `t${index}`));
  let count = 0;
  while (session.undo()) count++;
  assert.equal(count, MAX_HISTORY);
  assert.equal(session.design.studio.title, 't4');

  const ratios = createDraftSession(defaultDesign(), 'r1');
  ratios.change(withTalk(ratios.design, '9:16', { actorImage: { mode: 'custom', scale: 150 } }), { ratio: '9:16', label: '立ち絵画像の配置' });
  ratios.change(titled(ratios.design, 'shared'));
  ratios.undo();
  assert.deepEqual(ratios.undo(), { label: '立ち絵画像の配置', ratio: '9:16' });
  assert.equal(talkActorImage(ratios.design, '9:16').mode, 'theme');
});

test('discard returns to the opening content and clears history; a stale draft stays stale', () => {
  const session = createDraftSession(defaultDesign(), 'r1');
  session.change(titled(session.design, 'gone'));
  session.discard();
  assert.equal(session.dirty, false);
  assert.equal(session.canUndo || session.canRedo, false);
  session.change(titled(session.design, 'again'));
  session.markStale();
  session.discard();
  assert.equal(session.stale, true);
  const newer = titled(defaultDesign(), 'newer');
  session.restart(newer, 'r2');
  assert.equal(session.stale, false);
  assert.equal(session.revision, 'r2');
  assert.equal(session.design.studio.title, 'newer');
  assert.equal(session.dirty, false);
});

test('content comparison ignores key order', () => {
  assert.equal(sameDesign({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }), true);
  assert.equal(sameDesign({ a: null }, { a: 0 }), false);
});
