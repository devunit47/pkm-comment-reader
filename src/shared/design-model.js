import { normalizeStudio } from './studio.js';
import { normalizeLayout, PANEL_IDS } from './workspace-model.js';
import { normalizeOverlays } from './overlay-model.js';
import { OUTPUT_SIZES } from './output-protocol.js';
import { MAX_THEME_CSS_BYTES, themeByteLength } from './theme.js';
export { MAX_THEME_CSS_BYTES } from './theme.js';

// design.json is shared by the server (which stores it) and every page (which
// renders it). Images are file references, never data URLs.
export const DESIGN_FORMAT = 'pokome-design';
export const DESIGN_VERSION = 2;
export const RATIOS = Object.freeze(['16:9', '9:16', '4:3']);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_DESIGN_NAME = 40;
export const DEFAULT_OUTPUT_SIZE = '1280x720';
export const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });
const IMAGE_REF = /^images\/([0-9a-f]{64})\.(png|jpg|webp|gif)$/;
const SCOPE = /^(?:current|presets\/[a-z0-9-]{1,64})$/;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nameSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
function nameParts(value, limit = MAX_DESIGN_NAME + 1) {
  const parts = [];
  for (const part of nameSegmenter.segment(value)) { parts.push(part.segment); if (parts.length >= limit) break; }
  return parts;
}

export function normalizePresetName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw new Error('名前に改行や制御文字は使えません。');
  const name = value.trim();
  if (!name || nameParts(name).length > MAX_DESIGN_NAME) throw new Error('名前は1〜40文字で入力してください。絵文字も1文字として数えます。');
  return name;
}

export function validPresetId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}

export const validImageRef = value => typeof value === 'string' && IMAGE_REF.test(value);
export const imageExtension = type => Object.keys(IMAGE_TYPES).find(extension => IMAGE_TYPES[extension] === type) || '';

// A reference counts only when the server's catalog lists it with a matching
// type and the per-image limits; normalizeOverlays itself checks only totals.
function catalogEntry(images, ref) {
  if (!validImageRef(ref) || !record(images) || !Object.hasOwn(images, ref)) return null;
  const info = images[ref];
  if (!record(info) || info.type !== IMAGE_TYPES[IMAGE_REF.exec(ref)[2]]) return null;
  if (!Number.isSafeInteger(info.bytes) || info.bytes < 1 || info.bytes > MAX_IMAGE_BYTES) return null;
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1 || info.width * info.height > MAX_IMAGE_PIXELS) return null;
  return info;
}
export const studioOptions = images => ({ image: ref => !!catalogEntry(images, ref) });
export const overlayOptions = images => ({
  inspectAsset: ref => { const info = catalogEntry(images, ref); return info ? { bytes: info.bytes } : null; },
  maxTotalBytes: Infinity,
});

function normalizeRatio(entry, images) {
  const layout = entry.layout == null ? null : normalizeLayout(entry.layout, PANEL_IDS.talk);
  let overlays;
  try { overlays = normalizeOverlays(entry.overlays ?? null, overlayOptions(images)); }
  catch { overlays = normalizeOverlays(); }
  return { layout, overlays };
}

export function normalizeDesign(value, images = {}) {
  if (!record(value) || value.format !== DESIGN_FORMAT || value.version !== DESIGN_VERSION) throw new Error('対応するデザインの形式ではありません。');
  const ratios = {};
  for (const ratio of RATIOS) {
    const entry = record(value.ratios) && Object.hasOwn(value.ratios, ratio) ? value.ratios[ratio] : null;
    ratios[ratio] = record(entry) ? normalizeRatio(entry, images) : null;
  }
  return {
    format: DESIGN_FORMAT, version: DESIGN_VERSION,
    name: typeof value.name === 'string' ? nameParts(value.name).slice(0, MAX_DESIGN_NAME).join('') : '',
    // The server cannot run compileTheme (it needs CSSOM); pages compile on load.
    theme: typeof value.theme === 'string' && themeByteLength(value.theme) <= MAX_THEME_CSS_BYTES ? value.theme : '',
    studio: normalizeStudio(value.studio, studioOptions(images)),
    outputSize: typeof value.outputSize === 'string' && Object.hasOwn(OUTPUT_SIZES, value.outputSize) ? value.outputSize : DEFAULT_OUTPUT_SIZE,
    ratios,
  };
}

export const defaultDesign = () => normalizeDesign({ format: DESIGN_FORMAT, version: DESIGN_VERSION }, {});

