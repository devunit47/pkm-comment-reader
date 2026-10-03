// User overlays live only in this dedicated store. Do not embed their bytes in
// workspace layouts, shareable themes, or capped design exports. Full settings
// backups may include this dedicated store as an optional, separately bounded key.
export const OVERLAYS_KEY = 'pokome-overlays-v1';
export const MAX_OVERLAYS = 20;
export const MAX_OVERLAY_TEXT = 1000;
export const MAX_OVERLAY_ASSET_BYTES = 512 * 1024;
export const MAX_OVERLAY_TOTAL_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_OVERLAY_PIXELS = 16_000_000;
export const MAX_OVERLAYS_SERIALIZED_LENGTH = Math.ceil(MAX_OVERLAY_TOTAL_ASSET_BYTES / 3) * 4 + 128 * 1024;
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const safeId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !RESERVED_IDS.has(value);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key);
const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const empty = () => ({ version: 1, items: [], assets: {} });
// Revalidating unchanged image bytes on every drag would stall the canvas. This
// bounded LRU retains metadata only alongside the same immutable data URL.
const imageInfoCache = new Map();
let cachedImageBytes = 0;
const dimensionsAllowed = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= MAX_OVERLAY_PIXELS;

function rasterDimensions(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (mime === 'image/png' && bytes.length >= 33 && bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n' && view.getUint32(8) === 13 && text(12, 4) === 'IHDR') {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mime === 'image/gif' && bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || marker == null) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
    const uint24 = offset => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = text(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length > bytes.length) return null;
      if (chunk === 'VP8X' && length >= 10) return [uint24(start + 4) + 1, uint24(start + 7) + 1];
      if (chunk === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
        return [1 + ((bytes[start + 2] & 0x3f) << 8 | bytes[start + 1]), 1 + ((bytes[start + 4] & 0x0f) << 10 | bytes[start + 3] << 2 | bytes[start + 2] >> 6)];
      }
      if (chunk === 'VP8 ' && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
        return [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
      }
      offset = start + length + (length % 2);
    }
  }
  return null;
}

