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

test('chat count accepts 1–100, preserves older settings and rejects invalid counts', () => {
  for (const chatCount of [1, 3, 100]) {
    assert.equal(readStudio({ getItem: () => JSON.stringify({ chatCount }) }).chatCount, chatCount);
  }
  for (const chatCount of [0, -1, 101, 2.5, '3', null]) {
    assert.equal(normalizeStudio({ chatCount }).chatCount, 30);
  }
  assert.equal(normalizeStudio({ theme: 'rose' }).chatCount, 30);
});
