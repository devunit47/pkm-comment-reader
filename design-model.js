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
    name: typeof value.name === 'string' ? value.name.slice(0, MAX_DESIGN_NAME) : '',
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
