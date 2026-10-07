import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSettings, parseSettings, restoreSettings } from '../src/browser/settings-backup.js';
import { normalizeSettings, SETTINGS_FIELDS } from '../src/shared/settings-model.js';

const legacy = () => ({ format: 'pokome-settings', version: 1, settings: {
  'pokome-connections': '{"twitch":"EXAMPLE"}', 'pokome-auto-speech': '{"twitch":false}',
  'pokome-voices': '{}', 'pokome-speech-engines': '{}', 'pokome-speech-options': '{}', 'pokome-users-v2': '{}',
} });

test('backup roundtrip restores normalized operating settings through item saves', async () => {
  const source = normalizeSettings({ connections: { twitch: 'example' }, historyLimit: 42, users: { twitch: { viewer: { hidden: true } } } });
  const parsed = parseSettings(JSON.stringify(exportSettings(source)));
  const written = {};
  await restoreSettings({ set: async (field, value) => { written[field] = value; } }, parsed);
  assert.deepEqual(Object.keys(written), SETTINGS_FIELDS);
  assert.deepEqual(written, source);
  assert.equal(Object.hasOwn(written, 'studio'), false);
});

test('old backups ignore obsolete appearance and use only the old operating history count', () => {
  const old = legacy();
  Object.assign(old.settings, { 'pokome-studio': '{"listCount":12,"image":"obsolete"}',
    'pokome-theme-v1': 'old css', 'pokome-workspace-v1': '{obsolete', 'pokome-overlays-v1': '{obsolete' });
  const parsed = parseSettings(JSON.stringify(old));
  assert.equal(parsed.connections.twitch, 'example');
  assert.equal(parsed.autoSpeech.twitch, false);
  assert.equal(parsed.historyLimit, 12);
  assert.deepEqual(Object.keys(parsed), SETTINGS_FIELDS);
  old.settings['pokome-history-limit'] = '84';
  assert.equal(parseSettings(JSON.stringify(old)).historyLimit, 84);
  delete old.settings['pokome-history-limit']; old.settings['pokome-studio'] = '{obsolete';
  assert.equal(parseSettings(JSON.stringify(old)).historyLimit, 300);
});

test('invalid legacy backup documents and field encodings cannot be restored', () => {
  for (const mutate of [old => { old.format = 'other'; }, old => { old.version = 99; },
    old => { delete old.settings['pokome-connections']; }, old => { old.settings['unknown-key'] = '{}'; },
    old => { old.settings['pokome-voices'] = 'bad json'; }, old => { old.settings['pokome-users-v2'] = '[]'; },
    old => { old.settings['pokome-history-limit'] = '"many"'; }, old => { old.settings = 7; }]) {
    const old = legacy(); mutate(old); assert.throws(() => parseSettings(JSON.stringify(old)));
  }
});

test('a failed item restore stops, reports possible partial restoration and never rolls back another page', async () => {
  const writes = [], settings = normalizeSettings({ historyLimit: 42 });
  const cause = new Error('保存先に書き込めません。');
  await assert.rejects(restoreSettings({ set: async (field, value) => {
    writes.push([field, value]); if (field === 'voices') throw cause;
  } }, settings), error => { assert.match(error.message, /一部の項目だけ/); assert.equal(error.cause, cause); return true; });
  assert.deepEqual(writes.map(([field]) => field), ['connections', 'autoSpeech', 'voices']);
});

test('legacy backups preserve saved values but exclude local voice metadata', () => {
  const old = legacy(); old.settings['pokome-speech-engines'] = JSON.stringify({ twitch: { engine: 'voicevox', voicevox: '2', speakerName: 'ignored' } });
  const parsed = parseSettings(JSON.stringify(old));
  assert.equal(parsed.speechEngines.twitch.voicevox, '2');
  assert.equal(Object.hasOwn(parsed.speechEngines.twitch, 'speakerName'), false);
});
