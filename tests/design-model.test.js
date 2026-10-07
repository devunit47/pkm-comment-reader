import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_THEME_CSS_BYTES, RATIOS, defaultDesign, normalizeDesign,
  validImageRef, imageUrl, resolveStudioImages, resolveOverlayAssets, overlayOptions, normalizePresetName, validPresetId,
  defaultActorImage, normalizeActorImage, talkActorImage,
} from '../src/shared/design-model.js';
import { normalizeStudio, DEFAULT_STUDIO } from '../src/shared/studio.js';
import { normalizeOverlays, MAX_OVERLAYS } from '../src/shared/overlay-model.js';

const hash = character => character.repeat(64);
const ref = (character, extension = 'png') => `images/${hash(character)}.${extension}`;
const entry = (bytes = 1000, type = 'image/png', width = 10, height = 10) => ({ type, bytes, width, height });
const overlays = (items, assets) => ({ version: 1, items, assets });
const imageItem = (id, assetId) => ({ id, type: 'image', assetId, x: 4, y: 2, w: 30, h: 10, z: 5 });

test('preset names count graphemes without splitting families, flags, modifiers or combining marks', () => {
  for (const grapheme of ['家', '👨‍👩‍👧‍👦', '🇯🇵', '👍🏽', 'e\u0301']) {
    const exact = grapheme.repeat(40);
    assert.equal(normalizePresetName(`  ${exact}  `), exact);
    assert.throws(() => normalizePresetName(grapheme.repeat(41)), /1〜40/);
    assert.equal(normalizeDesign({ ...defaultDesign(), name: grapheme.repeat(41) }).name, exact);
  }
  assert.equal(normalizePresetName('昼／夜: <画像>'), '昼／夜: <画像>');
  for (const invalid of ['', '  ', '\n名前', '名\t前', '名\u0000前', '名\u0085前', '名\u2028前', '名\u2029前', null]) assert.throws(() => normalizePresetName(invalid));
});

test('preset IDs accept portable folder names and exclude traversal and Windows device names', () => {
  for (const id of ['portrait-chips', 'a', 'a'.repeat(64), '45b9a95d-44e6-4315-a0e7-5a931b07920c']) assert.equal(validPresetId(id), true);
  for (const id of ['', 'a'.repeat(65), '../current', 'a/b', 'a\\b', 'Portrait', 'con', 'nul', 'com1', 'lpt9', 'name:stream']) assert.equal(validPresetId(id), false);
});

test('file references for the actor, speech background and overlays survive normalization', () => {
  const images = { [ref('a')]: entry(), [ref('b', 'webp')]: entry(2000, 'image/webp'), [ref('c', 'jpg')]: entry(3000, 'image/jpeg') };
  const design = normalizeDesign({
    format: 'pokome-design', version: 2, name: '縦・下部チップ', theme: '.pokome-workspace{}',
    studio: { title: 'こんにちは', image: ref('a'), speechImage: ref('b', 'webp'), maxVisible: 8 },
    outputSize: '1080x1920',
    ratios: { '9:16': { layout: null, overlays: overlays([imageItem('item-1', 'asset-1')], { 'asset-1': ref('c', 'jpg') }) } },
  }, images);
  assert.equal(design.studio.image, ref('a'));
  assert.equal(design.studio.speechImage, ref('b', 'webp'));
  assert.equal(design.studio.title, 'こんにちは');
  assert.equal(design.studio.maxVisible, 8);
  assert.equal(design.outputSize, '1080x1920');
  assert.equal(design.name, '縦・下部チップ');
  assert.equal(design.ratios['9:16'].overlays.items.length, 1);
  assert.equal(design.ratios['9:16'].overlays.assets['asset-1'], ref('c', 'jpg'));
  assert.equal(design.ratios['16:9'], null);
  assert.equal(design.ratios['4:3'], null);
});

test('unknown, malformed, traversal, data URL and SVG references are dropped while other fields remain', () => {
  const images = { [ref('a')]: entry() };
  for (const bad of [ref('d'), 'images/../secret.png', `images/${hash('a')}.svg`, `../images/${hash('a')}.png`, `images/${hash('A')}.png`,
    'data:image/png;base64,iVBORw0KGgo=', `images/${hash('a')}.png?x=1`, `/images/${hash('a')}.png`, 'images/a.png']) {
    const design = normalizeDesign({ format: 'pokome-design', version: 2, studio: { image: bad, title: '残る' },
      ratios: { '16:9': { layout: null, overlays: overlays([imageItem('item-1', 'asset-1'), { id: 'text-1', type: 'text', text: '残る' }], { 'asset-1': bad }) } } }, images);
    assert.equal(design.studio.image, '', bad);
    assert.equal(design.studio.title, '残る');
    assert.deepEqual(design.ratios['16:9'].overlays.items.map(item => item.id), ['text-1'], bad);
  }
});

