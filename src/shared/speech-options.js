export const DEFAULT_SPEECH_OPTIONS = Object.freeze({
  maxLength: 100, skipUrls: true, skipDuplicates: true, skipCommands: false, userInterval: 0,
  skipNightbot: true, skipBroadcaster: true,
});

export function normalizeSpeechOptions(value = {}) {
  const options = { ...DEFAULT_SPEECH_OPTIONS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return options;
  for (const key of ['skipUrls', 'skipDuplicates', 'skipCommands', 'skipNightbot', 'skipBroadcaster']) {
    if (typeof value[key] === 'boolean') options[key] = value[key];
  }
  if (Number.isInteger(value.maxLength) && value.maxLength >= 10 && value.maxLength <= 500) options.maxLength = value.maxLength;
  if (Number.isInteger(value.userInterval) && value.userInterval >= 0 && value.userInterval <= 60) options.userInterval = value.userInterval;
  return options;
}

export function normalizeAutoSpeech(saved) {
  return Object.fromEntries(['twitch', 'kick'].map(platform => [platform,
    typeof saved?.[platform] === 'boolean' ? saved[platform] : true]));
}
