import test from 'node:test';
import assert from 'node:assert/strict';
test('comment styles persist and unknown styles use the default', () => {
  for (const commentStyle of ['stacked', 'anonymous', 'inline', 'compact']) assert.equal(normalizeStudio({ commentStyle }).commentStyle, commentStyle);
  assert.equal(normalizeStudio({ commentStyle: 'unknown' }).commentStyle, 'stacked');
});
import { DEFAULT_STUDIO, normalizeStudio, readSavedVoices, HISTORY_LIMIT_KEY, readHistoryLimit, normalizeHistoryLimit, COMMENT_PRESETS, applyCommentPreset, matchCommentPreset } from '../src/shared/studio.js';

test('studio settings validate styles, bounds and raster data without accepting arbitrary sources', () => {
  assert.deepEqual(normalizeStudio(null), DEFAULT_STUDIO);
  assert.deepEqual(normalizeStudio({ theme: 'bad', accent: 'url(x)', fontSize: 100, actorWidth: 0, source: 'iframe', image: 'https://example.com/private' }), DEFAULT_STUDIO);
  const valid = { ...DEFAULT_STUDIO, theme: 'rose', layout: 'left', source: 'image', image: 'data:image/png;base64,aGVsbG8=', fontSize: 28, actorWidth: 60, decoration: false };
  assert.deepEqual(normalizeStudio(valid), valid);
  assert.equal(normalizeStudio({ image: 'data:image/svg+xml;base64,aGVsbG8=' }).image, '');
  assert.equal(normalizeStudio({ source: 'camera' }).source, 'space');
  assert.equal(normalizeStudio({ title: 'a'.repeat(100) }).title.length, 60);
  assert.deepEqual(normalizeStudio(valid), valid);
  assert.deepEqual(normalizeStudio('{broken'), DEFAULT_STUDIO);
});

test('voice preferences restore separately and tolerate invalid storage', () => {
  assert.deepEqual(readSavedVoices({ getItem: () => JSON.stringify({ twitch: 'Japanese voice', kick: 'Other voice' }) }), { twitch: 'Japanese voice', kick: 'Other voice' });
  assert.deepEqual(readSavedVoices({ getItem: () => JSON.stringify({ twitch: null, kick: false }) }), { twitch: '', kick: '' });
  assert.deepEqual(readSavedVoices(undefined), { twitch: '', kick: '' });
});

test('speech heading and font size persist with safe bounds and legacy defaults', () => {
  const saved = normalizeStudio({ speechTitle: 'あなたからのお便り', speechFontSize: 28 });
  assert.equal(saved.speechTitle, 'あなたからのお便り');
  assert.equal(saved.speechFontSize, 28);
  assert.equal(normalizeStudio({ speechTitle: 'a'.repeat(80) }).speechTitle.length, 40);
  assert.equal(normalizeStudio({ speechTitle: null }).speechTitle, DEFAULT_STUDIO.speechTitle);
  for (const speechFontSize of [0, 15, 33, 22.5, '28', null]) {
    assert.equal(normalizeStudio({ speechFontSize }).speechFontSize, 22);
  }
  assert.equal(normalizeStudio({ title: '旧設定' }).speechFontSize, 22);
});

test('speech bubble appearance restores and rejects invalid styles and colors', () => {
  const value = normalizeStudio({ speechStyle: 'bubble', speechBackground: '#ffeedd' });
  assert.equal(value.speechStyle, 'bubble');
  assert.equal(value.speechBackground, '#ffeedd');
  for (const speechBackground of ['red', '#abc', 'url(x)', null]) {
    assert.equal(normalizeStudio({ speechBackground }).speechBackground, DEFAULT_STUDIO.speechBackground);
  }
  assert.equal(normalizeStudio({ speechStyle: 'invalid' }).speechStyle, 'image');
  assert.equal(normalizeStudio({ title: '旧設定' }).speechStyle, 'image');
});