test('each image is limited to 20MB and 16 million pixels, and there is no total limit', () => {
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_IMAGE_PIXELS, 16_000_000);
  const images = {
    [ref('a')]: entry(MAX_IMAGE_BYTES), [ref('b')]: entry(MAX_IMAGE_BYTES + 1),
    [ref('c')]: entry(1000, 'image/png', 4000, 4000), [ref('d')]: entry(1000, 'image/png', 4001, 4000),
    [ref('e')]: entry(600 * 1024),
  };
  const studio = name => normalizeDesign({ format: 'pokome-design', version: 2, studio: { image: ref(name), speechImage: ref(name) } }, images).studio;
  assert.equal(studio('a').image, ref('a'));
  assert.equal(studio('a').speechImage, ref('a'));
  assert.equal(studio('b').image, '');
  assert.equal(studio('b').speechImage, '');
  assert.equal(studio('c').image, ref('c'));
  assert.equal(studio('d').image, '');
  const overlay = name => normalizeDesign({ format: 'pokome-design', version: 2, ratios: { '16:9': { layout: null, overlays: overlays([imageItem('item-1', 'asset-1')], { 'asset-1': ref(name) }) } } }, images).ratios['16:9'].overlays.items.length;
  assert.equal(overlay('e'), 1, 'a 600KB overlay is allowed');
  assert.equal(overlay('a'), 1);
  assert.equal(overlay('b'), 0);
  assert.equal(overlay('d'), 0);
  // Three 19MB images in one ratio all remain: there is no total limit.
  const large = { [ref('1')]: entry(19 * 1024 * 1024), [ref('2')]: entry(19 * 1024 * 1024), [ref('3')]: entry(19 * 1024 * 1024) };
  const three = normalizeDesign({ format: 'pokome-design', version: 2, ratios: { '16:9': { layout: null, overlays: overlays(
    ['1', '2', '3'].map((name, index) => imageItem(`item-${index}`, `asset-${index}`)),
    Object.fromEntries(['1', '2', '3'].map((name, index) => [`asset-${index}`, ref(name)]))) } } }, large);
  assert.equal(three.ratios['16:9'].overlays.items.length, 3);
  // The 21st item is still dropped.
  const many = Array.from({ length: MAX_OVERLAYS + 1 }, (_, index) => ({ id: `text-${index}`, type: 'text', text: String(index) }));
  assert.equal(normalizeDesign({ format: 'pokome-design', version: 2, ratios: { '16:9': { layout: null, overlays: overlays(many, {}) } } }, {}).ratios['16:9'].overlays.items.length, MAX_OVERLAYS);
});

test('the default data URL checks of normalizeStudio and normalizeOverlays are unchanged', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  assert.equal(normalizeStudio({ image: png }).image, png);
  assert.equal(normalizeStudio({ image: ref('a') }).image, '');
  assert.equal(normalizeOverlays(overlays([imageItem('item-1', 'asset-1')], { 'asset-1': png })).items.length, 1);
  assert.equal(normalizeOverlays(overlays([imageItem('item-1', 'asset-1')], { 'asset-1': ref('a') })).items.length, 0);
});

test('designs are validated as a whole and keep only known ratios, sizes and bounded text', () => {
  assert.throws(() => normalizeDesign({ format: 'other', version: 2 }, {}));
  assert.throws(() => normalizeDesign({ format: 'pokome-design', version: 1 }, {}));
  assert.throws(() => normalizeDesign(null, {}));
  assert.deepEqual(RATIOS, ['16:9', '9:16', '4:3']);
  const design = normalizeDesign({ format: 'pokome-design', version: 2, name: 'x'.repeat(100), theme: 42, outputSize: '1x1',
    studio: { listCount: 12, title: 'a' }, ratios: { '16:9': { layout: 'bad' }, '1:1': { layout: null }, '9:16': 'bad' } }, {});
  assert.equal(design.name.length, 40);
  assert.equal(design.theme, '');
  assert.equal(design.outputSize, '1280x720');
  assert.equal(Object.hasOwn(design.studio, 'listCount'), false);
  assert.deepEqual(Object.keys(design.ratios), RATIOS);
  assert.deepEqual(design.ratios['16:9'], { layout: null, overlays: { version: 1, items: [], assets: {} }, actorImage: defaultActorImage() });
  assert.equal(design.ratios['9:16'], null);
  assert.equal(normalizeDesign({ format: 'pokome-design', version: 2, theme: 'a'.repeat(MAX_THEME_CSS_BYTES + 1) }, {}).theme, '');
  assert.equal(normalizeDesign({ format: 'pokome-design', version: 2, theme: 'a'.repeat(MAX_THEME_CSS_BYTES) }, {}).theme.length, MAX_THEME_CSS_BYTES);
  const fallback = defaultDesign();
  assert.equal(fallback.version, 3);
  assert.deepEqual(fallback.studio, normalizeStudio());
  assert.equal(Object.hasOwn(DEFAULT_STUDIO, 'listCount'), false);
});

