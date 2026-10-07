export const COMMENT_LIMIT = 2000;
export const EMOTE_LIMIT = 100;
export const TWITCH_ROLES = Object.freeze(['broadcaster', 'moderator', 'vip', 'subscriber']);
export const validEmoteId = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value);
export const normalizeNameColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '';
export const normalizeBadges = value => TWITCH_ROLES.filter(role => Array.isArray(value) && value.includes(role));

function appendText(parts, text) {
  if (!text) return;
  if (parts.at(-1)?.type === 'text') parts.at(-1).text += text;
  else parts.push({ type: 'text', text });
}

export function parseTwitchEmotes(text, tag = '') {
  const points = Array.from(text), ranges = [];
  for (const group of tag.split('/')) {
    const [id, positions] = group.split(':');
    if (!validEmoteId(id) || !positions) continue;
    for (const position of positions.split(',')) {
      if (!/^\d+-\d+$/.test(position)) continue;
      const [start, end] = position.split('-').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= points.length) continue;
      ranges.push({ id, start, end, name: points.slice(start, end + 1).join('') });
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  // Ambiguous overlaps and names for the same ID remain ordinary text.
  const names = new Map(), mismatched = new Set();
  for (const range of ranges) {
    if (names.has(range.id) && names.get(range.id) !== range.name) mismatched.add(range.id);
    names.set(range.id, range.name);
  }
  let furthest = -1, previous;
  for (const range of ranges) {
    if (range.start <= furthest) { range.overlap = true; previous.overlap = true; }
    if (range.end > furthest) { furthest = range.end; previous = range; }
  }
  const parts = [];
  let cursor = 0, count = 0;
  for (const range of ranges) {
    if (range.overlap || mismatched.has(range.id) || count >= EMOTE_LIMIT) continue;
    appendText(parts, points.slice(cursor, range.start).join(''));
    parts.push({ type: 'emote', id: range.id, name: range.name });
    cursor = range.end + 1; count++;
  }
  appendText(parts, points.slice(cursor).join(''));
  return parts;
}

export function normalizeCommentContent(value) {
  const body = typeof value?.text === 'string' ? value.text : '';
  let source = value?.parts;
  // Parts must account for the original body; metadata cannot replace it.
  if (!Array.isArray(source) || source.length > EMOTE_LIMIT * 2 + 1 || source.some(part => !part ||
      (part.type !== 'text' && part.type !== 'emote') || typeof (part.type === 'text' ? part.text : part.name) !== 'string') ||
      source.map(part => part.type === 'text' ? part.text : part.name).join('') !== body) {
    source = [{ type: 'text', text: body }];
  }
  const parts = [];
  let remaining = COMMENT_LIMIT, emotes = 0;
  for (const part of source) {
    const points = Array.from(part.type === 'text' ? part.text : part.name);
    const isEmote = part.type === 'emote' && validEmoteId(part.id) && points.length > 0 && emotes < EMOTE_LIMIT;
    // An emote crossing the boundary is dropped whole, never split into text.
    if (isEmote && points.length > remaining) break;
    if (isEmote) { parts.push({ type: 'emote', id: part.id, name: part.name }); emotes++; }
    else appendText(parts, points.slice(0, remaining).join(''));
    remaining -= Math.min(points.length, remaining);
    if (!remaining) break;
  }
  return { text: parts.map(part => part.type === 'text' ? part.text : part.name).join(''), parts,
    color: normalizeNameColor(value?.color), badges: normalizeBadges(value?.badges) };
}
