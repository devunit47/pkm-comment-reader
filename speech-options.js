export const DEFAULT_SPEECH_OPTIONS = Object.freeze({
  maxLength: 100, skipUrls: true, skipDuplicates: true, skipCommands: false, userInterval: 0,
  skipNightbot: true, skipBroadcaster: true,
});

export function normalizeSpeechOptions(value = {}) {
  const options = { ...DEFAULT_SPEECH_OPTIONS };
  if (!value || typeof value !== 'object') return options;
  for (const key of ['skipUrls', 'skipDuplicates', 'skipCommands', 'skipNightbot', 'skipBroadcaster']) {
    if (typeof value[key] === 'boolean') options[key] = value[key];
  }
  if (Number.isInteger(value.maxLength) && value.maxLength >= 10 && value.maxLength <= 500) options.maxLength = value.maxLength;
  if (Number.isInteger(value.userInterval) && value.userInterval >= 0 && value.userInterval <= 60) options.userInterval = value.userInterval;
  return options;
}

export function isSpeechUserExcluded(message, channel, options) {
  const login = (message.login || message.user).toLowerCase();
  return (options.skipNightbot && login === 'nightbot') ||
    (options.skipBroadcaster && !!channel && login === channel.toLowerCase());
}

export function readSavedAutoSpeech(storage) {
  const result = { twitch: true, kick: true };
  try {
    const saved = JSON.parse(storage?.getItem('pokome-auto-speech') || '{}');
    for (const platform of Object.keys(result)) {
      if (typeof saved?.[platform] === 'boolean') result[platform] = saved[platform];
    }
  } catch { /* Missing or invalid settings retain the enabled default. */ }
  return result;
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
export function prepareSpeechText(text, options, platform) {
  if (typeof text !== 'string') return '';
  if (platform === 'kick') text = text.replace(/\[emote:[^\]\r\n]*\]/giu, ' ');
  if (options.skipCommands && /^[!/]/u.test(text.trimStart())) return '';
  if (options.skipUrls) {
    text = text.replace(/(?:https?:\/\/|www\.)[^\s<>「」『』（）、。！？]+/giu,
      url => url.match(/[.,!?;:)\]}]+$/u)?.[0] || '');
  }
  text = text.replace(/\s+/gu, ' ').trim();
  // URL-only comments must not become a spoken username or punctuation.
  if (!/[\p{L}\p{N}\p{S}]/u.test(text)) return '';
  return Array.from(segmenter.segment(text), part => part.segment).slice(0, options.maxLength).join('');
}

export function createSpeechHistory() {
  return { users: new Map() };
}

export function shouldAutoRead(history, user, text, options, now = Date.now()) {
  if (!text) return false;
  const previous = history.users.get(user);
  if (!previous) return true;
  if (options.userInterval > 0 && now - previous.time < options.userInterval * 1000) return false;
  return !options.skipDuplicates || previous.text !== text || now - previous.time >= 30000;
}

export function rememberAutoRead(history, user, text, now = Date.now()) {
  history.users.delete(user);
  history.users.set(user, { text, time: now });
  if (history.users.size > 300) history.users.delete(history.users.keys().next().value);
}
