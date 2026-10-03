import { THEME_ACCENTS } from './studio.js';

// The live stage and script-free design preview share exactly the same visual
// renderer. It cannot save settings, trim history, connect chat or play audio.
export function renderStageAppearance(stage, studio, defaultImage = './speech-background.svg') {
  const $ = id => stage.querySelector(`#${id}`);
  stage.dataset.theme = studio.theme;
  stage.dataset.layout = studio.layout;
  stage.dataset.decorated = String(studio.decoration);
  stage.style.setProperty('--stage-accent', studio.accentMode === 'theme' ? THEME_ACCENTS[studio.theme] : studio.accent);
  stage.style.setProperty('--stage-font-size', `${studio.fontSize}px`);
  $('stage-chat-list').dataset.commentStyle = studio.commentStyle;
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
  for (const item of state.items) {
    let element = existing.get(item.id);
    if (!element) {
      element = stage.ownerDocument.createElement('div');
      element.className = 'pokome-overlay'; element.dataset.overlayId = item.id;
      stage.append(element);
    }
    existing.delete(item.id);
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
}
