import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStageAppearance, renderOverlays } from '../src/browser/stage-appearance.js';
import { DEFAULT_STUDIO, normalizeStudio, THEME_ACCENTS, applyCommentPreset } from '../src/shared/studio.js';
import { normalizeOverlays, createOverlay } from '../src/shared/overlay-model.js';
import { normalizeActorImage } from '../src/shared/design-model.js';

// A deliberately small behavioral DOM. It models ownership, descendant queries,
// textContent replacing children, and attribute writes; HTML parsing is forbidden.
class FakeStyle {
  values = new Map();
  priorities = new Map();
  setProperty(name, value, priority = '') { this.values.set(name, String(value)); this.priorities.set(name, priority); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  getPropertyPriority(name) { return this.priorities.get(name) || ''; }
  removeProperty(name) { this.values.delete(name); this.priorities.delete(name); }
  set zIndex(value) { this.setProperty('z-index', value); }
  get zIndex() { return this.getPropertyValue('z-index'); }
  set color(value) { this.setProperty('color', value); }
  get color() { return this.getPropertyValue('color'); }
  set fontSize(value) { this.setProperty('font-size', value); }
  get fontSize() { return this.getPropertyValue('font-size'); }
}
class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument; this.tagName = tagName.toLowerCase();
    this.children = []; this.parentElement = null; this.dataset = {}; this.style = new FakeStyle();
    this.attributes = new Map(); this.attributeWrites = []; this.className = ''; this.id = ''; this.hidden = false; this.text = '';
  }
  set innerHTML(_value) { throw new Error('Renderer must use textContent, not HTML parsing'); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src') || ''; }
  set alt(value) { this.setAttribute('alt', value); }
  get alt() { return this.getAttribute('alt') || ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.attributeWrites.push([name, String(value)]); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); this.attributeWrites.push([name, null]); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.text = ''; this.append(...children);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null;
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.children.filter(child => child.matches(selector.slice(9)));
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class FakeDocument {
  created = [];
  createElement(tag) { const element = new FakeElement(this, tag); this.created.push(element); return element; }
}
function fixture(ownerDocument = new FakeDocument()) {
  const stage = ownerDocument.createElement('section');
  for (const id of ['stage-chat-list', 'stage-speech-user', 'stage-title', 'stage-subtitle', 'stage-footer-text', 'stage-speech-title', 'actor-image', 'actor-placeholder', 'actor-caption']) {
    const node = ownerDocument.createElement(id === 'actor-image' ? 'img' : 'div'); node.id = id; stage.append(node);
  }
  const speech = ownerDocument.createElement('div'); speech.className = 'stage-speech'; stage.append(speech);
  stage.querySelector('#actor-placeholder').append(ownerDocument.createElement('small'));
  return { stage, ownerDocument, get: id => stage.querySelector(`#${id}`) };
}
function withoutGlobals(action) {
  const descriptors = new Map(['document', 'localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of descriptors.keys()) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(`Global ${key} must not be accessed`); } });
  try { return action(); }
  finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const overlayState = (items, assets = {}) => normalizeOverlays({ version: 1, items, assets });
const directOverlays = stage => stage.querySelectorAll(':scope > .pokome-overlay');

test('default live appearance retains prior stage values without reading a global document or storage', () => {
  const { stage, get } = fixture();
  withoutGlobals(() => renderStageAppearance(stage, deepFreeze(normalizeStudio())));
  assert.deepEqual(stage.dataset, { theme: 'mint', layout: 'right', decorated: 'true' });
  assert.deepEqual(Object.fromEntries(stage.style.values), {
    '--stage-accent': '#ace5cd', '--stage-font-size': '20px', '--speech-font-size': '22px',
    '--speech-background': '#f3f1dc', '--speech-ink': '#000000', '--speech-image': 'url("./speech-background.svg")',
    '--speech-image-ink': '#25382f', '--actor-width': '42fr', '--chat-width': '58fr',
  });
  assert.equal(get('stage-chat-list').dataset.commentStyle, 'stacked');
  assert.equal(get('stage-speech-user').hidden, false);
  assert.equal(stage.querySelector('.stage-speech').dataset.style, 'image');
  for (const [id, key] of Object.entries({ 'stage-title': 'title', 'stage-subtitle': 'subtitle', 'stage-footer-text': 'footer', 'stage-speech-title': 'speechTitle' })) {
    assert.equal(get(id).textContent, DEFAULT_STUDIO[key]);
  }
  assert.equal(get('actor-image').hidden, true); assert.equal(get('actor-image').getAttribute('src'), null);
  assert.equal(get('actor-placeholder').hidden, false);
  assert.equal(get('actor-placeholder').querySelector('small').textContent, 'OBSで映像を重ねるための空き枠');
  assert.equal(get('actor-caption').textContent, 'YOUR SPACE');
});

test('preview root scope, literal text, theme/custom accents and speech contrast are independent', () => {
  const ownerDocument = new FakeDocument();
  const live = fixture(ownerDocument), preview = fixture(ownerDocument);
  renderStageAppearance(live.stage, normalizeStudio());
  const hostile = '<img src=x onerror="globalThis.pwned=true"> & <script>bad()</script>';
  const custom = deepFreeze(normalizeStudio({
    theme: 'rose', accentMode: 'custom', accent: '#123456', layout: 'left', decoration: false,
    title: hostile, subtitle: hostile, footer: hostile, speechTitle: hostile,
    commentStyle: 'anonymous', fontSize: 28, speechFontSize: 32, speechStyle: 'bubble',
    speechBackground: '#111111', speechTextColor: '#abcdef', actorWidth: 60,
  }));
  withoutGlobals(() => renderStageAppearance(preview.stage, custom, '/preview/default.svg'));
  assert.deepEqual(preview.stage.dataset, { theme: 'rose', layout: 'left', decorated: 'false' });
  assert.equal(preview.stage.style.getPropertyValue('--stage-accent'), '#123456');
  assert.equal(preview.stage.style.getPropertyValue('--speech-ink'), '#ffffff');
  assert.equal(preview.stage.style.getPropertyValue('--speech-image'), 'url("/preview/default.svg")');
  assert.equal(preview.stage.style.getPropertyValue('--actor-width'), '60fr');
  assert.equal(preview.stage.style.getPropertyValue('--chat-width'), '40fr');
  assert.equal(preview.get('stage-speech-user').hidden, true);
  for (const [id, key] of Object.entries({ 'stage-title': 'title', 'stage-subtitle': 'subtitle', 'stage-footer-text': 'footer', 'stage-speech-title': 'speechTitle' })) {
    assert.equal(preview.get(id).textContent, custom[key]); assert.equal(preview.get(id).children.length, 0);
  }
  assert.equal(live.get('stage-title').textContent, DEFAULT_STUDIO.title);
  assert.equal(live.stage.style.getPropertyValue('--stage-accent'), THEME_ACCENTS.mint);
  assert.equal(live.get('stage-speech-user').hidden, false);
  assert.equal(live.stage.querySelector('.stage-speech').dataset.style, 'image');
  withoutGlobals(() => renderStageAppearance(preview.stage, normalizeStudio({ ...custom, theme: 'violet', accentMode: 'theme', commentStyle: 'inline', speechBackground: '#ffffff' })));
  assert.equal(preview.stage.style.getPropertyValue('--stage-accent'), THEME_ACCENTS.violet);
  assert.equal(preview.stage.style.getPropertyValue('--speech-ink'), '#000000');
  assert.equal(preview.get('stage-speech-user').hidden, false);
});

test('actor and speech images reuse unchanged sources, reset cleanly and show the correct placeholders', () => {
  const { stage, get } = fixture();
  const studio = normalizeStudio({ source: 'image', image: png, speechImage: png });
  withoutGlobals(() => renderStageAppearance(stage, studio));
  const actor = get('actor-image');
  assert.equal(actor.hidden, false); assert.equal(actor.getAttribute('src'), png);
  assert.equal(get('actor-placeholder').hidden, true); assert.equal(get('actor-caption').textContent, 'WITH YOU ♡');
  assert.equal(stage.style.getPropertyValue('--speech-image'), `url("${png}")`);
  const writes = actor.attributeWrites.length;
  withoutGlobals(() => renderStageAppearance(stage, studio));
  assert.equal(actor.attributeWrites.length, writes, 'unchanged images should not reload');
  withoutGlobals(() => renderStageAppearance(stage, normalizeStudio({ source: 'image', image: '' })));
  assert.equal(actor.hidden, true); assert.equal(actor.getAttribute('src'), null);
  assert.equal(get('actor-placeholder').hidden, false);
  assert.equal(get('actor-placeholder').querySelector('small').textContent, '配信デザイン設定で画像を読み込んでください');
  assert.equal(stage.style.getPropertyValue('--speech-image'), 'url("./speech-background.svg")');
  withoutGlobals(() => renderStageAppearance(stage, normalizeStudio()));
  assert.equal(get('actor-placeholder').querySelector('small').textContent, 'OBSで映像を重ねるための空き枠');
});

test('actor image theme values own no attributes or variables and remove only custom placement writes', () => {
  const { stage } = fixture();
  const studio = deepFreeze(normalizeStudio({ source: 'image', image: png }));
  const options = actorImage => ({ actorImage: deepFreeze(normalizeActorImage(actorImage)) });
  withoutGlobals(() => renderStageAppearance(stage, studio, undefined, options({ mode: 'theme', scale: 177, offsetX: 9 })));
  const baseline = { dataset: { ...stage.dataset }, styles: new Map(stage.style.values) };
  assert.equal(stage.dataset.actorImage, undefined);
  assert.equal([...stage.style.values.keys()].some(name => name.startsWith('--actor-image-')), false);
  withoutGlobals(() => renderStageAppearance(stage, studio, undefined, options({ mode: 'custom', scale: 110, alignX: 'right', alignY: 'bottom', offsetX: 3.5, offsetY: -2.25, overflow: true })));
  assert.equal(stage.dataset.actorImage, 'custom');
  assert.equal(stage.dataset.actorImageOverflow, 'true');
  assert.deepEqual(['size', 'left', 'top', 'position'].map(key => stage.style.getPropertyValue(`--actor-image-${key}`)), ['110%', '-6.5%', '-12.25%', 'right bottom']);
  assert.ok(['size', 'left', 'top', 'position'].every(key => stage.style.getPropertyPriority(`--actor-image-${key}`) === 'important'));
  // A theme may own unrelated transform/overflow values; this renderer never edits them.
  stage.style.setProperty('--unrelated-theme-value', 'kept');
  withoutGlobals(() => renderStageAppearance(stage, studio, undefined, options({ mode: 'theme', scale: 110, overflow: true })));
  assert.deepEqual(stage.dataset, baseline.dataset);
  assert.equal(stage.style.getPropertyValue('--unrelated-theme-value'), 'kept');
  stage.style.removeProperty('--unrelated-theme-value');
  assert.deepEqual(new Map(stage.style.values), baseline.styles);
});

test('actor placement does not apply without an image or to the OBS empty slot, and returns with the image', () => {
  const { stage, get } = fixture();
  const options = deepFreeze({ actorImage: normalizeActorImage({ mode: 'custom', scale: 200, alignX: 'left', alignY: 'top', offsetX: -100, offsetY: 100 }) });
  const imageStudio = normalizeStudio({ source: 'image', image: png });
  renderStageAppearance(stage, imageStudio, undefined, options);
  assert.equal(stage.style.getPropertyValue('--actor-image-size'), '200%');
  for (const studio of [normalizeStudio({ source: 'image' }), normalizeStudio({ image: png })]) {
    renderStageAppearance(stage, studio, undefined, options);
    assert.equal(get('actor-image').hidden, true);
    assert.equal(stage.dataset.actorImage, undefined);
    assert.equal(stage.dataset.actorImageOverflow, undefined);
    assert.equal([...stage.style.values.keys()].some(name => name.startsWith('--actor-image-')), false);
  }
  renderStageAppearance(stage, imageStudio, undefined, options);
  assert.equal(stage.style.getPropertyValue('--actor-image-left'), '-100%');
  assert.equal(stage.style.getPropertyValue('--actor-image-top'), '100%');
  assert.equal(stage.dataset.actorImageOverflow, 'false');
  assert.equal(options.actorImage.scale, 200, 'saved input stays unchanged');
});

test('overlay rendering creates owner-document nodes, preserves literal text and applies bounded styles', () => {
  const live = fixture(), preview = fixture();
  const text = '<svg onload=alert(1)>hello</svg>';
  const item = createOverlay('text', { id: 'text-one', text, x: 7, y: 12, w: 41, h: 19, z: 8, color: '#12abcd', fontSize: 48, hidden: true });
  const state = deepFreeze(overlayState([item]));
  withoutGlobals(() => renderOverlays(preview.stage, state));
  assert.equal(directOverlays(live.stage).length, 0);
  const [element] = directOverlays(preview.stage);
  assert.equal(element.ownerDocument, preview.ownerDocument);
  assert.equal(element.dataset.overlayId, 'text-one'); assert.equal(element.textContent, text);
  assert.equal(element.children.length, 0); assert.equal(element.hidden, true);
  assert.deepEqual(Object.fromEntries(element.style.values), {
    left: '7%', top: '12%', width: '41%', height: '19%', 'z-index': '8', color: '#12abcd', 'font-size': '48px',
  });
  assert.equal(preview.get('stage-title').textContent, '');
});

test('overlay reconciliation preserves identity, updates text/style/visibility and deletes only direct managed children', () => {
  const { stage, ownerDocument } = fixture();
  const nested = ownerDocument.createElement('div'); nested.className = 'pokome-overlay'; nested.dataset.overlayId = 'nested';
  const container = ownerDocument.createElement('div'); container.append(nested); stage.append(container);
  const first = createOverlay('text', { id: 'first', text: 'before' });
  const second = createOverlay('text', { id: 'second', text: 'remove me' });
  withoutGlobals(() => renderOverlays(stage, overlayState([first, second])));
  const [firstNode, secondNode] = directOverlays(stage);
  withoutGlobals(() => renderOverlays(stage, overlayState([{ ...first, text: 'after', hidden: true, x: 9, fontSize: 80 }])));
  assert.deepEqual(directOverlays(stage), [firstNode]);
  assert.equal(firstNode.textContent, 'after'); assert.equal(firstNode.hidden, true);
  assert.equal(firstNode.style.getPropertyValue('left'), '9%'); assert.equal(firstNode.style.fontSize, '80px');
  assert.equal(secondNode.parentElement, null); assert.equal(nested.parentElement, container);
  withoutGlobals(() => renderOverlays(stage, normalizeOverlays()));
  assert.equal(directOverlays(stage).length, 0); assert.equal(nested.parentElement, container);
  assert.ok(stage.querySelector('#stage-title'));
});

test('reordering equal-z overlays preserves stacking before and after reconstruction', () => {
  const { stage } = fixture();
  const first = createOverlay('text', { id: 'first', text: 'First', z: 3 });
  const second = createOverlay('text', { id: 'second', text: 'Second', z: 3 });
  renderOverlays(stage, overlayState([first, second]));
  const [firstNode, secondNode] = directOverlays(stage);
  const reordered = overlayState([second, first]);
  renderOverlays(stage, reordered);
  assert.deepEqual(directOverlays(stage), [secondNode, firstNode]);
  const reloaded = fixture().stage;
  renderOverlays(reloaded, reordered);
  assert.deepEqual(directOverlays(stage).map(node => node.dataset.overlayId), directOverlays(reloaded).map(node => node.dataset.overlayId));
});

test('image overlays resolve safe asset IDs, reuse image nodes and can switch between image and text', () => {
  const { stage, ownerDocument } = fixture();
  const imageItem = createOverlay('image', { id: 'one', assetId: 'raster' });
  const state = deepFreeze(overlayState([imageItem], { raster: png }));
  withoutGlobals(() => renderOverlays(stage, state));
  const [element] = directOverlays(stage), image = element.querySelector('img');
  assert.equal(image.ownerDocument, ownerDocument); assert.equal(image.getAttribute('src'), png); assert.equal(image.alt, '追加画像');
  const writes = image.attributeWrites.length;
  withoutGlobals(() => renderOverlays(stage, state));
  assert.equal(element.querySelector('img'), image); assert.equal(image.attributeWrites.length, writes);
  withoutGlobals(() => renderOverlays(stage, overlayState([{ ...imageItem, assetId: 'other' }], { other: png })));
  assert.equal(element.querySelector('img'), image); assert.equal(image.attributeWrites.length, writes, 'a new reference to the same bytes should not reload');
  const alternate = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  withoutGlobals(() => renderOverlays(stage, overlayState([{ ...imageItem, assetId: 'other' }], { other: alternate })));
  assert.equal(element.querySelector('img'), image); assert.equal(image.getAttribute('src'), alternate);
  assert.equal(image.attributeWrites.length, writes + 1, 'changed image bytes should refresh the same image node');
  withoutGlobals(() => renderOverlays(stage, overlayState([createOverlay('text', { id: 'one', text: '<b>literal</b>' })])));
  assert.equal(directOverlays(stage)[0], element); assert.equal(element.querySelector('img'), null);
  assert.equal(image.parentElement, null); assert.equal(element.textContent, '<b>literal</b>');
  withoutGlobals(() => renderOverlays(stage, state));
  assert.equal(directOverlays(stage)[0], element); assert.equal(element.textContent, '');
  assert.notEqual(element.querySelector('img'), image); assert.equal(element.querySelector('img').src, png);
});

test('normalized missing, remote or SVG assets remove stale image overlays without creating unsafe image nodes', () => {
  const { stage, ownerDocument } = fixture();
  const item = createOverlay('image', { id: 'safe', assetId: 'raster' });
  withoutGlobals(() => renderOverlays(stage, overlayState([item], { raster: png })));
  for (const raster of [undefined, 'https://example.com/tracker.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const createdBefore = ownerDocument.created.length;
    withoutGlobals(() => renderOverlays(stage, overlayState([item], raster ? { raster } : {})));
    assert.equal(directOverlays(stage).length, 0);
    assert.equal(ownerDocument.created.length, createdBefore);
  }
});

test('comment look writes only the attributes and variables it needs and removes them at theme values', () => {
  const { stage } = fixture();
  const baseline = { dataset: { ...stage.dataset }, style: new Map() };
  renderStageAppearance(stage, normalizeStudio());
  baseline.dataset = { ...stage.dataset }; baseline.style = new Map(stage.style.values);
  renderStageAppearance(stage, applyCommentPreset(normalizeStudio(), 'dark'));
  assert.deepEqual({ panel: stage.dataset.commentPanel, outline: stage.dataset.commentOutline, text: stage.dataset.commentText, author: stage.dataset.commentAuthor, label: stage.dataset.commentLabel },
    { panel: 'dark', outline: 'thin', text: '', author: '', label: undefined });
  assert.equal(stage.style.getPropertyValue('--stage-comment-opacity'), '0.35');
  assert.equal(stage.style.getPropertyValue('--stage-comment-text'), '#ffffff');
  assert.equal(stage.style.getPropertyValue('--stage-comment-outline'), '#000000');
  renderStageAppearance(stage, applyCommentPreset(normalizeStudio(), 'dense'));
  assert.deepEqual([stage.dataset.commentLineHeight, stage.dataset.commentGap, stage.dataset.commentDivider, stage.dataset.commentLabel], ['', '', 'false', 'false']);
  assert.equal(stage.style.getPropertyValue('--stage-comment-gap'), '2px');
  assert.equal(stage.style.getPropertyValue('--stage-comment-opacity'), '');
  renderStageAppearance(stage, normalizeStudio());
  assert.deepEqual(stage.dataset, baseline.dataset);
  assert.deepEqual(new Map(stage.style.values), baseline.style);
});
