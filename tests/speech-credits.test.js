import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocalVoices, speechCredit, speechDisplayCredits, readSpeechEngines, validLocalVoiceId } from '../speech-engine.js';
import { exportSettings, parseSettings, restoreSettings } from '../settings-backup.js';

const uuid = '3c37646f-3881-5374-2a83-149267990abc';
const voices = [
  { id: '3', speakerName: 'ずんだもん', styleName: 'ノーマル' },
  { id: '1', speakerName: 'ずんだもん', styleName: 'あまあま' },
  { id: '2', speakerName: '四国めたん', styleName: 'ノーマル' },
];

test('credits use structured character names, retain characters across styles, and distinguish engines', () => {
  assert.equal(speechCredit('voicevox', '3', voices), 'VOICEVOX:ずんだもん');
  assert.equal(speechCredit('voicevox', '1', voices), 'VOICEVOX:ずんだもん');
  assert.equal(speechCredit('voicevox', '2', voices), 'VOICEVOX:四国めたん');
  assert.equal(speechCredit('coeiroink', uuid + ':0', [{ id: uuid + ':0', speakerName: 'つくよみちゃん', styleName: 'れいせい' }]), 'COEIROINK:つくよみちゃん');
  assert.equal(speechCredit('voicevox', '3', [{ id: '3', speakerName: '作者 / 名称', styleName: '通常 / 特別' }]), 'VOICEVOX:作者 / 名称');
});

test('missing, stale, malformed and display-only metadata cannot imply an attributed character', () => {
  for (const metadata of [null, [], {}, [{ id: '3', name: '古い名前 / 通常' }], [{ id: '3', speakerName: 42 }], [{ id: '3', speakerName: '  ' }], [{ id: '3', speakerName: 'x'.repeat(201) }], [{ id: '3', speakerName: '名\n前' }]]) {
    assert.equal(speechCredit('voicevox', '3', metadata), 'VOICEVOX:音声名未取得');
  }
  assert.equal(speechCredit('voicevox', '99', voices), 'VOICEVOX:音声名未取得');
  for (const engine of ['browser', 'other', '__proto__', 'constructor']) assert.equal(speechCredit(engine, '3', voices), '');
});

test('voice normalization validates IDs, handles missing names, deduplicates and never splits or interprets markup', () => {
  const name = '<img src=x onerror=alert(1)> / 別名';
  const list = normalizeLocalVoices('voicevox', [null, { id: '-1' }, { id: '1000000000' }, { id: '3', speakerName: name, styleName: ' 通常 ' }, { id: '3', speakerName: 'wrong' }, { id: '4', name: 'unknown / style' }]);
  assert.deepEqual(list, [{ id: '3', name: name + ' / 通常', speakerName: name, styleName: '通常' }, { id: '4', name: '音声名未取得 (ID: 4)', speakerName: '', styleName: '' }]);
  assert.equal(validLocalVoiceId('coeiroink', '-'.repeat(36) + ':0'), false);
  assert.equal(validLocalVoiceId('coeiroink', uuid + ':0'), true);
  assert.equal(validLocalVoiceId('voicevox', 3), false);
  assert.deepEqual(normalizeLocalVoices('browser', voices), []);
});

test('played and queued credit snapshots survive refreshed metadata until the display is cleared', () => {
  const preference = { engine: 'voicevox', voicevox: '3' };
  const captured = speechCredit(preference.engine, preference.voicevox, voices);
  const refreshed = [{ id: '3', speakerName: '更新された名前', styleName: '通常' }];
  assert.deepEqual(speechDisplayCredits(preference, refreshed, { credit: captured }, captured), { preview: captured, stage: captured });
  assert.deepEqual(speechDisplayCredits(preference, null, { credit: captured }, captured), { preview: captured, stage: captured });
  assert.deepEqual(speechDisplayCredits(preference, refreshed), { preview: 'VOICEVOX:更新された名前', stage: 'VOICEVOX:更新された名前' });
  assert.deepEqual(speechDisplayCredits(preference, refreshed, { credit: '' }, ''), { preview: '', stage: '' });
  assert.deepEqual(speechDisplayCredits({ engine: 'browser' }, voices), { preview: '', stage: '' });
});

test('platform selections and existing backups retain IDs but never persist cached credit metadata', () => {
  const values = new Map([['pokome-speech-engines', JSON.stringify({ twitch: { engine: 'voicevox', voicevox: '3', speakerName: 'stale' }, kick: { engine: 'coeiroink', coeiroink: uuid + ':0' } })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const normalized = readSpeechEngines(storage);
  assert.equal(Object.hasOwn(normalized.twitch, 'speakerName'), false);
  storage.setItem('pokome-speech-engines', JSON.stringify(normalized));
  const backup = JSON.stringify(exportSettings(storage));
  assert.doesNotMatch(backup, /speakerName|ずんだもん|credit/);
  restoreSettings(storage, parseSettings(backup));
  assert.deepEqual(readSpeechEngines(storage), normalized);
  assert.equal(speechDisplayCredits(normalized.twitch, voices).stage, 'VOICEVOX:ずんだもん');
  assert.equal(speechDisplayCredits(normalized.kick, [{ id: uuid + ':0', speakerName: 'つくよみちゃん' }]).stage, 'COEIROINK:つくよみちゃん');
  assert.equal(speechDisplayCredits(readSpeechEngines(storage, false).twitch, voices).stage, '');
});
