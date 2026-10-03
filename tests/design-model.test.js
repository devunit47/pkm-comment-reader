import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_THEME_CSS_BYTES, RATIOS, defaultDesign, normalizeDesign,
  validImageRef, imageUrl, resolveStudioImages, resolveOverlayAssets, overlayOptions,
} from '../design-model.js';
import { normalizeStudio, DEFAULT_STUDIO } from '../studio.js';
import { normalizeOverlays, MAX_OVERLAYS } from '../overlay-model.js';

const hash = character => character.repeat(64);
const ref = (character, extension = 'png') => `images/${hash(character)}.${extension}`;
const entry = (bytes = 1000, type = 'image/png', width = 10, height = 10) => ({ type, bytes, width, height });
const overlays = (items, assets) => ({ version: 1, items, assets });
const imageItem = (id, assetId) => ({ id, type: 'image', assetId, x: 4, y: 2, w: 30, h: 10, z: 5 });

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
  assert.deepEqual(design.ratios['16:9'], { layout: null, overlays: { version: 1, items: [], assets: {} } });
  assert.equal(design.ratios['9:16'], null);
  assert.equal(normalizeDesign({ format: 'pokome-design', version: 2, theme: 'a'.repeat(MAX_THEME_CSS_BYTES + 1) }, {}).theme, '');
  assert.equal(normalizeDesign({ format: 'pokome-design', version: 2, theme: 'a'.repeat(MAX_THEME_CSS_BYTES) }, {}).theme.length, MAX_THEME_CSS_BYTES);
  const fallback = defaultDesign();
  assert.equal(fallback.version, 2);
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
