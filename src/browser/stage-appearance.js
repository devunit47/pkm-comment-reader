import { talkSpeechStyles } from '../shared/workspace-model.js';
import { THEME_ACCENTS } from '../shared/studio.js';

// The live stage and script-free design preview share exactly the same visual
// renderer. It cannot save settings, trim history, connect chat or play audio.
export function renderStageAppearance(stage, studio, defaultImage = './speech-background.svg') {
  const $ = id => stage.querySelector(`#${id}`);
  stage.dataset.theme = studio.theme;
  stage.dataset.layout = studio.layout;
  stage.dataset.decorated = String(studio.decoration);
  if (studio.actorAppearance === 'none') stage.dataset.actorAppearance = 'none';
  else delete stage.dataset.actorAppearance;
  stage.style.setProperty('--stage-accent', studio.accentMode === 'theme' ? THEME_ACCENTS[studio.theme] : studio.accent);
  // Preserve saved themes that override the comment size directly.
  stage.style.setProperty('--stage-font-size', `${studio.fontSize}px`);
  $('stage-chat-list').dataset.commentStyle = studio.commentStyle;
  renderCommentLook(stage, studio);
  $('stage-speech-user').hidden = studio.commentStyle === 'anonymous';
  stage.style.setProperty('--speech-font-size', `${studio.speechFontSize}px`);
  stage.style.setProperty('--speech-background', studio.speechBackground);
  const luminance = studio.speechBackground.slice(1).match(/../g).map(hex => {
    const channel = parseInt(hex, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  stage.style.setProperty('--speech-ink', luminance > .179 ? '#000000' : '#ffffff');
  stage.querySelector('.stage-speech').dataset.style = studio.speechStyle;
  stage.style.setProperty('--speech-image', `url("${studio.speechImage || defaultImage}")`);
  stage.style.setProperty('--speech-image-ink', studio.speechTextColor);
  stage.style.setProperty('--actor-width', `${studio.actorWidth}fr`);
  stage.style.setProperty('--chat-width', `${100 - studio.actorWidth}fr`);
  for (const [id, key] of Object.entries({ 'stage-title': 'title', 'stage-subtitle': 'subtitle', 'stage-footer-text': 'footer', 'stage-speech-title': 'speechTitle' })) $(id).textContent = studio[key];
  const hasImage = studio.source === 'image' && !!studio.image;
  $('actor-image').hidden = !hasImage;
  if ($('actor-image').getAttribute('src') !== (studio.image || null)) {
    if (studio.image) $('actor-image').src = studio.image;
    else $('actor-image').removeAttribute('src');
  }
  $('actor-placeholder').hidden = hasImage;
  $('actor-placeholder').querySelector('small').textContent = studio.source === 'image'
    ? '配信デザイン設定で画像を読み込んでください' : 'OBSで映像を重ねるための空き枠';
  $('actor-caption').textContent = hasImage ? 'WITH YOU ♡' : 'YOUR SPACE';
}

export function renderOverlays(stage, state) {
  const existing = new Map([...stage.querySelectorAll(':scope > .pokome-overlay')].map(element => [element.dataset.overlayId, element]));
  const ordered = [];
  for (const item of state.items) {
    let element = existing.get(item.id);
    if (!element) {
      element = stage.ownerDocument.createElement('div');
      element.className = 'pokome-overlay'; element.dataset.overlayId = item.id;
      stage.append(element);
    }
    existing.delete(item.id);
    ordered.push(element);
    element.hidden = item.hidden;
    for (const [property, value] of Object.entries({ left: item.x, top: item.y, width: item.w, height: item.h })) element.style.setProperty(property, `${value}%`);
    element.style.zIndex = item.z;
    element.style.color = item.color || '';
    element.style.fontSize = `${item.fontSize || 32}px`;
    if (item.type === 'text') element.textContent = item.text;
    else {
      let img = element.querySelector('img');
      if (!img) { img = stage.ownerDocument.createElement('img'); img.alt = '追加画像'; element.replaceChildren(img); }
      const src = state.assets[item.assetId];
      if (src && img.getAttribute('src') !== src) img.src = src;
    }
  }
  for (const element of existing.values()) element.remove();
  // Equal-z elements stack in DOM order. Imports may reorder retained IDs,
  // so keep the live order identical to reconstruction from saved items.
  const current = stage.querySelectorAll(':scope > .pokome-overlay');
  if (ordered.some((element, index) => current[index] !== element)) stage.append(...ordered);
}

// Keep synchronized history so relaxed settings can reveal it again.
// Callers normalize settings once at the storage or draft boundary.
export function selectOutputComments(messages, { maxVisible = 0, holdSeconds = 0, newestPosition = 'bottom' } = {}, now = Date.now(), expire = true) {
  const eligible = messages.filter(message => !message.hidden && (!expire || holdSeconds === 0 ||
    (Number.isFinite(message.receivedAt) && message.receivedAt > 0 && now < message.receivedAt + holdSeconds * 1000)));
  const selected = maxVisible === 0 ? eligible : eligible.slice(-maxVisible);
  return newestPosition === 'top' ? selected.reverse() : selected;
}

// The live stage and stream output share cards so themes apply identically.
export function renderStageComments(list, messages) {
  const doc = list.ownerDocument;
  list.replaceChildren(...messages.map(message => {
    const card = doc.createElement('div');
    card.className = 'stage-comment pokome-comment';
    card.title = `${message.user}: ${message.text}`;
    const author = doc.createElement('strong'); author.className = 'pokome-comment__author'; author.textContent = message.user;
    const body = doc.createElement('p'); body.className = 'pokome-comment__body'; body.textContent = message.text;
    card.append(author, body);
    return card;
  }));
}

export function markClippedComments(list) {
  if (!list.clientHeight) return;
  const bounds = list.getBoundingClientRect();
  for (const comment of list.querySelectorAll('.stage-comment')) {
    const rect = comment.getBoundingClientRect();
    // Long comments remain scrollable even when they cannot fit in one view.
    const clipped = rect.height <= list.clientHeight && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
    comment.classList.toggle('stage-comment-clipped', clipped);
  }
}

export const TALK_PANEL_SELECTORS = Object.freeze({ header: '.stage-header', chat: '.stage-chat', speech: '.stage-speech', actor: '.stage-actor', footer: '.stage-footer' });

// Read-only application of a saved talk layout, matching workspace.js outside
// of its editing mode. A null layout keeps the stylesheet's default grid.
export function applyTalkLayout(stage, layout) {
  for (const [id, selector] of Object.entries(TALK_PANEL_SELECTORS)) {
    const element = stage.querySelector(selector);
    if (!element) continue;
    element.classList.add('pokome-panel'); element.dataset.panelType = id;
    const p = layout?.panels?.[id];
    if (!p) { element.removeAttribute('style'); continue; }
    element.style.setProperty('position', 'absolute');
    for (const [property, value] of Object.entries({ left: p.x, top: p.y, width: p.w, height: p.h })) element.style.setProperty(property, `${value}%`);
    element.style.zIndex = p.z; element.style.maxHeight = 'none'; element.style.margin = '0';
    element.style.display = p.hidden ? 'none' : '';
  }
  const speech = stage.querySelector(TALK_PANEL_SELECTORS.speech);
  if (speech && layout?.panels?.speech) {
    const styles = talkSpeechStyles(layout.panels, parseFloat(getComputedStyle(speech).minHeight) || 0);
    for (const [id, values] of Object.entries(styles)) {
      const element = stage.querySelector(TALK_PANEL_SELECTORS[id]);
      if (element) for (const [property, value] of Object.entries(values)) element.style.setProperty(property, value);
    }
  }
}

// Comment list look. A value left at the theme's own setting removes its
// attribute or variable, so the stylesheet and theme CSS apply unchanged.
export function renderCommentLook(stage, studio) {
  // Important inline values: theme CSS cannot redefine them, even with !important.
  const set = (name, value) => value === null || value === '' ? stage.style.removeProperty(name) : stage.style.setProperty(name, value, 'important');
  const flag = (name, value) => value === null ? delete stage.dataset[name] : stage.dataset[name] = value;
  flag('commentPanel', studio.commentPanel === 'theme' ? null : studio.commentPanel);
  set('--stage-comment-opacity', ['light', 'dark'].includes(studio.commentPanel) ? String(studio.commentPanelOpacity / 100) : null);
  flag('commentItemBackground', studio.commentItemBackground === 'theme' ? null : studio.commentItemBackground);
  set('--stage-comment-item-opacity', ['light', 'dark'].includes(studio.commentItemBackground) ? String(studio.commentItemOpacity / 100) : null);
  flag('commentMaxLines', studio.commentMaxLines === null ? null : String(studio.commentMaxLines));
  set('--stage-comment-max-lines', studio.commentMaxLines > 0 ? String(studio.commentMaxLines) : null);
  flag('commentText', studio.commentTextColor ? '' : null);
  set('--stage-comment-text', studio.commentTextColor);
  flag('commentAuthor', studio.commentAuthorColor ? '' : null);
  set('--stage-comment-author', studio.commentAuthorColor);
  flag('commentOutline', studio.commentOutline === 'none' ? null : studio.commentOutline);
  set('--stage-comment-outline', studio.commentOutline === 'none' ? null : studio.commentOutlineColor);
  flag('commentLineHeight', studio.commentLineHeight === null ? null : '');
  set('--stage-comment-line-height', studio.commentLineHeight === null ? null : String(studio.commentLineHeight));
  flag('commentGap', studio.commentGap === null ? null : '');
  const itemBackground = ['light', 'dark'].includes(studio.commentItemBackground);
  set('--stage-comment-gap', studio.commentGap === null ? null : `${itemBackground ? studio.commentGap : studio.commentGap / 2}px`);
  flag('commentDivider', studio.commentDivider ? null : 'false');
  flag('commentLabel', studio.commentLabel ? null : 'false');
}
