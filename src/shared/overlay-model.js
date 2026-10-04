// Overlay items and their asset references. design.json passes file-reference
// checks (design-model.js); the data URL defaults below remain only to read
// backups from the browser-storage era, whose images had these limits.
export const MAX_OVERLAYS = 20;
export const MAX_OVERLAY_TEXT = 1000;
export const MAX_OVERLAY_ASSET_BYTES = 512 * 1024;
export const MAX_OVERLAY_TOTAL_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_OVERLAY_PIXELS = 16_000_000;
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

// Reads only the image header, so the server can bound pixels without decoding.
export function rasterDimensions(bytes, mime) {
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

// Image frames may cross the canvas but must leave 2% visible on each axis.
export function overlayBounds(type, w, h) {
  const minSize = 2, maxSize = type === 'image' ? 200 : 100;
  const width = bounded(w, 30, minSize, maxSize), height = bounded(h, type === 'text' ? 12 : 30, minSize, maxSize);
  return type === 'image'
    ? { minX: Math.max(-100, 2 - width), maxX: Math.min(98, 200 - width), minY: Math.max(-100, 2 - height), maxY: Math.min(98, 200 - height), minSize, maxSize }
    : { minX: 0, maxX: 100 - width, minY: 0, maxY: 100 - height, minSize, maxSize };
}

function normalizeItem(value) {
  if (!record(value) || !safeId(value.id) || !['text', 'image'].includes(value.type)) return null;
  const maxSize = value.type === 'image' ? 200 : 100;
  const w = bounded(value.w, 30, 2, maxSize), h = bounded(value.h, value.type === 'text' ? 12 : 30, 2, maxSize);
  const bounds = overlayBounds(value.type, w, h);
  return {
    id: value.id, type: value.type,
    x: bounded(value.x, Math.min(5, bounds.maxX), bounds.minX, bounds.maxX), y: bounded(value.y, Math.min(5, bounds.maxY), bounds.minY, bounds.maxY), w, h,
    z: Math.round(bounded(value.z, 1, 0, 99)), hidden: value.hidden === true,
    text: value.type === 'text' && typeof value.text === 'string' ? value.text.slice(0, MAX_OVERLAY_TEXT) : '',
    color: typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '#ffffff',
    fontSize: Math.round(bounded(value.fontSize, 32, 12, 160)),
    assetId: value.type === 'image' && safeId(value.assetId) ? value.assetId : '',
  };
}

// `inspectAsset` must reject an image that exceeds the per-image limit: this
// function itself only enforces the total. The default checks data URLs.
export function normalizeOverlays(value, { inspectAsset = inspectOverlayImage, maxTotalBytes = MAX_OVERLAY_TOTAL_ASSET_BYTES } = {}) {
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
      if (!inspected.has(item.assetId)) inspected.set(item.assetId, inspectAsset(value.assets[item.assetId]));
      const info = inspected.get(item.assetId);
      if (!info) continue;
      if (!own(result.assets, item.assetId)) {
        if (totalBytes + info.bytes > maxTotalBytes) continue;
        result.assets[item.assetId] = value.assets[item.assetId];
        totalBytes += info.bytes;
      }
    }
    seen.add(item.id);
    result.items.push(item);
  }
  return result;
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

export function pruneOverlayAssets(state, options) { return normalizeOverlays(state, options); }

export function removeOverlay(state, id, options) {
  const normalized = normalizeOverlays(state, options);
  return normalizeOverlays({ ...normalized, items: normalized.items.filter(item => item.id !== id) }, options);
}

// May temporarily return one unreferenced asset; append/update the image item
// using the returned assetId before normalizing or saving the draft.
export function addOverlayAsset(state, dataURL, assetId, { inspectAsset = inspectOverlayImage, maxTotalBytes = MAX_OVERLAY_TOTAL_ASSET_BYTES } = {}) {
  const normalized = normalizeOverlays(state, { inspectAsset, maxTotalBytes }), info = inspectAsset(dataURL);
  if (!info) throw new Error('PNG・JPEG・WebP・GIFの対応する大きさ、1600万画素以内の画像を選んでください。');
  const duplicate = Object.keys(normalized.assets).find(id => normalized.assets[id] === dataURL);
  if (duplicate) return { state: normalized, assetId: duplicate };
  const total = Object.values(normalized.assets).reduce((sum, asset) => sum + inspectAsset(asset).bytes, 0);
  if (total + info.bytes > maxTotalBytes) throw new Error('追加画像の合計が上限を超えます。');
  const id = safeId(assetId) && !own(normalized.assets, assetId) ? assetId : nextId('asset', Object.keys(normalized.assets));
  return { state: { ...normalized, assets: { ...normalized.assets, [id]: dataURL } }, assetId: id };
}