test('references become same-origin URLs only through the validated pattern', () => {
  assert.equal(validImageRef(ref('a')), true);
  assert.equal(validImageRef('images/"onerror.png'), false);
  assert.equal(imageUrl(ref('a')), `/api/design/current/images/${hash('a')}.png`);
  assert.equal(imageUrl('images/"x.png'), '');
  assert.equal(resolveStudioImages(normalizeStudio({ title: 't' })).image, '');
  assert.equal(imageUrl(ref('a'), 'presets/p-1'), `/api/design/presets/p-1/images/${hash('a')}.png`);
  assert.equal(imageUrl(ref('a'), '../x'), '');
  const resolved = resolveStudioImages({ ...normalizeStudio(), image: ref('a'), speechImage: ref('b') });
  assert.equal(resolved.image, `/api/design/current/images/${hash('a')}.png`);
  assert.equal(resolved.speechImage, `/api/design/current/images/${hash('b')}.png`);
  const state = resolveOverlayAssets(overlays([imageItem('item-1', 'asset-1')], { 'asset-1': ref('c') }));
  assert.equal(state.assets['asset-1'], `/api/design/current/images/${hash('c')}.png`);
  const options = overlayOptions({ [ref('a')]: entry() });
  assert.deepEqual(options.inspectAsset(ref('a')), { bytes: 1000 });
  assert.equal(options.inspectAsset(ref('b')), null);
  assert.equal(options.maxTotalBytes, Infinity);
});

// --- P1-B2: per-ratio layouts ---
import { nearestRatio, PREVIEW_SIZES, defaultTalkLayout, talkLayout, talkOverlays, withTalk, PORTRAIT_COVERED } from '../src/shared/design-model.js';
import { PANEL_IDS, normalizeLayout } from '../src/shared/workspace-model.js';
import { OUTPUT_SIZES } from '../src/shared/output-protocol.js';

test('the nearest supported ratio is chosen from a width and height', () => {
  assert.equal(nearestRatio(1920, 1080), '16:9');
  assert.equal(nearestRatio(1280, 720), '16:9');
  assert.equal(nearestRatio(1080, 1920), '9:16');
  assert.equal(nearestRatio(1440, 1080), '4:3');
  assert.equal(nearestRatio(1024, 768), '4:3');
  assert.equal(nearestRatio(390, 844), '9:16', 'a phone-shaped window is portrait');
  assert.equal(nearestRatio(1000, 1000), '4:3', 'square is closer to 4:3 than to 16:9 or 9:16');
  assert.equal(nearestRatio(0, 0), '16:9');
  assert.equal(nearestRatio(NaN, 5), '16:9');
  assert.deepEqual(Object.fromEntries(PREVIEW_SIZES.map(size => [size, nearestRatio(...size.split('x').map(Number))])),
    { '1920x1080': '16:9', '1280x720': '16:9', '960x540': '16:9', '640x360': '16:9', '1080x1920': '9:16', '1440x1080': '4:3' });
  assert.deepEqual(OUTPUT_SIZES['1440x1080'], [1440, 1080]);
});

test('each ratio has a built-in default: the grid for 16:9 and 4:3, a percentage layout for 9:16', () => {
  assert.equal(defaultTalkLayout('16:9'), null);
  assert.equal(defaultTalkLayout('4:3'), null);
  const portrait = defaultTalkLayout('9:16');
  assert.deepEqual(portrait, normalizeLayout(portrait, PANEL_IDS.talk), 'the default is already normalized');
  assert.deepEqual(portrait.panels.chat, { x: 4, y: 64, w: 92, h: 29, z: 2, hidden: false });
  // Panels do not overlap, and the speech panel fits its 220px minimum at 1920px tall.
  const order = ['header', 'actor', 'speech', 'chat', 'footer'].map(id => portrait.panels[id]);
  for (let index = 1; index < order.length; index++) assert.ok(order[index].y >= order[index - 1].y + order[index - 1].h, `panel ${index}`);
  assert.ok(portrait.panels.speech.h / 100 * 1920 >= 220);
  portrait.panels.chat.x = 50;
  assert.equal(defaultTalkLayout('9:16').panels.chat.x, 4, 'callers get a copy');
});

