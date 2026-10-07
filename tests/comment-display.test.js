import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStageComments } from '../src/browser/stage-appearance.js';
import { normalizeStudio, applyCommentPreset, COMMENT_PRESETS } from '../src/shared/studio.js';
import { prepareSpeechText } from '../src/browser/speech-options.js';
import { DEFAULT_SPEECH_OPTIONS } from '../src/shared/speech-options.js';

class Element {
  children = []; attributes = {}; styles = {};
  constructor(tag) { this.tag = tag; this.ownerDocument = { createElement: tag => new Element(tag) }; this.style = { setProperty: (key, value, priority) => { this.styles[key] = [value, priority]; } }; }
  set innerHTML(_) { throw Error('HTML parsing is forbidden'); }
  set textContent(value) { this.children = []; this.text = value; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
}
const message = { user: '<b>viewer</b>', text: '😀 Kappa hello', color: '#ffffff', badges: ['vip'], parts: [
  { type: 'text', text: '😀 ' }, { type: 'emote', id: '25', name: 'Kappa', url: 'https://evil.example' }, { type: 'text', text: ' hello' },
] };
const draw = studio => { const list = new Element('div'); renderStageComments(list, [message], normalizeStudio(studio)); return list.children[0]; };
const descendants = element => [element, ...element.children.flatMap(descendants)];

test('emotes use an ID-built URL with a textual fallback, and text mode creates no images', () => {
  const card = draw({});
  assert.equal(card.children[0].textContent, '<b>viewer</b>');
  const image = descendants(card).find(element => element.tag === 'img');
  assert.ok(image);
  assert.equal(image.attributes.src, 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0');
  assert.equal(image.attributes.alt, 'Kappa');
  assert.equal(image.attributes.title, 'Kappa');
  image.onerror();
  assert.equal(card.children[1].textContent, message.text);
  const plain = draw({ commentEmotes: 'text' });
  assert.equal(descendants(plain).some(element => element.tag === 'img'), false);
  assert.equal(plain.children[1].textContent, message.text);
});

const contrastWhite = hex => {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return 1.05 / (.2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] + .05);
};
test('service color adjusts only explicit white or black backgrounds and theme mode writes no color', () => {
  const color = settings => draw({ commentAuthorColor: 'service', ...settings }).children[0].styles.color;
  assert.deepEqual(color({ commentPanel: 'none' }), ['#ffffff', 'important']);
  assert.deepEqual(color({ commentPanel: 'dark' }), ['#ffffff', 'important']);
  assert.ok(contrastWhite(color({ commentPanel: 'light' })[0]) >= 3);
  assert.ok(contrastWhite(color({ commentPanel: 'dark', commentItemBackground: 'light' })[0]) >= 3);
  assert.deepEqual(color({ commentPanel: 'light', commentItemBackground: 'dark' }), ['#ffffff', 'important']);
  assert.equal(draw({}).children[0].styles.color, undefined);
  assert.equal(draw({ commentAuthorColor: '#123456' }).children[0].styles.color, undefined);
});

test('old designs retain theme names; new options normalize and stay independent of presets', () => {
  assert.equal(normalizeStudio({}).commentAuthorColor, '');
  assert.equal(normalizeStudio({}).commentEmotes, 'image');
  assert.equal(normalizeStudio({ commentAuthorColor: 'service', commentEmotes: 'text' }).commentAuthorColor, 'service');
  assert.equal(normalizeStudio({ commentAuthorColor: 'url(x)', commentEmotes: 'unknown' }).commentEmotes, 'image');
  for (const key of Object.keys(COMMENT_PRESETS)) assert.equal(applyCommentPreset({ commentEmotes: 'text' }, key).commentEmotes, 'text');
});

test('speech removes Twitch emotes in both display modes and skips emote-only posts', () => {
  assert.equal(prepareSpeechText(message.text, DEFAULT_SPEECH_OPTIONS, 'twitch', message.parts), '😀 hello');
  assert.equal(prepareSpeechText('Kappa', DEFAULT_SPEECH_OPTIONS, 'twitch', [{ type: 'emote', id: '25', name: 'Kappa' }]), '');
  assert.equal(prepareSpeechText('Kappa', DEFAULT_SPEECH_OPTIONS, 'twitch', [{ type: 'emote', id: '../bad', name: 'Kappa' }]), 'Kappa');
  assert.equal(prepareSpeechText('Kappa', DEFAULT_SPEECH_OPTIONS, 'kick', [{ type: 'emote', id: '25', name: 'Kappa' }]), 'Kappa');
});

test('role badges are opt-in, normalized and ordered, with Japanese labels and no external images', () => {
  assert.equal(normalizeStudio({}).commentBadges, false);
  assert.equal(normalizeStudio({ commentBadges: 'true' }).commentBadges, false);
  const list = new Element('div');
  renderStageComments(list, [{ ...message, badges: ['subscriber', 'unknown', 'vip', 'moderator', 'broadcaster', 'vip'] }], normalizeStudio({ commentBadges: true, commentEmotes: 'text' }));
  const badges = descendants(list).filter(element => element.className === 'pokome-comment__badge');
  assert.deepEqual(badges.map(element => element.attributes['aria-label']), ['配信者', 'モデレーター', 'VIP', 'サブスク']);
  assert.deepEqual(badges.map(element => element.textContent), ['♛', '⚑', '◆', '★']);
  assert.ok(badges.every(element => element.attributes.title === element.attributes['aria-label']));
  assert.equal(descendants(list).some(element => element.tag === 'img'), false);
  assert.equal(descendants(draw({})).some(element => element.className === 'pokome-comment__badge'), false);
  for (const key of Object.keys(COMMENT_PRESETS)) assert.equal(applyCommentPreset({ commentBadges: true }, key).commentBadges, true);
});
