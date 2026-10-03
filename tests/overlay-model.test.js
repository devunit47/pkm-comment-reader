import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAYS_KEY, MAX_OVERLAYS, MAX_OVERLAY_TEXT, MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_TOTAL_ASSET_BYTES, MAX_OVERLAY_PIXELS, MAX_OVERLAYS_SERIALIZED_LENGTH,
  normalizeOverlays, readOverlays, createOverlay, removeOverlay, pruneOverlayAssets,
  addOverlayAsset, inspectOverlayImage, readOverlayImage,
} from '../overlay-model.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(png.split(',')[1], 'base64');
const envelope = (items = [], assets = {}) => ({ version: 1, items, assets });
const textItem = (overrides = {}) => ({ id: 'text-one', type: 'text', ...overrides });
const imageItem = (id = 'image-one', assetId = 'asset-one') => ({ id, type: 'image', assetId });
const dataURL = (bytes, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;
function sizedPNG(width, height, byteLength = pngBytes.length) {
  const bytes = Buffer.alloc(byteLength); pngBytes.copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return dataURL(bytes);
}

test('blank overlays and defensive storage reads stay separate from existing settings', () => {
  assert.deepEqual(normalizeOverlays(), envelope());
  assert.deepEqual(normalizeOverlays(null), envelope());
  assert.deepEqual(readOverlays(), envelope());
  assert.deepEqual(readOverlays({ getItem() { throw new Error('denied'); } }), envelope());
  for (const saved of ['{broken', 'null', '[]', '{"version":2}', 'x'.repeat(MAX_OVERLAYS_SERIALIZED_LENGTH + 1)]) {
    assert.deepEqual(readOverlays({ getItem: () => saved }), envelope());
  }
  assert.throws(() => normalizeOverlays({ version: 2 }));
  assert.deepEqual(readOverlays({ getItem(key) { assert.equal(key, OVERLAYS_KEY); return JSON.stringify(envelope()); } }), envelope());
});

test('overlay geometry, text, colors, booleans and ordering are bounded', () => {
  const result = normalizeOverlays(envelope([textItem({ x: 99, y: -1, w: 120, h: 1, z: 110, hidden: 'true', fontSize: 500, text: 'a'.repeat(1200), color: 'url(x)', unexpected: 'ignored' })]));
  assert.deepEqual(result.items[0], {
    id: 'text-one', type: 'text', x: 0, y: 0, w: 100, h: 2, z: 99, hidden: false,
    fontSize: 160, text: 'a'.repeat(MAX_OVERLAY_TEXT), color: '#ffffff', assetId: '',
  });
  const fallback = normalizeOverlays(envelope([textItem({ x: NaN, y: Infinity, w: '50', h: undefined, z: -4, fontSize: 0, color: '#Ab12Ef', hidden: true })])).items[0];
  assert.equal(fallback.x, 5); assert.equal(fallback.y, 5); assert.equal(fallback.w, 30); assert.equal(fallback.h, 12);
  assert.equal(fallback.fontSize, 12); assert.equal(fallback.z, 0); assert.equal(fallback.color, '#Ab12Ef'); assert.equal(fallback.hidden, true);
  assert.deepEqual(normalizeOverlays(JSON.parse(JSON.stringify(result))), result);
});

test('invalid IDs and duplicates are dropped without unsafe object references', () => {
  const state = JSON.parse('{"version":1,"items":[{"id":"valid","type":"text"},{"id":"valid","type":"image","assetId":"asset-one"},{"id":"__proto__","type":"text"},{"id":"constructor","type":"text"},{"id":"x y","type":"text"},{"id":"<script>","type":"text"},{"id":"other","type":"html"}],"assets":{"__proto__":"no"}}');
  assert.deepEqual(normalizeOverlays(state).items.map(item => item.id), ['valid']);
  const inherited = Object.create({ 'asset-one': png });
  assert.deepEqual(normalizeOverlays(envelope([imageItem()], inherited)), envelope());
  const tooMany = Array.from({ length: MAX_OVERLAYS + 5 }, (_, index) => textItem({ id: `overlay-${index}` }));
  assert.equal(normalizeOverlays(envelope(tooMany)).items.length, MAX_OVERLAYS);
});

test('saved assets require raster signatures and bounded valid dimensions', () => {
  assert.deepEqual(inspectOverlayImage(png), { mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1 });
  for (const unsafe of [
    'https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4=',
    png.replace('image/png', 'image/jpeg'), `${png}abc`, png.replace(';base64,', ';charset=utf-8;base64,'),
    sizedPNG(0, 100), sizedPNG(MAX_OVERLAY_PIXELS + 1, 1), sizedPNG(1, 1, MAX_OVERLAY_ASSET_BYTES + 1),
  ]) assert.equal(inspectOverlayImage(unsafe), null, unsafe.slice(0, 60));
  assert.equal(inspectOverlayImage(sizedPNG(4000, 4000)).width, 4000);
  const clean = normalizeOverlays(envelope([imageItem(), imageItem('bad', 'missing'), textItem()], { 'asset-one': png, unused: png, bad: 'https://example.com/a.png' }));
  assert.equal(clean.items.length, 2);
  assert.deepEqual(Object.keys(clean.assets), ['asset-one']);
});

test('GIF, JPEG including padded input and WebP use format-specific dimension sniffing', () => {
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 240, 1, 64, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const paddedJPEG = Buffer.concat([jpeg, Buffer.alloc(100)]);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp.writeUIntLE(319, 24, 3); webp.writeUIntLE(239, 27, 3);
  for (const [bytes, type] of [[gif, 'gif'], [jpeg, 'jpeg'], [paddedJPEG, 'jpeg'], [webp, 'webp']]) {
    const info = inspectOverlayImage(dataURL(bytes, type));
    assert.equal(info.width, 320, type); assert.equal(info.height, 240, type);
    assert.equal(inspectOverlayImage(dataURL(bytes.subarray(0, 10), type)), null, type);
  }
  const lossless = Buffer.alloc(26); lossless.write('RIFF'); lossless.writeUInt32LE(18, 4); lossless.write('WEBPVP8L', 8); lossless.writeUInt32LE(5, 16); lossless[20] = 0x2f;
  assert.equal(inspectOverlayImage(dataURL(lossless, 'webp')).width, 1);
  const lossy = Buffer.alloc(30); lossy.write('RIFF'); lossy.writeUInt32LE(22, 4); lossy.write('WEBPVP8 ', 8); lossy.writeUInt32LE(10, 16); lossy.set([0x9d, 0x01, 0x2a], 23); lossy.writeUInt16LE(320, 26); lossy.writeUInt16LE(240, 28);
  assert.equal(inspectOverlayImage(dataURL(lossy, 'webp')).height, 240);
});

test('image storage has a shared 2MiB budget, not a budget per overlay reference', () => {
  const items = [], assets = {};
  for (let index = 0; index < 5; index++) {
    const id = `asset-${index}`; assets[id] = sizedPNG(index + 1, 1, MAX_OVERLAY_ASSET_BYTES); items.push(imageItem(`image-${index}`, id));
  }
  items.push(imageItem('reused', 'asset-0'));
  const result = normalizeOverlays(envelope(items, assets));
  assert.equal(result.items.length, 5); assert.equal(Object.keys(result.assets).length, 4);
  assert.equal(Object.values(result.assets).reduce((total, asset) => total + inspectOverlayImage(asset).bytes, 0), MAX_OVERLAY_TOTAL_ASSET_BYTES);
  assert.throws(() => addOverlayAsset(result, png), /2MB/);
});

test('creation, asset addition and deletion preserve safe IDs and prune only unused bytes', () => {
  const first = createOverlay('text');
  const next = createOverlay('text', { id: first.id, color: '#abcdef' }, [first]);
  assert.notEqual(first.id, next.id); assert.match(first.id, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  assert.equal(next.color, '#abcdef');
  assert.throws(() => createOverlay('script'));
  assert.throws(() => createOverlay('text', {}, Array(MAX_OVERLAYS).fill(first)));
  const added = addOverlayAsset(envelope(), png, '__proto__');
  assert.notEqual(added.assetId, '__proto__');
  const image = createOverlay('image', { assetId: added.assetId }, [first]);
  const state = normalizeOverlays({ ...added.state, items: [first, image] });
  assert.equal(state.items.length, 2);
  assert.equal(addOverlayAsset(state, png).assetId, added.assetId);
  const shared = { ...state, items: [...state.items, { ...image, id: 'image-copy' }] };
  assert.equal(Object.keys(removeOverlay(shared, image.id).assets).length, 1);
  assert.deepEqual(removeOverlay(state, image.id).assets, {});
  assert.deepEqual(pruneOverlayAssets({ ...state, assets: { ...state.assets, orphan: png } }), state);
  assert.throws(() => addOverlayAsset(state, 'data:image/svg+xml;base64,PHN2Zz4='));
});

function imageEnvironment({ result = png, width = 1, height = 1, failRead = false, failDecode = false } = {}) {
  return {
    FileReader: class {
      readAsDataURL() { queueMicrotask(() => { this.result = result; if (failRead) this.onerror(); else this.onload(); }); }
    },
    Image: class {
      naturalWidth = width; naturalHeight = height;
      async decode() { if (failDecode) throw new Error('bad image'); }
    },
  };
}

test('browser upload helper requires byte, MIME, header and successful decode validation', async () => {
  const file = { type: 'image/png', size: pngBytes.length };
  assert.equal(await readOverlayImage(file, imageEnvironment()), png);
  await assert.rejects(readOverlayImage({ ...file, type: 'image/svg+xml' }, imageEnvironment()));
  await assert.rejects(readOverlayImage({ ...file, size: MAX_OVERLAY_ASSET_BYTES + 1 }, imageEnvironment()));
  await assert.rejects(readOverlayImage({ ...file, size: file.size + 1 }, imageEnvironment()));
  await assert.rejects(readOverlayImage(file, imageEnvironment({ failRead: true })));
  await assert.rejects(readOverlayImage(file, imageEnvironment({ failDecode: true })));
  await assert.rejects(readOverlayImage(file, imageEnvironment({ result: png.replace('image/png', 'image/jpeg') })));
  await assert.rejects(readOverlayImage(file, imageEnvironment({ width: 4001, height: 4000 })));
  await assert.rejects(readOverlayImage(file, imageEnvironment({ width: 0 })));
  await assert.rejects(readOverlayImage(file, { FileReader: null, Image: null }));
});

test('missing geometry stays inside a full-canvas overlay and malformed overrides fall back safely', () => {
  const full = normalizeOverlays(envelope([textItem({ w: 100, h: 100, x: NaN, y: undefined })])).items[0];
  assert.equal(full.x, 0); assert.equal(full.y, 0);
  assert.equal(createOverlay('text', null).type, 'text');
  const info = inspectOverlayImage(png); info.width = 1000000;
  assert.equal(inspectOverlayImage(png).width, 1);
});
