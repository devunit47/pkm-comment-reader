import { normalizeCommentContent } from '../shared/comment-model.js';
import { normalizeAutoSpeech } from '../shared/speech-options.js';
export { DEFAULT_SPEECH_OPTIONS, normalizeSpeechOptions } from '../shared/speech-options.js';

export function isSpeechUserExcluded(message, channel, options) {
  const login = (message.login || message.user).toLowerCase();
  return (options.skipNightbot && login === 'nightbot') ||
    (options.skipBroadcaster && !!channel && login === channel.toLowerCase());
}

export function readSavedAutoSpeech(settings) {
  return normalizeAutoSpeech(settings?.autoSpeech);
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
export function prepareSpeechText(text, options, platform, parts) {
  if (typeof text !== 'string') return '';
  if (platform === 'twitch' && parts) text = normalizeCommentContent({ text, parts }).parts.map(part => part.type === 'text' ? part.text : ' ').join('');
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
