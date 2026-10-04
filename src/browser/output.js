import { compileTheme } from '../shared/theme.js';
import { createDesignStore } from './design-client.js';
import { resolveStudioImages, resolveOverlayAssets, nearestRatio, talkLayout, talkOverlays } from '../shared/design-model.js';
import { renderStageAppearance, renderOverlays, renderStageComments, selectOutputComments, markClippedComments, applyTalkLayout } from './stage-appearance.js';
import { OUTPUT_CHANNEL, HEARTBEAT_MS, parseOutputOptions, normalizeOutputMessage, createOutputView, applyOutputMessage } from '../shared/output-protocol.js';

// The stream output only renders. It has no chat connection, no audio and no
// controls: the control page publishes live state over a BroadcastChannel and
// appearance comes from the local server, which announces every change. That
// also reaches an OBS browser source, whose browser storage is separate.
const options = parseOutputOptions(location.search, typeof window.obsstudio === 'object' && window.obsstudio !== null);
document.body.dataset.background = options.background;
document.body.style.setProperty('--output-key', options.key);
let studio;
const designStore = await createDesignStore();
const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// The stage markup lives in index.html; share it instead of duplicating it.
const source = new DOMParser().parseFromString(await (await fetch('./', { cache: 'no-cache' })).text(), 'text/html');
const stage = document.importNode(source.getElementById('talk-stage'), true);
for (const element of stage.querySelectorAll('.stage-actions,dialog,[popover],.stage-font-controls,#stage-comment-settings,script,iframe,object,embed,link,input,select,textarea,output')) element.remove();
// Keep the speaker icon and other content; only the controls disappear.
for (const button of stage.querySelectorAll('button')) button.replaceWith(...button.childNodes);
stage.hidden = false;
stage.removeAttribute('tabindex');
stage.classList.add('pokome-workspace');
stage.setAttribute('aria-hidden', 'true');
document.querySelector('main').append(stage);
const theme = document.createElement('style');
theme.id = 'pokome-user-theme';
document.head.append(theme);
const $ = elementId => stage.querySelector(`#${elementId}`);

// The output uses the layout of the ratio closest to its own size (for example
// 1080×1920 shows the 9:16 layout), never another ratio's.
let shownRatio = '';
function renderAppearance() {
  const design = designStore.design, ratio = nearestRatio(innerWidth, innerHeight);
  shownRatio = ratio;
  document.body.dataset.ratio = ratio;
  studio = design.studio;
  renderStageAppearance(stage, resolveStudioImages(studio));
  renderOverlays(stage, resolveOverlayAssets(talkOverlays(design, ratio)));
  try { theme.textContent = compileTheme(design.theme); } catch { theme.textContent = ''; }
  applyTalkLayout(stage, talkLayout(design, ratio));
  renderChat();
}

const view = createOutputView();
let expiryTimer;
function alignNewest() {
  const list = $('stage-chat-list');
  list.scrollTop = studio.newestPosition === 'top' ? 0 : list.scrollHeight;
  markClippedComments(list);
}
function renderChat() {
  const list = $('stage-chat-list');
  clearTimeout(expiryTimer);
  const now = Date.now();
  const selected = selectOutputComments(view.messages, studio, now);
  renderStageComments(list, selected);
  alignNewest();
  if (studio.holdSeconds && selected.length) {
    const next = Math.min(...selected.map(message => message.receivedAt + studio.holdSeconds * 1000));
    expiryTimer = setTimeout(renderChat, Math.max(1, Math.min(2147483647, next - now)));
  }
  $('stage-count').textContent = `${view.received} COMMENTS`;
}
function renderSpeech() {
  // No placeholder text: an idle output shows nothing a viewer must read.
  $('stage-speech-status').textContent = view.speech?.speaking ? '読み上げ中' : '待機中';
  $('stage-speech-user').textContent = view.speech?.user || '';
  $('stage-speech-text').textContent = view.speech?.text || '';
  stage.querySelector('.stage-speech').dataset.speaking = String(!!view.speech?.speaking);
  $('stage-speech-credit').textContent = view.credit;
  $('stage-speech-credit').hidden = !view.credit;
}

// Not requestAnimationFrame: it never fires while the window is hidden or
// covered, and the output must still be current when it reappears.
let appearanceTimer;
function scheduleAppearance() {
  clearTimeout(appearanceTimer);
  appearanceTimer = setTimeout(renderAppearance, 50);
}
designStore.subscribe(scheduleAppearance);
addEventListener('resize', () => { if (nearestRatio(innerWidth, innerHeight) !== shownRatio) scheduleAppearance(); });
// Nobody can scroll the output, so a resize must keep the newest comment in view.
new ResizeObserver(() => {
  alignNewest();
}).observe($('stage-chat-list'));
renderAppearance();
renderSpeech();

if (typeof BroadcastChannel === 'function') {
  const channel = new BroadcastChannel(OUTPUT_CHANNEL);
  const presence = type => channel.postMessage({ v: 1, type, id, role: 'output', width: innerWidth, height: innerHeight, background: options.background });
  channel.onmessage = event => {
    const result = applyOutputMessage(view, normalizeOutputMessage(event.data));
    if (result.resync) presence('hello');
    if (result.changed) { renderChat(); renderSpeech(); }
  };
  presence('hello');
  setInterval(() => presence('heartbeat'), HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { renderAppearance(); presence('hello'); } });
  window.addEventListener('resize', () => presence('heartbeat'));
  window.addEventListener('pagehide', () => presence('bye'));
}
