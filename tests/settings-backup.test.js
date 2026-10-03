import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_KEYS, LEGACY_APPEARANCE_KEYS, exportSettings, parseSettings, restoreSettings, extractLegacyAppearance, dataUrlToBlob } from '../settings-backup.js';
import { HISTORY_LIMIT_KEY } from '../studio.js';

test('quota rollback removes partial writes before restoring larger original values', () => {
  const target = storage();
  const write = target.setItem;
  target.setItem = (key, value) => {
    const next = { ...exportSettings(target).settings, [key]: value };
    if (Object.values(next).reduce((size, item) => size + (item?.length || 0), 0) > 200) throw new Error('Quota');
    write(key, value);
  };
  target.setItem('pokome-connections', 'x'.repeat(150));
  const before = exportSettings(target);
  const after = exportSettings(storage()).settings;
  after['pokome-connections'] = 'x'.repeat(10);
  after['pokome-auto-speech'] = 'x'.repeat(150);
  after['pokome-voices'] = 'x'.repeat(80);
  assert.throws(() => restoreSettings(target, after), /Quota/);
  assert.deepEqual(exportSettings(target), before);
});

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('rollback failure preserves both errors and the original cause', () => {
  const target = storage();
  target.setItem('pokome-connections', '{}');
  const original = new Error('Restore quota');
  const rollback = new Error('Storage unavailable');
  let writes = 0;
  target.setItem = () => { throw ++writes === 1 ? original : rollback; };
  const after = exportSettings(storage()).settings;
  after['pokome-connections'] = '{"twitch":"new"}';
  assert.throws(() => restoreSettings(target, after), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, rollback]);
    return true;
  });
});
test('backup roundtrip includes settings and excludes unrelated origin data', () => {
  const source = storage(); source.setItem('pokome-connections', '{"twitch":"example"}'); source.setItem('other-app', 'secret');
  const data = exportSettings(source);
  assert.equal(Object.hasOwn(data.settings, 'other-app'), false);
  const destination = storage(); destination.setItem('other-app', 'keep');
  restoreSettings(destination, parseSettings(JSON.stringify(data)));
  assert.equal(destination.getItem('pokome-connections'), source.getItem('pokome-connections'));
  assert.equal(destination.getItem('other-app'), 'keep');
});
test('invalid and incomplete backups cannot be restored', () => {
  assert.throws(() => parseSettings('{"format":"other","version":1,"settings":{}}'));
  const data = exportSettings(storage()); delete data.settings[SETTINGS_KEYS[0]];
  assert.throws(() => parseSettings(JSON.stringify(data)));
  const malformed = exportSettings(storage()); malformed.settings['pokome-voices'] = 'bad json';
  assert.throws(() => parseSettings(JSON.stringify(malformed)));
});
test('storage failure rolls back previously applied entries', () => {
  const target = storage(); target.setItem('pokome-connections', '{"twitch":"old"}');
  const before = exportSettings(target);
  const after = exportSettings(storage()).settings; after['pokome-connections'] = '{"twitch":"new"}';
  const write = target.setItem; let fail = true;
  target.setItem = (key, value) => { if (key === 'pokome-auto-speech' && fail) { fail = false; throw new Error('Quota'); } write(key, value); };
  after['pokome-auto-speech'] = '{}';
  assert.throws(() => restoreSettings(target, after));
  assert.deepEqual(exportSettings(target), before);
});

test('new backups hold operating settings only, never the appearance or images', () => {
  const source = storage();
  for (const key of LEGACY_APPEARANCE_KEYS) source.setItem(key, '{}');
  source.setItem(HISTORY_LIMIT_KEY, '42');
  const data = exportSettings(source);
  for (const key of LEGACY_APPEARANCE_KEYS) assert.equal(Object.hasOwn(data.settings, key), false, key);
  assert.equal(data.settings[HISTORY_LIMIT_KEY], '42');
  const parsed = parseSettings(JSON.stringify(data));
  assert.equal(extractLegacyAppearance(parsed), null);
  const restored = storage(); restoreSettings(restored, parsed);
  assert.equal(restored.getItem(HISTORY_LIMIT_KEY), '42');
  const unknown = exportSettings(storage()); unknown.settings['unknown-key'] = '{}';
  assert.throws(() => parseSettings(JSON.stringify(unknown)));
  const badLimit = exportSettings(storage()); badLimit.settings[HISTORY_LIMIT_KEY] = '"many"';
  assert.throws(() => parseSettings(JSON.stringify(badLimit)));
});

// Backups made by the browser-only (GitHub Pages) edition carried the appearance.
test('browser-era backups still restore, and their appearance and images can be imported into the folder', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const talk = { panels: Object.fromEntries(['header', 'chat', 'speech', 'actor', 'footer'].map((id, index) => [id, { x: index * 10, y: 0, w: 10, h: 10, z: 1, hidden: false }])) };
  const old = { format: 'pokome-settings', version: 1, settings: {
    'pokome-connections': '{"twitch":"example"}', 'pokome-auto-speech': '{}', 'pokome-voices': '{}', 'pokome-speech-engines': '{}',
    'pokome-speech-options': '{}', 'pokome-users-v2': '{}',
    'pokome-studio': JSON.stringify({ title: '旧タイトル', image: png, speechImage: png, listCount: 12 }),
    'pokome-workspace-v1': JSON.stringify({ version: 1, home: null, talk }),
    'pokome-theme-v1': '.pokome-workspace{}',
    'pokome-overlays-v1': JSON.stringify({ version: 1, items: [{ id: 'item-1', type: 'image', assetId: 'asset-1' }], assets: { 'asset-1': png } }),
  } };
  const parsed = parseSettings(JSON.stringify(old));
  assert.equal(parsed[HISTORY_LIMIT_KEY], '12', 'the old history limit moves to its own key');
  const legacy = extractLegacyAppearance(parsed);
  assert.equal(legacy.studio.title, '旧タイトル');
  assert.equal(legacy.studio.image, png);
  assert.equal(legacy.theme, '.pokome-workspace{}');
  assert.equal(legacy.talk.panels.chat.x, 10);
  assert.equal(legacy.overlays.assets['asset-1'], png);
  const blob = dataUrlToBlob(png);
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, Buffer.from(png.split(',')[1], 'base64').length);
  assert.throws(() => dataUrlToBlob('data:image/svg+xml;base64,PHN2Zy8+'));
  const restored = storage(); restoreSettings(restored, parsed);
  assert.equal(restored.getItem('pokome-connections'), '{"twitch":"example"}');
  for (const key of LEGACY_APPEARANCE_KEYS) assert.equal(restored.getItem(key), null, key);
});
