import { normalizeConnections } from './connections.js';
import { normalizeSpeechEngines } from './speech-engine.js';
import { normalizeHistoryLimit, normalizeVoices } from './studio.js';
import { normalizeSpeechOptions, normalizeAutoSpeech } from './speech-options.js';
import { normalizeOutputPreferences } from './output-protocol.js';

export const MAX_SETTINGS_BYTES = 12 * 1024 * 1024;
export const SETTINGS_FIELDS = Object.freeze(['connections', 'autoSpeech', 'voices', 'speechEngines',
  'speechOptions', 'users', 'historyLimit', 'setupComplete', 'output']);
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function normalizeUsers(value) {
  return Object.fromEntries(['twitch', 'kick'].map(platform => [platform,
    Object.fromEntries(Object.entries(record(value?.[platform])).flatMap(([user, rule]) => {
      if (!user || user.length > 200) return [];
      const flags = { hidden: rule?.hidden === true, muted: rule?.muted === true };
      return [[user, flags]];
    }))]));
}

// Appearance and metadata never enter this document; sharing a design must
// not disclose the connection or user settings stored beside the app.
export function normalizeSettings(value) {
  const source = record(value);
  const output = normalizeOutputPreferences(source.output);
  return {
    connections: normalizeConnections(source.connections), autoSpeech: normalizeAutoSpeech(source.autoSpeech),
    voices: normalizeVoices(source.voices), speechEngines: normalizeSpeechEngines(source.speechEngines),
    speechOptions: Object.fromEntries(['twitch', 'kick'].map(platform => [platform, normalizeSpeechOptions(source.speechOptions?.[platform])])),
    users: normalizeUsers(source.users), historyLimit: normalizeHistoryLimit(source.historyLimit),
    setupComplete: source.setupComplete === true, output: { background: output.background, key: output.key },
  };
}

export const settingsDocument = settings => ({ format: 'pokome-settings', version: 2, settings: normalizeSettings(settings) });
