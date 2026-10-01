import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STUDIO, normalizeStudio, readStudio, readSavedVoices } from '../studio.js';

test('studio settings validate styles, bounds and raster data without accepting arbitrary sources', () => {
  assert.deepEqual(normalizeStudio(null), DEFAULT_STUDIO);
  assert.deepEqual(normalizeStudio({ theme: 'bad', accent: 'url(x)', fontSize: 100, actorWidth: 0, source: 'iframe', image: 'https://example.com/private' }), DEFAULT_STUDIO);
  const valid = { ...DEFAULT_STUDIO, theme: 'rose', layout: 'left', source: 'image', image: 'data:image/png;base64,aGVsbG8=', fontSize: 28, actorWidth: 60, decoration: false };
  assert.deepEqual(normalizeStudio(valid), valid);
  assert.equal(normalizeStudio({ image: 'data:image/svg+xml;base64,aGVsbG8=' }).image, '');
  assert.equal(normalizeStudio({ source: 'camera' }).source, 'space');
  assert.equal(normalizeStudio({ title: 'a'.repeat(100) }).title.length, 60);
  assert.deepEqual(readStudio({ getItem: () => JSON.stringify(valid) }), valid);
  assert.deepEqual(readStudio({ getItem: () => '{broken' }), DEFAULT_STUDIO);
});

test('voice preferences restore separately and tolerate invalid storage', () => {
  assert.deepEqual(readSavedVoices({ getItem: () => JSON.stringify({ twitch: 'Japanese voice', kick: 'Other voice' }) }), { twitch: 'Japanese voice', kick: 'Other voice' });
  assert.deepEqual(readSavedVoices({ getItem: () => JSON.stringify({ twitch: null, kick: false }) }), { twitch: '', kick: '' });
  assert.deepEqual(readSavedVoices(undefined), { twitch: '', kick: '' });
});

test('speech heading and font size persist with safe bounds and legacy defaults', () => {
  const saved = readStudio({ getItem: () => JSON.stringify({ speechTitle: 'あなたからのお便り', speechFontSize: 28 }) });
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
  const value = readStudio({ getItem: () => JSON.stringify({ speechStyle: 'bubble', speechBackground: '#ffeedd' }) });
  assert.equal(value.speechStyle, 'bubble');
  assert.equal(value.speechBackground, '#ffeedd');
  for (const speechBackground of ['red', '#abc', 'url(x)', null]) {
    assert.equal(normalizeStudio({ speechBackground }).speechBackground, DEFAULT_STUDIO.speechBackground);
  }
  assert.equal(normalizeStudio({ speechStyle: 'invalid' }).speechStyle, 'image');
  assert.equal(normalizeStudio({ title: '旧設定' }).speechStyle, 'image');
});

test('retained count accepts 1–300 and ignores old visible-count settings', () => {
  for (const listCount of [1, 3, 300]) {
    assert.equal(readStudio({ getItem: () => JSON.stringify({ listCount }) }).listCount, listCount);
  }
  for (const listCount of [0, -1, 301, 2.5, '3', null]) {
    assert.equal(normalizeStudio({ listCount }).listCount, 300);
  }
  assert.equal(normalizeStudio({ chatCount: 30 }).listCount, 300);
});

test('speech images accept only bounded raster data and preserve independent actor images', () => {
  const speechImage = 'data:image/png;base64,aGVsbG8=';
  const value = readStudio({ getItem: () => JSON.stringify({ speechImage, speechStyle: 'image', speechTextColor: '#abcdef', image: 'data:image/jpeg;base64,YWJj' }) });
  assert.equal(value.speechImage, speechImage);
  assert.equal(value.image, 'data:image/jpeg;base64,YWJj');
  assert.equal(value.speechTextColor, '#abcdef');
  for (const speechImage of ['https://example.com/a.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,' + 'a'.repeat(2800000), null]) {
    assert.equal(normalizeStudio({ speechImage }).speechImage, '');
  }
  assert.equal(normalizeStudio({ speechTextColor: 'url(x)' }).speechTextColor, DEFAULT_STUDIO.speechTextColor);
});

test('footer text persists including empty text and validates legacy settings', () => {
  assert.equal(readStudio({ getItem: () => JSON.stringify({ footer: 'のんびりしていってね' }) }).footer, 'のんびりしていってね');
  assert.equal(normalizeStudio({ footer: '' }).footer, '');
  assert.equal(normalizeStudio({ footer: 'a'.repeat(150) }).footer.length, 100);
  assert.equal(normalizeStudio({ footer: null }).footer, DEFAULT_STUDIO.footer);
});
