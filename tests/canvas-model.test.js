import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasOrder, canvasZIndex, moveCanvasTarget, layoutFromRects, copyTalkRatio, resetTalkRatio } from '../src/shared/canvas-model.js';
import { defaultDesign, defaultTalkLayout, talkLayout, talkOverlays, talkActorImage, withTalk } from '../src/shared/design-model.js';

const layout = () => defaultTalkLayout('9:16');
const overlays = () => ({ version: 1, items: [{ id: 'chat', type: 'text', z: 2 }, { id: 'picture', type: 'image', z: 0 }], assets: {} });
const keys = (l, o) => canvasOrder(l, o).map(t => `${t.kind}:${t.id}`);

test('rendered stacking keeps every tie below the next saved z', () => {
  assert.ok(canvasZIndex(1, 24) < canvasZIndex(2, 0));
  assert.ok(canvasZIndex(1, 4) < canvasZIndex(1, 5));
});

test('canvas order combines panels and overlays, retaining the fixed tie order', () => {
  assert.deepEqual(keys(layout(), overlays()), ['overlay:picture', 'panel:header', 'panel:actor', 'panel:footer', 'panel:chat', 'panel:speech', 'overlay:chat']);
  assert.deepEqual(keys(null, { items: [{ id: 'a', z: 1 }] }), ['panel:header', 'panel:chat', 'panel:speech', 'panel:actor', 'panel:footer', 'overlay:a']);
});

test('moving across tied targets changes only adjacent display order and does not mutate inputs', () => {
  const l = layout(), o = overlays(), before = structuredClone({ l, o });
  const next = moveCanvasTarget(l, o, { kind: 'panel', id: 'speech' }, 'forward');
  const expected = keys(l, o); [expected[5], expected[6]] = [expected[6], expected[5]];
  assert.deepEqual(keys(next.layout, next.overlays), expected);
  assert.deepEqual(canvasOrder(next.layout, next.overlays).map(t => t.z), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual({ l, o }, before);
});

test('moving distinct adjacent z values preserves unrelated z values', () => {
  const l = layout(), o = overlays();
  Object.values(l.panels).forEach((p, i) => { p.z = 10 + i * 10; });
  o.items[0].z = 90; o.items[1].z = 99;
  const next = moveCanvasTarget(l, o, { kind: 'overlay', id: 'picture' }, 'backward');
  assert.equal(next.overlays.items[1].z, 90);
  assert.equal(next.overlays.items[0].z, 99);
  assert.deepEqual(next.layout, l);
  assert.deepEqual(moveCanvasTarget(l, o, { kind: 'overlay', id: 'picture' }, 'forward'), { layout: l, overlays: o });
});

test('measured rectangles retain fractional coordinates relative to the rendered stage', () => {
  const rects = Object.fromEntries(['header', 'chat', 'speech', 'actor', 'footer'].map(id => [id, { left: 30.5, top: 40.5, width: 200, height: 100 }]));
  const result = layoutFromRects({ left: 10, top: 20, width: 1000, height: 500 }, rects);
  assert.ok(Math.abs(result.panels.chat.x - 2.05) < 1e-10);
  assert.ok(Math.abs(result.panels.chat.y - 4.1) < 1e-10);
  assert.deepEqual({ ...result.panels.chat, x: 0, y: 0 }, { x: 0, y: 0, w: 20, h: 20, z: 1, hidden: false });
  assert.equal(layoutFromRects({ width: 0, height: 500 }, rects), null);
  assert.equal(layoutFromRects({ left: 0, top: 0, width: 100, height: 100 }, {}), null);
});

test('ratio copy replaces only layout, overlays and actor placement with independent copies', () => {
  let design = withTalk(defaultDesign(), '9:16', { layout: layout(), overlays: overlays(), actorImage: { mode: 'custom', scale: 150 } });
  const original = structuredClone(design);
  const copied = copyTalkRatio(design, '9:16', '4:3');
  assert.deepEqual(talkLayout(copied, '4:3'), talkLayout(design, '9:16'));
  assert.deepEqual(talkOverlays(copied, '4:3'), talkOverlays(design, '9:16'));
  assert.equal(talkActorImage(copied, '4:3').scale, 150);
  assert.equal(copied.studio, design.studio);
  assert.equal(copied.outputSize, design.outputSize);
  copied.ratios['4:3'].overlays.items[0].z = 99;
  assert.deepEqual(design, original);
});

test('copying a null landscape layout preserves destination panels', () => {
  const design = withTalk(defaultDesign(), '4:3', { layout: layout() });
  const copied = copyTalkRatio(design, '16:9', '4:3');
  assert.deepEqual(talkLayout(copied, '4:3'), talkLayout(design, '4:3'));
});

test('resetting one ratio preserves its overlays, other ratios and shared appearance', () => {
  let design = withTalk(defaultDesign(), '4:3', { layout: layout(), overlays: overlays(), actorImage: { mode: 'custom', scale: 160 } });
  design = withTalk(design, '16:9', { layout: layout() });
  const reset = resetTalkRatio(design, '4:3');
  assert.equal(talkLayout(reset, '4:3'), null);
  assert.equal(talkActorImage(reset, '4:3').mode, 'theme');
  assert.deepEqual(talkOverlays(reset, '4:3'), talkOverlays(design, '4:3'));
  assert.deepEqual(reset.ratios['16:9'], design.ratios['16:9']);
  assert.equal(reset.studio, design.studio);
  assert.deepEqual(talkLayout(resetTalkRatio(design, '9:16'), '9:16'), defaultTalkLayout('9:16'));
});
