import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, settingsDocument, SETTINGS_FIELDS } from '../src/shared/settings-model.js';

test('settings retain existing defaults and isolate operating fields from appearance', () => {
  const settings = normalizeSettings({ studio: { title: 'private' }, output: { size: '1080x1920' } });
  assert.deepEqual(Object.keys(settings), SETTINGS_FIELDS);
  assert.equal(settings.historyLimit, 300);
  assert.deepEqual(settings.autoSpeech, { twitch: true, kick: true });
  assert.deepEqual(settings.output, { background: 'theme', key: '00ff00' });
  assert.equal(settings.setupComplete, false);
  assert.deepEqual(normalizeSettings(null), settings);
});

test('settings normalize untrusted values and preserve valid service-specific rules', () => {
  const input = JSON.parse('{"users":{"twitch":{"__proto__":{"hidden":true},"viewer":{"hidden":true,"muted":"true"},"empty":{},"both":{"hidden":true,"muted":true}},"kick":[]}}');
  Object.assign(input, {
    connections: { twitch: 'EXAMPLE', kick: '../invalid' }, voices: { twitch: 'voice-uri', kick: 'x'.repeat(501) },
    autoSpeech: { twitch: false, kick: 'false' }, historyLimit: 42, setupComplete: true,
    speechEngines: { twitch: { engine: 'voicevox', voicevox: '7', coeiroink: 'invalid' } },
    speechOptions: { twitch: { maxLength: 200, skipNightbot: false, userInterval: 5, unknown: 1 }, kick: { maxLength: 999 } },
    output: { background: 'key', key: 'ff00ff', size: '1080x1920' },
  });
  const settings = normalizeSettings(input);
  assert.deepEqual(settings.connections, { twitch: 'example', kick: '' });
  assert.deepEqual(settings.voices, { twitch: 'voice-uri', kick: '' });
  assert.deepEqual(settings.autoSpeech, { twitch: false, kick: true });
  assert.equal(settings.speechEngines.twitch.voicevox, '7');
  assert.equal(settings.speechEngines.twitch.coeiroink, '');
  assert.equal(settings.speechOptions.twitch.maxLength, 200);
  assert.equal(settings.speechOptions.kick.maxLength, 100);
  assert.equal(settings.speechOptions.twitch.skipNightbot, false);
  assert.equal(Object.hasOwn(settings.speechOptions.twitch, 'unknown'), false);
  assert.deepEqual(settings.users.twitch.viewer, { hidden: true, muted: false });
  assert.equal(Object.hasOwn(settings.users.twitch, 'empty'), false);
  assert.equal(Object.hasOwn(settings.users.twitch, '__proto__'), true);
  assert.deepEqual(settings.users.kick, {});
  assert.equal({}.hidden, undefined);
  assert.deepEqual(settings.output, { background: 'key', key: 'ff00ff' });
  assert.equal(settingsDocument(settings).version, 2);
  assert.equal(settingsDocument(settings).format, 'pokome-settings');
  assert.deepEqual(normalizeSettings(settings), settings);
  settings.users.twitch.viewer.hidden = false;
  assert.equal(input.users.twitch.viewer.hidden, true, 'normalization must detach saved input');
});

test('malformed collections do not expose inherited preferences', () => {
  const result = normalizeSettings({ users: { twitch: Object.create({ inherited: { hidden: true } }) },
    autoSpeech: [], speechOptions: null, historyLimit: '10', setupComplete: 'true' });
  assert.deepEqual(result.users, { twitch: {}, kick: {} });
  assert.equal(result.historyLimit, 300);
  assert.equal(result.setupComplete, false);
});