test('an uncreated ratio uses its own default and never another ratio', () => {
  const landscape = { panels: Object.fromEntries(PANEL_IDS.talk.map((id, index) => [id, { x: index * 10, y: 0, w: 10, h: 10, z: 1, hidden: false }])) };
  const design = withTalk(defaultDesign(), '16:9', { layout: landscape });
  assert.deepEqual(talkLayout(design, '16:9'), normalizeLayout(landscape, PANEL_IDS.talk));
  assert.deepEqual(talkLayout(design, '9:16'), defaultTalkLayout('9:16'));
  assert.equal(talkLayout(design, '4:3'), null);
  assert.deepEqual(talkOverlays(design, '9:16'), { version: 1, items: [], assets: {} });
  assert.equal(design.ratios['9:16'], null);
});

test('saving a ratio keeps the others, and returning to its default empties the entry', () => {
  const overlays = { version: 1, items: [{ id: 'text-1', type: 'text', text: '縦' }], assets: {} };
  let design = withTalk(defaultDesign(), '9:16', { overlays });
  assert.equal(design.ratios['9:16'].layout, null, 'an untouched layout stays default');
  assert.equal(design.ratios['9:16'].overlays.items.length, 1);
  assert.equal(design.ratios['16:9'], null);
  const moved = defaultTalkLayout('9:16'); moved.panels.chat.y = 60;
  design = withTalk(design, '9:16', { layout: moved });
  assert.equal(design.ratios['9:16'].layout.panels.chat.y, 60);
  assert.equal(design.ratios['9:16'].overlays.items.length, 1, 'the overlays of the ratio stay');
  design = withTalk(design, '9:16', { layout: defaultTalkLayout('9:16'), overlays: { version: 1, items: [], assets: {} } });
  assert.equal(design.ratios['9:16'], null, 'a ratio back at its default is uncreated again');
  assert.throws(() => withTalk(defaultDesign(), '1:1', {}));
});

test('only portrait has an edge guide, for app overlays that cover its top and bottom', () => {
  assert.deepEqual(PORTRAIT_COVERED, { top: 6, bottom: 10 });
});

test('actor image normalization bounds finite numbers and preserves fractional offsets', () => {
  const expected = { mode: 'theme', scale: 100, alignX: 'center', alignY: 'center', offsetX: 0, offsetY: 0, overflow: false };
  assert.deepEqual(defaultActorImage(), expected);
  for (const value of [undefined, null, [], 'custom', { mode: 'other', scale: '110', alignX: 'top', alignY: 'left', offsetX: '2', offsetY: '3', overflow: 'true' }]) {
    assert.deepEqual(normalizeActorImage(value), expected);
  }
  for (const value of [NaN, Infinity, -Infinity, '110', null]) {
    assert.deepEqual(normalizeActorImage({ scale: value, offsetX: value, offsetY: value }), expected);
  }
  assert.deepEqual(normalizeActorImage({ mode: 'custom', scale: 110.5, alignX: 'right', alignY: 'bottom', offsetX: -1.125, offsetY: 8.5, overflow: true, unknown: 'drop' }),
    { mode: 'custom', scale: 111, alignX: 'right', alignY: 'bottom', offsetX: -1.125, offsetY: 8.5, overflow: true });
  assert.deepEqual(normalizeActorImage({ scale: 90, offsetX: -101, offsetY: 101 }), { ...expected, offsetX: -100, offsetY: 100 });
  assert.equal(normalizeActorImage({ scale: 201 }).scale, 200);
  for (const alignX of ['left', 'center', 'right']) for (const alignY of ['top', 'center', 'bottom']) {
    assert.deepEqual(normalizeActorImage({ alignX, alignY }), { ...expected, alignX, alignY });
  }
  const first = defaultActorImage(); first.scale = 150;
  assert.deepEqual(defaultActorImage(), expected, 'defaults are not shared mutable state');
});