// Synchronous structural validation for persisted state. File uploads additionally
// require a successful browser decode below; a data: prefix alone is not trusted.
export function inspectOverlayImage(dataURL) {
  if (typeof dataURL !== 'string' || dataURL.length > Math.ceil(MAX_OVERLAY_ASSET_BYTES / 3) * 4 + 64) return null;
  if (imageInfoCache.has(dataURL)) {
    const cached = imageInfoCache.get(dataURL);
    imageInfoCache.delete(dataURL); imageInfoCache.set(dataURL, cached);
    return { ...cached };
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(dataURL);
  if (!match || !match[2]) return null;
  const byteLength = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (byteLength > MAX_OVERLAY_ASSET_BYTES) return null;
  try {
    const decoded = atob(match[2]);
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    const dimensions = rasterDimensions(bytes, match[1]);
    if (!dimensions || !dimensionsAllowed(...dimensions)) return null;
    const info = { mime: match[1], bytes: byteLength, width: dimensions[0], height: dimensions[1] };
    while (imageInfoCache.size && (cachedImageBytes + byteLength > MAX_OVERLAY_TOTAL_ASSET_BYTES || imageInfoCache.size >= MAX_OVERLAYS)) {
      const oldest = imageInfoCache.keys().next().value;
      cachedImageBytes -= imageInfoCache.get(oldest).bytes; imageInfoCache.delete(oldest);
    }
    imageInfoCache.set(dataURL, info); cachedImageBytes += byteLength;
    return { ...info };
  } catch { return null; }
}

function normalizeItem(value) {
  if (!record(value) || !safeId(value.id) || !['text', 'image'].includes(value.type)) return null;
  const w = bounded(value.w, 30, 2, 100), h = bounded(value.h, value.type === 'text' ? 12 : 30, 2, 100);
  return {
    id: value.id, type: value.type,
    x: bounded(value.x, Math.min(5, 100 - w), 0, 100 - w), y: bounded(value.y, Math.min(5, 100 - h), 0, 100 - h), w, h,
    z: Math.round(bounded(value.z, 1, 0, 99)), hidden: value.hidden === true,
    text: value.type === 'text' && typeof value.text === 'string' ? value.text.slice(0, MAX_OVERLAY_TEXT) : '',
    color: typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '#ffffff',
    fontSize: Math.round(bounded(value.fontSize, 32, 12, 160)),
    assetId: value.type === 'image' && safeId(value.assetId) ? value.assetId : '',
  };
}

export function normalizeOverlays(value) {
  if (value == null) return empty();
  if (!record(value) || value.version !== 1) throw new Error('追加要素の形式またはバージョンが対応していません。');
  const result = empty(), seen = new Set(), inspected = new Map();
  let totalBytes = 0;
  for (const candidate of Array.isArray(value.items) ? value.items : []) {
    if (result.items.length === MAX_OVERLAYS) break;
    const item = normalizeItem(candidate);
    if (!item || seen.has(item.id)) continue;
    if (item.type === 'image') {
      if (!own(value.assets, item.assetId)) continue;
      if (!inspected.has(item.assetId)) inspected.set(item.assetId, inspectOverlayImage(value.assets[item.assetId]));
      const info = inspected.get(item.assetId);
      if (!info) continue;
      if (!own(result.assets, item.assetId)) {
        if (totalBytes + info.bytes > MAX_OVERLAY_TOTAL_ASSET_BYTES) continue;
        result.assets[item.assetId] = value.assets[item.assetId];
        totalBytes += info.bytes;
      }
    }
    seen.add(item.id);
    result.items.push(item);
  }
  return result;
}

export function readOverlays(storage) {
  try {
    const saved = storage?.getItem(OVERLAYS_KEY);
    if (!saved || saved.length > MAX_OVERLAYS_SERIALIZED_LENGTH) return empty();
    return normalizeOverlays(JSON.parse(saved));
  } catch { return empty(); }
}

function nextId(prefix, existing) {
  const ids = new Set(existing);
  try {
    const random = globalThis.crypto?.randomUUID?.();
    const candidate = random && `${prefix}-${random}`;
    if (safeId(candidate) && !ids.has(candidate)) return candidate;
  } catch { /* Older or restricted browsers use a deterministic local fallback. */ }
  let suffix = 1;
  while (ids.has(`${prefix}-${suffix}`)) suffix++;
  return `${prefix}-${suffix}`;
}

// Return a single item so callers can place it in their existing draft. Image
// items must acquire a valid asset reference before normalizeOverlays accepts them.
export function createOverlay(type, overrides = {}, existingItems = []) {
  if (!['text', 'image'].includes(type)) throw new Error('対応しない追加要素です。');
  if (!Array.isArray(existingItems) || existingItems.length >= MAX_OVERLAYS) throw new Error('追加できる要素は20個までです。');
  if (!record(overrides)) overrides = {};
  const ids = existingItems.map(item => item?.id);
  const id = safeId(overrides.id) && !ids.includes(overrides.id) ? overrides.id : nextId('overlay', ids);
  return normalizeItem({ text: type === 'text' ? 'テキスト' : '', ...overrides, id, type });
}

export function pruneOverlayAssets(state) { return normalizeOverlays(state); }

export function removeOverlay(state, id) {
  const normalized = normalizeOverlays(state);
  return normalizeOverlays({ ...normalized, items: normalized.items.filter(item => item.id !== id) });
}

// May temporarily return one unreferenced asset; append/update the image item
// using the returned assetId before normalizing or saving the draft.
export function addOverlayAsset(state, dataURL, assetId) {
  const normalized = normalizeOverlays(state), info = inspectOverlayImage(dataURL);
  if (!info) throw new Error('PNG・JPEG・WebP・GIFの512KB以下、1600万画素以内の画像を選んでください。');
  const duplicate = Object.keys(normalized.assets).find(id => normalized.assets[id] === dataURL);
  if (duplicate) return { state: normalized, assetId: duplicate };
  const total = Object.values(normalized.assets).reduce((sum, asset) => sum + inspectOverlayImage(asset).bytes, 0);
  if (total + info.bytes > MAX_OVERLAY_TOTAL_ASSET_BYTES) throw new Error('追加画像の合計は2MB以内にしてください。');
  const id = safeId(assetId) && !own(normalized.assets, assetId) ? assetId : nextId('asset', Object.keys(normalized.assets));
  return { state: { ...normalized, assets: { ...normalized.assets, [id]: dataURL } }, assetId: id };
}

export async function readOverlayImage(file, { FileReader: Reader = globalThis.FileReader, Image: ImageClass = globalThis.Image } = {}) {
  if (!file || !MIME_TYPES.includes(file.type) || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_OVERLAY_ASSET_BYTES) {
    throw new Error('PNG・JPEG・WebP・GIFの512KB以下の画像を選んでください。');
  }
  if (!Reader || !ImageClass) throw new Error('このブラウザでは画像を読み込めません。');
  const dataURL = await new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reader.onabort = () => reject(new Error('画像を読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
  const info = inspectOverlayImage(dataURL);
  if (!info || info.mime !== file.type || info.bytes !== file.size) throw new Error('画像の形式または大きさが正しくありません。1600万画素以内の画像を選んでください。');
  const probe = new ImageClass();
  probe.src = dataURL;
  try { await probe.decode(); } catch { throw new Error('画像が壊れているか、対応しない画像形式です。'); }
  if (!dimensionsAllowed(probe.naturalWidth, probe.naturalHeight)) throw new Error('画像は1600万画素以内にしてください。');
  return dataURL;
}