test('the history limit is kept apart from the design and accepts 1–300', () => {
  for (const limit of [1, 3, 300]) assert.equal(readHistoryLimit({ getItem: key => key === HISTORY_LIMIT_KEY ? JSON.stringify(limit) : null }), limit);
  for (const limit of [0, -1, 301, 2.5, '3', null]) assert.equal(normalizeHistoryLimit(limit), 300);
  assert.equal(readHistoryLimit({ getItem: () => '{broken' }), 300);
  assert.equal(readHistoryLimit(), 300);
  assert.equal(Object.hasOwn(normalizeStudio({ listCount: 12 }), 'listCount'), false);
});

test('speech images accept only bounded raster data and preserve independent actor images', () => {
  const speechImage = 'data:image/png;base64,aGVsbG8=';
  const value = normalizeStudio({ speechImage, speechStyle: 'image', speechTextColor: '#abcdef', image: 'data:image/jpeg;base64,YWJj' });
  assert.equal(value.speechImage, speechImage);
  assert.equal(value.image, 'data:image/jpeg;base64,YWJj');
  assert.equal(value.speechTextColor, '#abcdef');
  for (const speechImage of ['https://example.com/a.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,' + 'a'.repeat(2800000), null]) {
    assert.equal(normalizeStudio({ speechImage }).speechImage, '');
  }
  assert.equal(normalizeStudio({ speechTextColor: 'url(x)' }).speechTextColor, DEFAULT_STUDIO.speechTextColor);
});

test('footer text persists including empty text and validates legacy settings', () => {
  assert.equal(normalizeStudio({ footer: 'のんびりしていってね' }).footer, 'のんびりしていってね');
  assert.equal(normalizeStudio({ footer: '' }).footer, '');
  assert.equal(normalizeStudio({ footer: 'a'.repeat(150) }).footer.length, 100);
  assert.equal(normalizeStudio({ footer: null }).footer, DEFAULT_STUDIO.footer);
});


test('accent modes preserve custom colors and infer legacy settings', () => {
  assert.equal(normalizeStudio({ theme: 'rose', accent: '#efb4c5' }).accentMode, 'theme');
  assert.equal(normalizeStudio({ theme: 'rose', accent: '#123456' }).accentMode, 'custom');
  assert.equal(normalizeStudio({ theme: 'mint', accent: '#ACE5CD' }).accentMode, 'theme');
  assert.equal(normalizeStudio({ accentMode: 'theme', accent: '#123456' }).accent, '#123456');
  assert.equal(normalizeStudio({ accentMode: 'custom', accent: '#ace5cd' }).accentMode, 'custom');
});

test('comment look settings accept only listed values and keep theme defaults otherwise', () => {
  const look = normalizeStudio({ commentPanel: 'dark', commentPanelOpacity: 40, commentTextColor: '#ABCDEF', commentAuthorColor: '#123456',
    commentOutline: 'thick', commentOutlineColor: '#FF0000', commentLineHeight: 1.5, commentGap: 8, commentDivider: false, commentLabel: false });
  assert.deepEqual([look.commentPanel, look.commentPanelOpacity, look.commentTextColor, look.commentAuthorColor, look.commentOutline, look.commentOutlineColor, look.commentLineHeight, look.commentGap, look.commentDivider, look.commentLabel],
    ['dark', 40, '#abcdef', '#123456', 'thick', '#ff0000', 1.5, 8, false, false]);
  const invalid = normalizeStudio({ commentPanel: 'url(x)', commentPanelOpacity: 101, commentTextColor: 'red', commentAuthorColor: 'var(--x)',
    commentOutline: 'huge', commentOutlineColor: '#00000', commentLineHeight: 1.4, commentGap: '8', commentDivider: 'no', commentLabel: 0 });
  assert.deepEqual(invalid, DEFAULT_STUDIO);
  assert.equal(normalizeStudio({ commentPanelOpacity: 12.5 }).commentPanelOpacity, DEFAULT_STUDIO.commentPanelOpacity);
});