test('version 2 ignores surplus actor image settings, version 3 reads them, and unknown versions fail', () => {
  const actorImage = { mode: 'custom', scale: 110, alignX: 'left', alignY: 'bottom', offsetX: -3.5, offsetY: 8.5, overflow: true };
  const raw = { format: 'pokome-design', version: 2, theme: '.pokome-workspace .actor-figure { transform: scale(1.1); }',
    ratios: { '16:9': { actorImage }, '9:16': {} } };
  const old = normalizeDesign(raw);
  assert.equal(old.version, 3);
  assert.equal(old.theme, raw.theme);
  assert.deepEqual(talkActorImage(old, '16:9'), defaultActorImage());
  assert.deepEqual(talkActorImage(old, '9:16'), defaultActorImage());
  assert.deepEqual(talkActorImage(old, '4:3'), defaultActorImage());
  assert.equal(old.ratios['4:3'], null);
  const current = normalizeDesign({ ...raw, version: 3 });
  assert.deepEqual(talkActorImage(current, '16:9'), actorImage);
  assert.deepEqual(talkActorImage(current, '9:16'), defaultActorImage());
  const copy = talkActorImage(current, '16:9'); copy.scale = 160;
  assert.equal(talkActorImage(current, '16:9').scale, 110);
  assert.deepEqual(normalizeDesign(JSON.parse(JSON.stringify(current))), current);
  for (const version of [undefined, 1, 4, 99, '2', '3']) assert.throws(() => normalizeDesign({ ...raw, version }));
});

test('actor-image-only ratios stay separate and other updates preserve their retained theme adjustments', () => {
  const actorImage = { ...defaultActorImage(), mode: 'custom', scale: 110, alignY: 'bottom', offsetY: 1.125, overflow: true };
  const original = defaultDesign();
  let design = withTalk(original, '16:9', { actorImage });
  assert.deepEqual(design.ratios['16:9'], { layout: null, overlays: normalizeOverlays(), actorImage });
  assert.equal(original.ratios['16:9'], null);
  assert.deepEqual(talkActorImage(design, '9:16'), defaultActorImage());
  assert.deepEqual(talkActorImage(design, '4:3'), defaultActorImage());
  design = withTalk(design, '16:9', { actorImage: { ...actorImage, mode: 'theme' } });
  assert.deepEqual(talkActorImage(design, '16:9'), { ...actorImage, mode: 'theme' });
  design = normalizeDesign(JSON.parse(JSON.stringify(design)));
  const text = normalizeOverlays({ version: 1, items: [{ id: 'label', type: 'text', text: '残る' }], assets: {} });
  design = withTalk(design, '16:9', { overlays: text });
  design = withTalk(design, '16:9', { layout: { panels: { actor: { x: 20, y: 10, w: 40, h: 60, z: 2 } } } });
  assert.deepEqual(talkActorImage(design, '16:9'), { ...actorImage, mode: 'theme' });
  design = withTalk(design, '9:16', { actorImage: { ...defaultActorImage(), mode: 'custom', scale: 200 } });
  design = withTalk(design, '16:9', { actorImage: null });
  assert.deepEqual(talkActorImage(design, '16:9'), defaultActorImage());
  assert.deepEqual(talkOverlays(design, '16:9'), text);
  assert.equal(talkActorImage(design, '9:16').scale, 200);
  design = withTalk(design, '16:9', { layout: null, overlays: normalizeOverlays() });
  assert.equal(design.ratios['16:9'], null, 'only a completely default ratio returns to null');
  assert.equal(talkActorImage(design, '9:16').scale, 200);
});

test('normalized version 2 image coordinates survive conversion and saving for every ratio', () => {
  const assets = { 'asset-1': ref('a') }, images = { [ref('a')]: entry() };
  const items = [
    { ...imageItem('minimum', 'asset-1'), x: 98, y: 0, w: 2, h: 2 },
    { ...imageItem('maximum', 'asset-1'), x: 0, y: 0, w: 100, h: 100 },
    { ...imageItem('fractional', 'asset-1'), x: 12.5, y: 34.25, w: 67.125, h: 21.5 },
  ];
  const normalized = normalizeOverlays(overlays(items, assets), overlayOptions(images));
  const legacy = { format: 'pokome-design', version: 2, ratios: Object.fromEntries(RATIOS.map(ratio => [ratio, { layout: null, overlays: normalized }])) };
  const current = normalizeDesign(legacy, images);
  assert.equal(legacy.version, 2, 'reading does not mutate the input');
  for (const ratio of RATIOS) {
    assert.deepEqual(talkOverlays(current, ratio), normalized);
    assert.deepEqual(talkActorImage(current, ratio), defaultActorImage());
  }
  assert.deepEqual(normalizeDesign(JSON.parse(JSON.stringify(current)), images), current);
});