// Every image reference the design uses, for copying and cleanup.
export function designImageRefs(design) {
  const refs = new Set([design.studio.image, design.studio.speechImage].filter(validImageRef));
  for (const ratio of RATIOS) for (const ref of Object.values(design.ratios[ratio]?.overlays.assets || {})) if (validImageRef(ref)) refs.add(ref);
  return refs;
}

// URLs are built only from validated references, so they never contain quotes
// (the speech background is placed inside a CSS url("…")).
export function imageUrl(ref, scope = 'current') {
  if (!validImageRef(ref) || !SCOPE.test(scope)) return '';
  return `/api/design/${scope}/images/${ref.slice('images/'.length)}`;
}
export const resolveStudioImages = (studio, scope) => ({ ...studio, image: imageUrl(studio.image, scope), speechImage: imageUrl(studio.speechImage, scope) });
export const resolveOverlayAssets = (state, scope) => ({ ...state, assets: Object.fromEntries(Object.entries(state.assets).map(([id, ref]) => [id, imageUrl(ref, scope)])) });

// --- Per-ratio layouts (P1-B2) ---
// Every screen shows the ratio closest to its own shape; an uncreated ratio
// uses its built-in default and never borrows another ratio's layout.
const RATIO_VALUES = { '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3 };
export function nearestRatio(width, height) {
  if (!(width > 0) || !(height > 0)) return '16:9';
  const shape = Math.log(width / height);
  return RATIOS.reduce((best, ratio) => Math.abs(shape - Math.log(RATIO_VALUES[ratio])) < Math.abs(shape - Math.log(RATIO_VALUES[best])) ? ratio : best);
}
export const PREVIEW_SIZES = Object.freeze(['1920x1080', '1280x720', '960x540', '640x360', '1080x1920', '1440x1080']);

// Portrait: title on top, presenter in the middle, comments as a bottom band.
// It is a structure, not a copy of any streaming app's screen.
const PORTRAIT_LAYOUT = Object.freeze({ panels: {
  header: { x: 4, y: 2, w: 92, h: 8, z: 1, hidden: false },
  actor: { x: 4, y: 11, w: 92, h: 30, z: 1, hidden: false },
  // At least the speech panel's 220px minimum on a 1080×1920 output.
  speech: { x: 4, y: 42, w: 92, h: 20, z: 2, hidden: false },
  chat: { x: 4, y: 64, w: 92, h: 29, z: 2, hidden: false },
  footer: { x: 4, y: 94, w: 92, h: 4, z: 1, hidden: false },
} });
// null keeps the stylesheet's grid, which suits landscape screens.
export const defaultTalkLayout = ratio => ratio === '9:16' ? normalizeLayout(structuredClone(PORTRAIT_LAYOUT), PANEL_IDS.talk) : null;
const emptyOverlays = () => normalizeOverlays();
export const talkLayout = (design, ratio) => structuredClone(design.ratios[ratio]?.layout ?? defaultTalkLayout(ratio));
export const talkOverlays = (design, ratio) => structuredClone(design.ratios[ratio]?.overlays ?? emptyOverlays());

// Returns a design with one ratio's layout and/or overlays replaced. A ratio
// back at its default layout with no overlays becomes uncreated (null) again.
export function withTalk(design, ratio, { layout, overlays } = {}) {
  if (!RATIOS.includes(ratio)) throw new Error('対応しない画面の比率です。');
  const entry = design.ratios[ratio];
  let nextLayout = layout === undefined ? entry?.layout ?? null : layout;
  if (JSON.stringify(nextLayout) === JSON.stringify(defaultTalkLayout(ratio))) nextLayout = null;
  const nextOverlays = overlays ?? entry?.overlays ?? emptyOverlays();
  const created = nextLayout !== null || nextOverlays.items.length > 0;
  return { ...design, ratios: { ...design.ratios, [ratio]: created ? { layout: nextLayout, overlays: nextOverlays } : null } };
}

// Edges that viewers' apps often cover (portrait) or that should stay clear of
// text (landscape), in percent. Shown only in the preview; tune here.
export const SAFE_AREAS = Object.freeze({
  '16:9': Object.freeze({ top: 5, bottom: 5, left: 5, right: 5, shade: false }),
  '9:16': Object.freeze({ top: 6, bottom: 10, left: 0, right: 0, shade: true }),
  '4:3': Object.freeze({ top: 5, bottom: 5, left: 5, right: 5, shade: false }),
});