test('comment presets switch every look setting and are recognized until adjusted', () => {
  const base = normalizeStudio({ commentStyle: 'inline', title: 'kept' });
  // A different comment format is a custom mix, not the theme preset.
  assert.equal(matchCommentPreset(base), '');
  assert.equal(matchCommentPreset(normalizeStudio()), 'theme');
  for (const name of Object.keys(COMMENT_PRESETS)) {
    const applied = applyCommentPreset(base, name);
    assert.equal(matchCommentPreset(applied), name);
    assert.equal(applied.title, 'kept');
    assert.equal(applied.commentStyle, ['dense', 'chips'].includes(name) ? 'anonymous' : 'stacked');
    // Presets are complete: applying one after another leaves no residue.
    assert.equal(matchCommentPreset(applyCommentPreset(applyCommentPreset(base, 'dense'), name)), name);
  }
  assert.equal(matchCommentPreset({ ...applyCommentPreset(base, 'light'), commentPanelOpacity: 80 }), '');
  assert.deepEqual(applyCommentPreset(base, 'unknown'), base);
  // Returning from 本文だけ高密度 shows names again.
  assert.equal(applyCommentPreset(applyCommentPreset(base, 'dense'), 'theme').commentStyle, 'stacked');
});

test('comment font sizes include 56 and 64px without extending speech sizes', () => {
  for (const fontSize of [16, 28, 56, 64]) assert.equal(normalizeStudio({ fontSize }).fontSize, fontSize);
  for (const fontSize of [15, 65, 56.5, '56', null]) assert.equal(normalizeStudio({ fontSize }).fontSize, 20);
  assert.equal(normalizeStudio({ fontSize: 56, speechFontSize: 33 }).speechFontSize, 22);
  assert.equal(normalizeStudio({ fontSize: 56, speechFontSize: 32 }).speechFontSize, 32);
});

test('small appearance settings validate values and keep legacy designs at the theme', () => {
  const legacy = normalizeStudio({ fontSize: 24, commentStyle: 'compact' });
  assert.deepEqual([legacy.actorAppearance, legacy.commentItemBackground, legacy.commentItemOpacity, legacy.commentMaxLines], ['theme', 'theme', 92, null]);
  const saved = normalizeStudio({ actorAppearance: 'none', commentItemBackground: 'light', commentItemOpacity: 92, commentMaxLines: 2, commentGap: 14 });
  assert.deepEqual([saved.actorAppearance, saved.commentItemBackground, saved.commentItemOpacity, saved.commentMaxLines, saved.commentGap], ['none', 'light', 92, 2, 14]);
  for (const commentMaxLines of [0, 1, 2, 3, 4, 5]) assert.equal(normalizeStudio({ commentMaxLines }).commentMaxLines, commentMaxLines);
  for (const commentItemBackground of ['theme', 'none', 'light', 'dark']) assert.equal(normalizeStudio({ commentItemBackground }).commentItemBackground, commentItemBackground);
  assert.deepEqual(normalizeStudio({ actorAppearance: true, commentItemBackground: 'url(x)', commentItemOpacity: 101, commentMaxLines: '2' }), DEFAULT_STUDIO);
  for (const commentMaxLines of [-1, 6, 2.5, false]) assert.equal(normalizeStudio({ commentMaxLines }).commentMaxLines, null);
  for (const commentItemOpacity of [-1, 101, 92.5, '92', null]) assert.equal(normalizeStudio({ commentItemOpacity }).commentItemOpacity, 92);
});

test('round chips keep font size and output behavior and old presets remove their appearance', () => {
  const original = normalizeStudio({ fontSize: 56, speechFontSize: 32, maxVisible: 3, holdSeconds: 15, newestPosition: 'top', actorAppearance: 'none' });
  const chips = applyCommentPreset(original, 'chips');
  assert.equal(matchCommentPreset(chips), 'chips');
  assert.deepEqual([chips.commentPanel, chips.commentItemBackground, chips.commentItemOpacity, chips.commentMaxLines, chips.commentGap, chips.commentStyle], ['none', 'light', 92, 2, 14, 'anonymous']);
  for (const key of ['fontSize', 'speechFontSize', 'maxVisible', 'holdSeconds', 'newestPosition', 'actorAppearance']) assert.equal(chips[key], original[key]);
  for (const name of ['theme', 'outline', 'light', 'dark', 'dense']) {
    const restored = applyCommentPreset(chips, name);
    assert.deepEqual([restored.commentItemBackground, restored.commentItemOpacity, restored.commentMaxLines], ['theme', 92, null]);
    assert.equal(matchCommentPreset(restored), name);
  }
  assert.equal(matchCommentPreset({ ...chips, commentMaxLines: 3 }), '');
});
