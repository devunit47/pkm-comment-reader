import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_KEYS, exportSettings, parseSettings, restoreSettings } from '../settings-backup.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
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
  const malformed = exportSettings(storage()); malformed.settings['pokome-studio'] = 'bad json';
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
